// Reachability is separate from message outcomes: no failed task does not mean a
// working orchestrator. Keep the last observation so a stopped waker becomes stale.
import { PREFIX, text } from "./store.ts";
import type { Executor } from "./valkey.ts";

export const HEALTH_KEY = `${PREFIX}health:orchestrator`;
export const HEALTH_INTERVAL_MS = 30_000;
export const HEALTH_STALE_MS = 90_000;

export interface OrchestratorHealth {
  status: "healthy" | "unavailable" | "unknown";
  reason: string;
  thread_id?: string;
  checked_ms?: number;
  thread_status?: string;
  detail?: string;
}

export async function writeHealth(exec: Executor, observation: OrchestratorHealth): Promise<void> {
  await exec.execute(["SET", HEALTH_KEY, JSON.stringify(observation)]);
}

export async function readHealth(exec: Executor, now = Date.now()): Promise<OrchestratorHealth> {
  const raw = await exec.execute(["GET", HEALTH_KEY]);
  if (raw === null) return { status: "unknown", reason: "not_observed" };
  let h: OrchestratorHealth;
  try {
    h = JSON.parse(text(raw));
  } catch {
    return { status: "unknown", reason: "invalid_observation" };
  }
  if (!h || !["healthy", "unavailable"].includes(h.status) || !h.thread_id
      || !Number.isSafeInteger(h.checked_ms) || typeof h.reason !== "string") {
    return { status: "unknown", reason: "invalid_observation" };
  }
  if (now < h.checked_ms! || now - h.checked_ms! > HEALTH_STALE_MS) {
    return { ...h, status: "unknown", reason: "stale_observation" };
  }
  return h;
}
