// Routing policy: which events this session is allowed to be woken by.
//
// A session subscribes to streams and, within each, to event types and
// subject values. Anything outside the policy is acknowledged and audited as
// `skipped`, never delivered: a Claude session must not be woken for an
// account or a repository it does not own, even if the producer and the
// stream share it. Deny by default -- an empty route list delivers nothing.
//
// Ported from events/mctl_events/policy.py; the policy.json format is the same.
import { readFileSync } from "node:fs";
import { fnmatchcase } from "./fnmatch.js";
import { compareCodePoints, isObject, pyListRepr } from "./util.js";
const STREAM = /^mctl:events:[a-z0-9][a-z0-9_-]{0,62}$/;
const STREAM_PATTERN = "^mctl:events:[a-z0-9][a-z0-9_-]{0,62}$";
// Streams the adapter itself writes to. Subscribing to one would feed the
// adapter its own output: every audit entry has no envelope, so each would be
// rejected and audited again, forever.
export const RESERVED_STREAMS = new Set(["mctl:events:audit", "mctl:events:state"]);
const NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const NAME_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$";
export class PolicyError extends Error {
    name = "PolicyError";
}
export class Route {
    stream;
    sources;
    types;
    subject;
    constructor(stream, sources, types, subject = {}) {
        this.stream = stream;
        this.sources = sources;
        this.types = types;
        this.subject = subject;
    }
    matches(stream, envelope) {
        if (stream !== this.stream || !this.sources.includes(envelope.source))
            return false;
        if (!this.types.some((pattern) => fnmatchcase(envelope.type, pattern)))
            return false;
        for (const [key, patterns] of Object.entries(this.subject)) {
            const value = Object.hasOwn(envelope.subject, key) ? envelope.subject[key] : undefined;
            if (value === undefined || !patterns.some((p) => fnmatchcase(value, p)))
                return false;
        }
        return true;
    }
}
export function routeFor(policy, stream, envelope) {
    return policy.routes.find((route) => route.matches(stream, envelope));
}
function strings(value, where) {
    if (!Array.isArray(value) || !value.length || !value.every((v) => typeof v === "string" && v)) {
        throw new PolicyError(`${where} must be a non-empty list of strings`);
    }
    return [...value];
}
function positive(doc, key, fallback) {
    const value = Object.hasOwn(doc, key) ? doc[key] : fallback;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        throw new PolicyError(`${key} must be a positive integer`);
    }
    return value;
}
function groupStart(value) {
    if (value !== "$" && value !== "0")
        throw new PolicyError('group_start must be "$" or "0"');
    return value;
}
const ALLOWED = new Set([
    "group", "consumer", "routes", "max_inflight", "block_ms", "group_start",
    "dedup_ttl_seconds", "reclaim_min_idle_ms", "max_attempts", "startup_grace_ms",
]);
const ROUTE_KEYS = new Set(["stream", "sources", "types", "subject"]);
export function fromDict(doc) {
    if (!isObject(doc))
        throw new PolicyError("policy must be an object");
    // Only knobs this adapter honours: accepting any other field would let an
    // operator believe a setting is in effect when nothing reads it.
    const unknown = Object.keys(doc).filter((k) => !ALLOWED.has(k)).sort(compareCodePoints);
    if (unknown.length)
        throw new PolicyError(`unknown policy fields: ${pyListRepr(unknown)}`);
    for (const key of ["group", "consumer"]) {
        const value = doc[key];
        if (typeof value !== "string" || !NAME.test(value))
            throw new PolicyError(`${key} must match ${NAME_PATTERN}`);
    }
    const routesDoc = doc.routes;
    if (!Array.isArray(routesDoc))
        throw new PolicyError("routes must be a list");
    const routes = [];
    routesDoc.forEach((item, index) => {
        const where = `routes[${index}]`;
        if (!isObject(item) || Object.keys(item).some((k) => !ROUTE_KEYS.has(k))) {
            throw new PolicyError(`${where} must be an object with stream, sources, types and optional subject`);
        }
        const stream = item.stream;
        if (typeof stream !== "string" || !STREAM.test(stream)) {
            throw new PolicyError(`${where}.stream must match ${STREAM_PATTERN}`);
        }
        if (RESERVED_STREAMS.has(stream)) {
            throw new PolicyError(`${where}.stream ${stream} is reserved for the adapter's own output`);
        }
        const subjectDoc = Object.hasOwn(item, "subject") ? item.subject : {};
        if (!isObject(subjectDoc))
            throw new PolicyError(`${where}.subject must be an object`);
        const sources = strings(item.sources, `${where}.sources`);
        const types = strings(item.types, `${where}.types`);
        const subject = {};
        for (const key of Object.keys(subjectDoc).sort(compareCodePoints)) {
            subject[key] = strings(subjectDoc[key], `${where}.subject.${key}`);
        }
        routes.push(new Route(stream, sources, types, subject));
    });
    const policy = {
        group: doc.group,
        consumer: doc.consumer,
        routes,
        max_inflight: positive(doc, "max_inflight", 5),
        block_ms: positive(doc, "block_ms", 5000),
        group_start: groupStart(Object.hasOwn(doc, "group_start") ? doc.group_start : "$"),
        dedup_ttl_seconds: positive(doc, "dedup_ttl_seconds", 86400),
        reclaim_min_idle_ms: positive(doc, "reclaim_min_idle_ms", 300000),
        max_attempts: positive(doc, "max_attempts", 5),
        startup_grace_ms: positive(doc, "startup_grace_ms", 3000),
        streams: [...new Set(routes.map((route) => route.stream))].sort(compareCodePoints),
    };
    return Object.freeze(policy);
}
export function load(path) {
    return fromDict(JSON.parse(readFileSync(path, "utf8")));
}
