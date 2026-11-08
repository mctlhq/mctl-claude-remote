#!/usr/bin/env python3
"""Mutation check for the bridge's guarantees.

Each entry reverts one guarantee in src/bridge.lua (or the durable test
profile) and runs `bun test`; every mutation must make at least one test fail.
Run from plugin/mctl-bridge:  python3 test/mutate.py [name ...]

Sharding (CI runs 8 jobs in parallel):
  python3 test/mutate.py --shard I/N        run shard I of N (1-based)
  python3 test/mutate.py --list-shard I/N   print the names in that shard
The partition is round-robin over the full list by index (index % N == I-1),
so it is a pure function of the list. Every shard still validates the patterns
of the WHOLE list before touching a file and runs the FULL `bun test --bail` per
mutation: the run stops at the first failing test, which is all a kill needs, and
a survivor still goes through every test. A shard fails if a mutation survived, a run crashed or timed out, an
empty shard was requested, or it ran a different number of mutations than its
partition says. test/test_shards.py proves the partition is exact.
"""
import subprocess, sys, shutil
LUA='src/bridge.lua'; SUP='test/support.ts'; CH='src/channel.ts'; WK='src/waker.ts'; CLI='src/cli.ts'; SLOT='ops/slot.sh'; GUARD='ops/codex-remote-guard.sh'; WAKE='ops/wake-state.sh'; UPD='ops/bridge-updater.sh'; INSTALL='ops/install.sh'; PTY='ops/slot-pty.py'; WATCH='ops/watch.sh'
CX='src/codexctl.ts'; PB='src/publish.ts'; RC='src/reconcile.ts'; AP='src/appserver.ts'
M=[
 ("reconcile treats unreadable as no prompt", RC, 'this.note("reconcile slot unreadable", {', 'this.waiting.delete(slot); this.note("reconcile slot unreadable", {', 1),
 ("reconcile logs an unreadable slot every pass", RC, 'if (!this.unreadable.has(slot)) {', 'if (true) {', 1),
 ("reconcile restarts the clock on a repeat", RC, 'if (held?.hash === hash) {', 'if (false) {', 1),
 ("reconcile repeats a waiting prompt every pass", RC, 'if (now - held.lastNote >= this.cfg.waitingEveryMs) {', 'if (true) {', 1),
 ("reconcile logs prompt text", RC, 'this.note("reconcile prompt seen", { slot, hash, kind: st.prompt.kind });', 'this.note("reconcile prompt seen", { slot, hash, kind: st.prompt.kind, prompt: st.prompt });', 1),
 ("reconcile takes a missing field as no prompt", RC, 'if (typeof d.prompt_pending !== "boolean") throw new StateUnreadable("no prompt_pending field");', '', 1),
 ("reconcile takes bad JSON as no prompt", RC, 'throw new StateUnreadable(`not JSON: ${raw.slice(0, 80)}`);', 'return { alive: true, prompt: null };', 1),
 ("reconcile ignores the exit status of slot.sh", RC, 'if (code !== 0) throw new StateUnreadable(', 'if (false) throw new StateUnreadable(', 1),
 ("reconcile never kills a hung reader", RC, 'const killer = setTimeout(() => p.kill(), timeoutMs);', 'const killer = setTimeout(() => {}, timeoutMs);', 1),
 ("reconcile forgets its cursor", RC, 'if (page.length > 0) await this.bridge.setReconcileCursor(cursor);', '', 1),
 ("reconcile stops at the first page", RC, 'if (page.length < RESULT_PAGE) return;', 'return;', 1),
 ("reconcile lets a slot failure stop the pass", RC, 'if (!this.unreadable.has(slot)) {', 'throw err; if (!this.unreadable.has(slot)) {', 1),
 ("publish git keeps the keychain helper", PB, '["-c", "credential.helper=", "-c", "core.hooksPath=/dev/null"', '["-c", "core.hooksPath=/dev/null"', 1),
 ("publish follows a symlink", PB, "fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK", "fs.constants.O_RDONLY | fs.constants.O_NONBLOCK", 1),
 ("publish skips the bundle hash", PB, 'if (actual !== m.sha256) throw new Refused("sha256_mismatch", `the bundle is ${actual}`);', '', 1),
 ("publish skips the manifest repo", PB, 'if (m.repo !== o.repo) throw new Refused("wrong_repo", `the manifest says ${m.repo}`);', '', 1),
 ("publish skips the allow list", PB, 'if (outside.length) throw new Refused("outside_allowed_files", outside.join(", "));', '', 1),
 ("publish skips the workflow gate", PB, 'if (workflows.length) throw new Refused("workflow_change", `owner gate: ${workflows.join(", ")}`);', '', 1),
 ("publish believes the file list", PB, 'if (JSON.stringify(real) !== JSON.stringify(claimed)) throw new Refused("files_mismatch", `the commits change ${real.join(", ")}`);', '', 1),
 ("publish allows symlinks", PB, 'if (special.length) throw new Refused("special_file", special.map((r) => r.path).join(", "));', '', 1),
 ("publish overwrites a branch", PB, 'if (present !== null && present !== m.head_sha) throw new Refused("branch_taken", `${m.branch} is at ${present}`);', '', 1),
 ('publish update ignores the expected head', PB, 'if (present !== from && present !== m.head_sha) throw new Refused("branch_moved"', 'if (false) throw new Refused("branch_moved"', 1),
 ('publish update skips the fast-forward check', PB, 'if (git.run("merge-base", "--is-ancestor", from, m.head_sha).code !== 0) throw new Refused("not_fast_forward"', 'if (false) throw new Refused("not_fast_forward"', 1),
 ('publish update takes any PR author', PB, 'if (author !== `${slug}[bot]` || pr?.user?.type !== "Bot") throw', 'if (false) throw', 1),
 ('publish update trusts a bot-looking login', PB, ' || pr?.user?.type !== "Bot") throw', ') throw', 1),
 ('publish update takes a fork PR', PB, 'if (pr?.head?.repo?.full_name !== o.repo) throw', 'if (false) throw', 1),
 ('publish update takes any base', PB, 'if (pr?.base?.ref !== "main") throw', 'if (false) throw', 1),
 ('publish update ignores the PR head', PB, 'if (prHead !== from && !(present === m.head_sha && prHead === m.head_sha)) throw', 'if (false) throw', 1),
 ('publish update takes the first of several PRs', PB, 'if (open.length > 1) throw', 'if (false) throw', 1),
 ('publish update pushes without a PR', PB, 'if (open.length === 0) throw', 'if (false) throw', 1),
 ('publish update creates a missing branch', PB, 'if (present === null) throw new Refused("no_branch"', 'if (false) throw new Refused("no_branch"', 1),
 ("update-branch takes any PR author", PB, 'if (author !== `${slug}[bot]` || p?.user?.type !== "Bot") throw new Refused("not_own_pr"', 'if (false) throw new Refused("not_own_pr"', 1),
 ("update-branch takes a fork branch", PB, 'if (p?.head?.repo?.full_name !== repo) throw new Refused("not_own_pr"', 'if (false) throw new Refused("not_own_pr"', 1),
 ("update-branch is not pinned to the head", PB, '{ expected_head_sha: head }', '{}', 1),
 ("update-branch updates a branch that is not behind", PB, 'if (cmp.behind_by === 0) return { ok: true, pr, head, already: true };', '', 1),
 ("update-branch reads a missing compare as current", PB, 'if (typeof cmp?.behind_by !== "number") throw new Unreadable("compare returned no behind_by");', '', 1),
 ("update-branch calls a lost reply a refusal", PB, 'if (err instanceof TransportError) throw new OutcomeUnknown(err.message);\n    throw err;\n  }\n  if (r.status >= 500) throw new OutcomeUnknown(`update-branch', 'throw err;\n  }\n  if (r.status >= 500) throw new OutcomeUnknown(`update-branch', 1),
 ("update-branch reads an unreadable author as someone else", PB, 'if (!author || typeof author !== "string") throw new Unreadable', 'if (false) throw new Unreadable', 1),
 ("update-branch takes a refusal as accepted", PB, 'if (r.status !== 202) throw new Refused("update_refused"', 'if (false) throw new Refused("update_refused"', 1),
 ("update-branch on a closed PR", PB, 'if (p.state !== "open" || p.merged === true) throw new Refused("not_open", String(p.state));\n  if (p.base?.ref !== "main") throw new Refused("wrong_base", String(p.base?.ref));\n  const slug', 'const slug', 1),
 ('publish update not wired', PB, 'if (o.updateFrom !== undefined) return await update(', 'if (false) return await update(', 1),
 ('publish update-from accepts a short sha', PB, 'if (updateFrom !== undefined && !SHA.test(updateFrom)) throw', 'if (false) throw', 1),
 ('publish update-from flag dropped', PB, '          updateFrom,\n', '', 1),
 ('publish update resumed run takes any PR head', PB, ' && !(present === m.head_sha && prHead === m.head_sha)) throw', ') throw', 1),
 ('publish update resumed run accepts a moved PR', PB, 'if (prHead !== from && !(present === m.head_sha && prHead === m.head_sha)) throw', 'if (prHead !== from && present !== m.head_sha) throw', 1),
 ('publish update resumed run skips the ancestry check', PB, 'if (git.run("merge-base", "--is-ancestor", from, m.head_sha).code !== 0)', 'if (present !== m.head_sha && git.run("merge-base", "--is-ancestor", from, m.head_sha).code !== 0)', 1),
 ('publish update unreadable slug is permission', PB, 'if (typeof slug !== "string" || slug === "") throw new Unreadable', 'if (false) throw new Unreadable', 1),
 ('publish update unreadable author is permission', PB, 'if (typeof author !== "string") throw new Unreadable', 'if (false) throw new Unreadable', 1),
 ("publish body follows a symlink", PB, 'readUntrusted(need(a, "--body-file"), MAX_BODY_BYTES).toString("utf8")', 'fs.readFileSync(need(a, "--body-file"), "utf8")', 1),
 ("publish body has no limit", PB, 'readUntrusted(need(a, "--body-file"), MAX_BODY_BYTES)', 'readUntrusted(need(a, "--body-file"), MAX_BUNDLE_BYTES)', 1),
 ("publish follows a planted directory", PB, '  refusePlantedLinks(file);\n', '', 1),
 ("publish takes merge commits", PB, 'if (merges.length) throw new Refused("merge_commit", merges[0]!);', '', 1),
 ("publish checks only the final tree", PB, 'const touched = commits.flatMap((c) => parseRaw(git.must("diff", "--raw", "--no-abbrev", "--no-renames", "-z", `${c}^`, c)));', 'const touched = raw;', 1),
 ("merge takes a partial status list", PB, 'if (combined.statuses.length !== combined.total_count) throw new Unreadable(', 'if (false) throw new Unreadable(', 1),
 ("merge trusts the first PR read", PB, 'const last = await readPr(gh, repo, pr, head);', 'const last = p;', 1),
 ("publish skips the base check", PB, 'if (git.run("merge-base", "--is-ancestor", m.base_sha, "refs/remotes/origin/main").code !== 0) throw new Refused("base_not_on_main", m.base_sha);', '', 1),
 ("publish ignores the ledger", PB, 'if (prior.state === "done") return', 'if (prior.state === "never") return', 1),
 ("publish opens a non-draft", PB, 'base: "main", draft: true }', 'base: "main", draft: false }', 1),
 ("publish leaves bundle refs", PB, 'if (line) git.run("update-ref", "-d", line);', '', 1),
 ("publish repo list open", PB, 'if (!cfg.repos.includes(repo)) throw new Refused("repo_not_allowed", repo);', '', 1),
 ("merge accepts a stale approval", PB, 'claude.state !== "APPROVED" || claude.commit_id !== head', 'claude.state !== "APPROVED"', 1),
 ("merge accepts anyone's approval", PB, 'const claude = latest.get(REVIEW_BOT);', 'const claude = [...latest.values()][0];', 1),
 ("merge ignores change requests", PB, 'for (const [who, r] of latest) if (r.state === "CHANGES_REQUESTED") throw new Refused("changes_requested", who);', '', 1),
 ("merge counts a comment as a verdict", PB, 'if (r?.state === "COMMENTED" || r?.state === "PENDING") continue;', '', 1),
 ("merge ignores a running check", PB, 'if (c?.status !== "completed") throw new Refused("checks_pending", String(c?.name));', '', 1),
 ("merge ignores a failed check", PB, 'if (!PASSING.has(c?.conclusion)) throw new Refused("checks_failed", `${c?.name}: ${c?.conclusion}`);', '', 1),
 ("merge ignores statuses", PB, 'for (const s of combined.statuses) if (s?.state !== "success") throw new Refused("checks_failed", `${s?.context}: ${s?.state}`);', '', 1),
 ("merge does not need the required checks", PB, 'for (const name of required) if (!seen.has(name)) throw new Refused("checks_pending", `${name} has not passed on this head`);', '', 1),
 ("merge takes a repository with no required check", PB, 'if (required.size === 0) throw new Refused("no_required_checks", `${repo} requires no check on main`);', '', 1),
 ("required checks ignore commit statuses", PB, '...combined.statuses.map((s: any) => s.context)]', ']', 1),
 ("required checks ignore rulesets", PB, 'for (const c of list) add(c?.context);', '', 1),
 ("required checks ignore classic protection", PB, 'for (const c of classic.contexts) add(c);', '', 1),
 ("a rule with no list reads as no checks", PB, 'if (!Array.isArray(list)) throw new Unreadable("a required_status_checks rule has no list");', 'if (!Array.isArray(list)) continue;', 1),
 ("a nameless required check passes", PB, 'if (typeof context !== "string" || context === "") throw new Unreadable("a required check has no name");', '', 1),
 ("an unknown protected value reads as unprotected", PB, 'if (branch?.protected !== true) throw new Unreadable("the branch does not say whether it is protected");', 'if (branch?.protected !== true) return out;', 1),
 ("an unprotected branch still reads protection", PB, 'if (branch?.protected === false) return out;', '', 1),
 ("disabled classic protection still counts", PB, 'if (enabled === false) return out;', 'if (enabled === false) { for (const c of branch.protection.required_status_checks.contexts) add(c); return out; }', 1),
 ("an unknown enabled value reads as disabled", PB, 'if (enabled !== true) throw new Unreadable("the branch does not say whether protection is enabled");', 'if (enabled !== true) return out;', 1),
 ("a missing enforcement level reads as off", PB, 'if (typeof classic?.enforcement_level !== "string") throw new Unreadable("classic protection has no enforcement level");', 'if (typeof classic?.enforcement_level !== "string") return out;', 1),
 ("enforcement off still counts", PB, 'if (classic.enforcement_level === "off") return out;', '', 1),
 ("a missing classic list reads as empty", PB, 'if (!Array.isArray(classic.contexts)) throw new Unreadable("classic protection has no list of checks");', 'if (!Array.isArray(classic.contexts)) return out;', 1),
 ("merge counts a superseded cancel", PB, 'const runs = withoutSuperseded(await gh.list(`/repos/${repo}/commits/${head}/check-runs`, "check_runs"));', 'const runs = await gh.list(`/repos/${repo}/commits/${head}/check-runs`, "check_runs");', 1),
 ("a newer success hides a failure", PB, 'c.conclusion === "cancelled" && c.id < newest', 'c.id < newest', 1),
 ("a lone cancel is dropped", PB, 'c.id < newest.get(key(c))!', 'c.id <= newest.get(key(c))!', 1),
 ("any run replaces a cancel", PB, 'c.id < newest.get(key(c))!', 'c.id !== newest.get(key(c))! || runs.length > 3', 1),
 ("another app's run replaces a cancel", PB, 'const key = (c: any) => `${String(c?.app?.id)}/${String(c?.name)}`;', 'const key = (c: any) => String(c?.name);', 1),
 ("a run with no id is accepted", PB, 'if (typeof c?.id !== "number") throw new Unreadable("a check run has no id");', '', 1),
 ("merge takes null mergeable", PB, 'if (last.mergeable !== true || last.mergeable_state !== "clean") throw', 'if (last.mergeable === false || last.mergeable_state !== "clean") throw', 1),
 ("merge takes a moved head", PB, 'if (p.head.sha !== head) throw new Refused("head_moved", `the head is ${p.head.sha}`);', '', 1),
 ("merge is not pinned", PB, '{ merge_method: "merge", sha: head }', '{ merge_method: "merge" }', 1),
 ("merge takes a draft", PB, 'if (p.draft === true) throw new Refused("draft", `PR ${pr} is a draft`);', '', 1),
 ("list takes a failed page as the end", PB, 'if (r.status !== 200) throw new Unreadable(`GET ${url}: status ${r.status}`);\n      const page', 'if (r.status !== 200) return out;\n      const page', 1),
 ("list ignores total_count", PB, 'throw new Unreadable(`GET ${url}: ${out.length} of ${r.data.total_count} entries`);', '', 1),
 ("publish CLI has an unknown flag fallback", PB, 'if (!valued.includes(a) && !repeated.includes(a)) throw new UsageError(`unknown argument ${a}`);', '', 1),
 ("codex log does not redact", CX, "return [...turns].reverse().flatMap(turnMessages).map(shown);", "return [...turns].reverse().flatMap(turnMessages);", 1),
 ("codex questions do not redact", CX, "const shown = (m: Message): Message => ({ ...m, text: redact(m.text) });", "const shown = (m: Message): Message => m;", 1),
 ("codex wait reply is not redacted", CX, '.map((m) => redact(m.text)) };', '.map((m) => m.text) };', 1),
 ("codex log takes no data for empty", CX, 'if (!Array.isArray(r?.data)) throw new Unreadable("thread/turns/list returned no data");\n      turns.push(...r.data);', 'turns.push(...(r?.data ?? []));', 1),
 ("codex log keeps a turn without items", CX, 'if (typeof t?.id !== "string" || !Array.isArray(t.items)) throw new Unreadable("a turn came back without its items");', 'if (!Array.isArray(t?.items)) return [];', 1),
 ("codex questions call a full window clear", CX, "scanned_turns: turns.length, older_unknown: more };", "scanned_turns: turns.length, older_unknown: false };", 1),
 ("codex wake counts as the operator answering", CX, 'return m.role === "user" && !(m.client_id?.startsWith("w-") || m.client_id?.startsWith("lead-"));', 'return m.role === "user";', 1),
 ("codex marker matches anywhere", CX, 'm.text.split("\\n").some((l) => l.startsWith(QUESTION_MARKER))', 'm.text.includes(QUESTION_MARKER)', 1),
 ("codex say writes to a busy thread", CX, 'if (!acceptsTurn(st.status)) return { ok: false, code: "thread_not_idle", detail: [st.status, ...st.flags].join(" ") };', '', 1),
 ("codex say sends without a record", CX, 'return { ok: false, code: "send_log_unwritable", detail: String(err) };', '', 1),
 ("codex say sends a sticky override", CX, "clientUserMessageId: id,\n", "clientUserMessageId: id,\n          model: 'x',\n", 1),
 ("codex say drops the mark", CX, "body.startsWith(prefix) ? body : prefix + body", "body", 1),
 ("codex say ignores the configured prefix", CX, "const prefix = this.cfg.prefix ?? LEAD_PREFIX;", "const prefix = LEAD_PREFIX;", 1),
 ("codex say retries a lost start", CX, "        turn = await this.settle(id);\n", "        turn = await this.settle(id);\n        if (turn === null) { const c2 = await this.session(); const r2 = await c2.request('turn/start', { threadId: this.cfg.threadId, clientUserMessageId: id, input: [{ type: 'text', text: full }] }); turn = r2.turn.id; c2.close(); }\n", 1),
 ("codex reply failure reads as a failed send", CX, "        return { ...done, reply_error: err instanceof Error ? err.message : String(err) };", "        throw err;", 1),
 ("codex lost send log reads as a failed send", CX, "    } catch (err) {\n      return String(err);\n    }", "    } catch (err) {\n      throw err;\n    }", 1),
 ("codex lost connection reads as still running", CX, 'turn_status: c.isClosed ? "unknown" : "still_running"', 'turn_status: "still_running"', 1),
 ("codex empty pages loop", CX, 'if (next !== null && r.data.length === 0) throw new Unreadable("thread/turns/list returned an empty page with a cursor");', 'if (next !== null && r.data.length === 0 && Math.random() < 0.0001) throw new Unreadable("x");', 1),
 ("codex ignores a mistyped flag", CX, "else if (!bare.includes(args[i]!)) throw new UsageError(`unknown argument ${args[i]}`);", "", 1),
 ("codex say trusts any turn as settled", CX, "return hits.length === 1 ? hits[0].id : null;", "return turns[0]?.id ?? null;", 1),
 ("codex wait takes any turn's end", CX, "const status = ended.get(turn);", "const status = ended.values().next().value;", 1),
 ("codex status check ignores a missing status", CX, 'if (typeof s?.type !== "string") throw new Unreadable("thread/read returned no status");', '', 1),
 ("codex send log is world readable", CX, ', { mode: 0o600 });', ');', 1),
 ("orchestrator AGENTS drops the question marker", "ops/orchestrator-AGENTS.md", "start a line of your message with `[operator-question]`", "say so in your message", 1),
 ("orchestrator AGENTS takes handoff paths from anywhere", "ops/orchestrator-AGENTS.md", "Use them only when both lie directly in that\nslot's own directory", "Use them when they lie in a\nslot's directory", 1),
 ("orchestrator AGENTS drops the task id check on handoff paths", "ops/orchestrator-AGENTS.md", "`<task id>.bundle` and `<task id>.manifest.json` for the task the slot reported on.", "a bundle and a manifest.", 1),
 ("slot.sh gives no handoff root", SLOT, ',"MCTL_BRIDGE_HANDOFF_ROOT":$(json "$d/handoff")', '', 1),
 ("slot.sh leaves the handoff dir open", SLOT, '    as_ chmod 700 "$d/handoff"\n', '    as_ chmod 755 "$d/handoff"\n', 1),
 ("slot.sh grants the operator write on handoff", SLOT, '"$d/handoff|$op allow list,search"', '"$d/handoff|$op allow list,search,add_file,delete_child"', 1),
 ("channel takes the attempt from the model", CH, 'return this.exportHandoff(taskId, a.attempt_id);', 'return this.exportHandoff(taskId, String(args.attempt_id ?? a.attempt_id));', 1),
 ("channel accepts any origin host", CH, '(?:https:\\/\\/github\\.com\\/|git@github\\.com:|ssh:\\/\\/git@github\\.com\\/)', '(?:https:\\/\\/github\\.com[^/]*\\/|git@github\\.com:|ssh:\\/\\/git@github\\.com\\/)', 1),
 ("orchestrator AGENTS drops the steer after No", "ops/orchestrator-AGENTS.md", 'never answer "No" without a steer right after it', 'a steer can follow it', 1),
 ("orchestrator AGENTS allows the wider options", "ops/orchestrator-AGENTS.md", "  Never pick \"don't ask again\", \"auto mode\" or any other option that widens the slot's", "  You may pick any option that widens the slot's", 1),
 ("orchestrator AGENTS drops the autonomy limits", "ops/orchestrator-AGENTS.md", "Everything else in this file still holds: you never restart slots, release, tag, deploy, or widen", "Everything else in this file still holds, or", 1),
 ("orchestrator AGENTS drops the take-twice guard", "ops/orchestrator-AGENTS.md", "so an issue is never taken twice.", "if you like.", 1),
 ("orchestrator AGENTS lets the lead grant approvals", "ops/orchestrator-AGENTS.md", "It cannot grant approval for merge, deploy,", "It can grant approval for merge, deploy,", 1),
 ("fencing off", LUA, "local function fenced(s, conn, epoch)\n  return", "local function fenced(s, conn, epoch)\n  do return false end\n  return", 1),
 ("busy gate off", LUA, "if s.busy ~= '0' then return no('busy') end", "", 1),
 ("admission attempt check off", LUA, "  if m.attempt_id ~= attempt or m.emit_epoch ~= epoch or m.emit_conn ~= conn then\n    return nil, m, 'attempt_mismatch'", "  if false then\n    return nil, m, 'attempt_mismatch'", 1),
 ("admission uuid check off", LUA, "if fenced(s, conn, epoch) or s.uuid ~= uuid then return nil, m, 'fenced' end", "if fenced(s, conn, epoch) then return nil, m, 'fenced' end", 1),
 ("claim NX off", LUA, "token, 'NX', 'PX', lease", "token, 'PX', lease", 1),
 ("reply token check off", LUA, "  if redis.call('GET', P .. 'claim:' .. qid) ~= token then return no('not_owner') end\n  local m = hgetall(mkey(qid))", "  local m = hgetall(mkey(qid))", 1),
 ("steer question_open check off", LUA, "    return no('not_inflight')\n  end\n  if m.open_question and m.open_question ~= '' then", "    return no('not_inflight')\n  end\n  if false then", 1),
 ("steer acked check off", LUA, "if m.state ~= 'acked' then return no('not_acked', { state = m.state or '' }) end", "", 1),
 ("steer leaves the task's open question unset", LUA, "  redis.call('HSET', mkey(task_id), 'open_question', qid)\n", "", 1),
 ("steer not allowed for codex", "ops/codex-mctl-bridge.rules", '"reply", "steer", "send"', '"reply", "send"', 1),
 ("renew token check off", LUA, "  if redis.call('GET', P .. 'claim:' .. qid) ~= token then return no('not_owner') end\n  redis.call('PEXPIRE'", "  redis.call('PEXPIRE'", 1),
 ("inflight rule off", LUA, "      if inflight == '' then", "      if true then", 1),
 ("reply gets new attempt", LUA, "question = m.payload, task_id = m.task_id, attempt_id = m.attempt_id })", "question = m.payload, task_id = m.task_id, attempt_id = attempt })", 1),
 ("epoch change keeps emits", LUA, "      transition(id, m, 'delivery_unknown', actor, 'epoch_changed', now)\n", "", 1),
 ("epoch change keeps queued", LUA, "      transition(id, m, 'cancelled', actor, 'addressee_changed', now)\n    elseif st == 'emit_intent'", "    elseif st == 'emit_intent'", 1),
 ("live conflict off", LUA, "if alive and (s.pid ~= pid or s.pid_start ~= pid_start) then", "if false then", 1),
 ("late evidence off", LUA, "      record_late(slot, a[2], m, a, code, 'result', payload, now)\n", "", 1),
 ("repair off", LUA, "    if not redis.call('ZSCORE', ready_key(m.slot), id) then", "    if false then", 1),
 ("expire seen msgs", LUA, "  if m.kind == 'task' and m.state == 'queued' then\n    transition(id, m, 'expired'", "  if m.kind == 'task' then\n    transition(id, m, 'expired'", 1),
 ("dedup ttl at send", LUA, "redis.call('SET', P .. 'dedup:' .. idem, id)", "redis.call('SET', P .. 'dedup:' .. idem, id, 'PX', 100000)", 1),
 ("dedup retention off", LUA, "      redis.call('PEXPIRE', P .. 'dedup:' .. m.idem, RETAIN_MS)\n", "", 1),
 ("hop limit send off", LUA, "  if hop > MAX_HOP then return no('hop_limit') end\n  local s = hgetall", "  local s = hgetall", 1),
 ("hop limit ask off", LUA, "  if hop > MAX_HOP then return no('hop_limit') end\n  if redis.call('EXISTS'", "  if redis.call('EXISTS'", 1),
 ("stale sweep off", LUA, "  abandon(slot, 'sweeper', 'heartbeat_lost', now)\n", "", 1),
 ("resolve reason optional", LUA, "not valid_id(id) or reason == '' or author == '' then return no('bad_request') end\n  local m = hgetall(mkey(id))", "not valid_id(id) or author == '' then return no('bad_request') end\n  local m = hgetall(mkey(id))", 1),
 ("wake resolve reason optional", LUA, "not valid_id(id) or reason == '' or author == '' then return no('bad_request') end\n  local w = hgetall(wkey(id))", "not valid_id(id) or author == '' then return no('bad_request') end\n  local w = hgetall(wkey(id))", 1),
 ("audit off", LUA, "  audit(id, m.state, to, actor, reason, now)\n", "", 1),
 ("role key check off", LUA, "  if not valid_slot(slot) or keys[1] ~= skey(slot) then return no('bad_request') end\n  local s = hgetall(skey(slot))\n  if fenced(s, conn, epoch) then return no('fenced') end\n  redis.call('HSET', skey(slot), 'heartbeat'", "  if not valid_slot(slot) then return no('bad_request') end\n  local s = hgetall(skey(slot))\n  if fenced(s, conn, epoch) then return no('fenced') end\n  redis.call('HSET', skey(slot), 'heartbeat'", 1),
 ("task end keeps question open", LUA, "  close_question(m, 'slot:' .. slot, 'task_finished', now)\n", "", 1),
 ("resolve keeps question open", LUA, "    close_question(m, actor, 'task_resolved', now)\n", "", 1),
 ("abandon keeps questions", LUA, "      transition(id, m, 'delivery_unknown', actor, 'asker_' .. why, now)\n", "", 1),
 ("expired question silent", LUA, "  if m.kind == 'question' and m.state == 'asked' then\n    transition(id, m, 'reply_committed'", "  if false then\n    transition(id, m, 'reply_committed'", 1),
 ("requeue ignores late evidence", LUA, "if tonumber(m.late_count or '0') > 0 and not force then", "if false then", 1),
 ("late trail never expires", LUA, "    redis.call('PEXPIRE', P .. 'late:' .. id, RETAIN_MS)\n", "", 1),
 ("audit trail never expires", LUA, "    redis.call('PEXPIRE', mkey(id), RETAIN_MS)\n    redis.call('PEXPIRE', P .. 'audit:' .. id, RETAIN_MS)\n", "    redis.call('PEXPIRE', mkey(id), RETAIN_MS)\n", 1),
 ("ask ttl guard off", LUA, "      or ttl == nil or ttl < 0 then", "      then", 1),
 ("close while waiting", LUA, "      if s.inflight == m.task_id and s.inflight_attempt == m.attempt_id then\n        return no('task_waiting'", "      if false then\n        return no('task_waiting'", 1),
 ("unregister fencing off", LUA, "  -- Fencing first: an old adapter must never touch a newer registration.\n  if fenced(s, conn, epoch) then return no('fenced') end\n", "", 1),
 ("unregister keeps emits", LUA, "  abandon(slot, 'slot:' .. slot, 'unregistered', now)\n", "  redis.call('HSET', skey(slot), 'conn_id', '')\n", 1),
 ("register stale_ms guard off", LUA, "      or stale_ms == nil or stale_ms <= 0 then", "      then", 1),
 ("adapter emit hold off", CH, "if (this.emittedAt > 0 && reportedMs <= this.emittedAt && now - this.emittedAt < this.cfg.emitHoldMs) return true;", "", 1),
 ("adapter ignores /clear", CH, "if (this.conn === null || this.conn.uuid !== sessionId) await this.register(sessionId);", "if (this.conn === null) await this.register(sessionId);", 1),
 ("adapter no unregister", CH, "        await this.bridge.unregister(this.conn);\n", "", 1),
 ("adapter no ack instruction", CH, "        `First call ack_task with task_id=\"${m.id}\" and attempt_id=\"${m.attempt_id}\". Do no work on this task before it succeeds.`,\n", "", 1),
 ("adapter resets on transport error", CH, "        log(\"tick failed\", { error: err instanceof Error ? err.message : String(err) });\n", "        log(\"tick failed\", { error: err instanceof Error ? err.message : String(err) });\n        this.conn = null;\n", 1),
 ("adapter stop does not wait", CH, "    await this.current?.catch(() => undefined);\n", "", 1),
 ("adapter ignores a lost next", CH, "      // would hold inflight for good. Settle it before anything else is emitted.\n      this.emitUnsettled = true;\n", "      // would hold inflight for good. Settle it before anything else is emitted.\n", 1),
 ("adapter ignores a failed notify", CH, "      // may ack it from emit_intent, so it must not be settled.\n      this.emitUnsettled = true;\n", "      // may ack it from emit_intent, so it must not be settled.\n", 1),
 ("emit_lost keeps inflight", LUA, "      if m.kind == 'task' then clear_inflight(slot, id) end\n", "", 1),
 ("emit_lost not fenced", LUA, "  if fenced(s, conn, epoch) then return no('fenced') end\n  local now = now_ms()\n  local settled = 0\n", "  local now = now_ms()\n  local settled = 0\n", 1),
 ("waker trusts the first turn/completed", WK, "        const status = ended.get(turnId);\n", "        const status = ended.values().next().value;\n", 1),
 ("waker accepts an ambiguous history", WK, "    if (found.length !== 1) {\n", "    if (found.length === 0) {\n", 1),
 ("waker reads a broken history as empty", WK, "          throw new ConnectionLost(`thread/turns/list page ${page} returned no data`);\n", "          return out;\n", 1),
 ("waker treats a refused start as unknown", WK, "        if (err instanceof RpcError) {\n", "        if (err instanceof RpcError && false) {\n", 1),
 ("wake ignores the thread lock", LUA, "  if holder then return no('thread_busy', { wake_id = holder }) end\n", "", 1),
 ("wake ignores the hourly limit", LUA, "  if tonumber(redis.call('GET', bucket) or '0') >= per_hour then return no('rate_limited') end\n", "", 1),
 ("wake ignores the claim", LUA, "  if redis.call('EXISTS', P .. 'claim:' .. qid) == 1 then return no('claimed') end\n  local now = now_ms()\n  -- The quiet", "  local now = now_ms()\n  -- The quiet", 1),
 ("wake ignores the quiet period", LUA, "then return no('too_early') end\n", "then end\n", 1),
 ("wake again while unresolved", LUA, "    if prev[1] and WAKE_OPEN[prev[1]] then return no('woken', { wake_id = q.wake_id, state = prev[1] }) end\n", "", 1),
 ("unknown wake frees the thread", LUA, "  if outcome ~= 'wake_unknown' then release(w, id) end\n", "  release(w, id)\n", 1),
 ("waker follow skips the read after the deadline", WK, "    for (;;) {\n      try {\n        const turn = (await this.readTurns(sinceMs))", "    for (;;) {\n      if (Date.now() >= deadline) break;\n      try {\n        const turn = (await this.readTurns(sinceMs))", 1),
 ("waker takes a missing status as ended", WK, "  return typeof turn?.status === \"string\" && turn.status !== \"\" && turn.status !== \"inProgress\";\n", "  return turn?.status !== \"inProgress\";\n", 1),
 ("waker matches the marker text, not the client id", WK, "it?.type === \"userMessage\" && it?.clientId === wakeId", "it?.type === \"userMessage\" && JSON.stringify(it).includes(`[wake:${wakeId}]`)", 1),
 ("waker sends no clientUserMessageId", WK, "          clientUserMessageId: wakeId,\n", "", 1),
 ("waker wakes a busy thread", WK, "    if (!(await this.threadIdle())) return null;\n", "", 1),
 ("waker takes an unreadable status as idle", WK, "      return acceptsTurn(type);\n", "      return acceptsTurn(type) || type === undefined;\n", 1),
 ("a thread in systemError takes no turn", AP, 'return statusType === "idle" || statusType === "systemError";', 'return statusType === "idle";', 1),
 ("any thread status takes a turn", AP, 'return statusType === "idle" || statusType === "systemError";', 'return statusType !== "active";', 1),
 ("reconcile alerts the same prompt again", RC, 'if (w.alert === "sent" || w.alert === "unknown") return;', 'if (w.alert === "unknown") return;', 1),
 ("reconcile retries an unknown alert", RC, 'if (w.alert === "sent" || w.alert === "unknown") return;', 'if (w.alert === "sent") return;', 1),
 ("reconcile alerts before the threshold", RC, 'if (now - w.since < after) return;', '', 1),
 ("reconcile alerts with alerts off", RC, 'if (!this.cfg.alert || after <= 0) return;', 'if (!this.cfg.alert) return;', 1),
 ("reconcile logs every unsent alert", RC, 'if (w.lastAlertDetail !== r.detail) this.note', 'this.note', 1),
 ("reconcile alerts on an unreadable slot", RC, '        this.note("reconcile slot unreadable"', '        { const w = this.waiting.get(slot); if (w) await this.maybeAlert(slot, w, this.now()); }\n        this.note("reconcile slot unreadable"', 1),
 ("reconcile alert carries the prompt", RC, 'const a: PromptAlert = { slot, hash: w.hash,', 'const a: PromptAlert = { question: "Proceed?", slot, hash: w.hash,', 1),
 ("waker alert takes unknown as unsent", WK, 'if (r.code === "outcome_unknown") return { outcome: "unknown", detail: r.detail };', '', 1),
 ("waker takes a failed status read as idle", WK, "      log(\"thread status unreadable, no wake this pass\", { error: String(err) });\n      return false;\n", "      return true;\n", 1),
 ("waker accepts summary items", WK, "          if (t?.itemsView !== undefined && t.itemsView !== \"full\") throw", "          if (false) throw", 1),
 ("waker stops at the first page", WK, "        if (older || r.nextCursor === null", "        if (true || r.nextCursor === null", 1),
 ("waker pages past the wake", WK, "          if (typeof t?.startedAt === \"number\" && t.startedAt < sinceS) older = true;\n", "", 1),
 ("waker recovers only once", WK, "      this.recovered = false;\n      throw err;\n", "      throw err;\n", 1),
 ("quiet period ignores the last wake", LUA, "    since = math.max(since, tonumber(prev[2] or '0') or 0)\n", "", 1),
 ("handshake ignores a close", "src/appserver.ts", "      sock.once(\"close\", closed);\n", "", 1),
 ("poll memos kept a week", LUA, "if fn == 'next' and (resp == no('empty') or resp == no('busy')) then return QUIET_MEMO_MS end", "", 1),
 ("busy poll memos kept a week", LUA, "(resp == no('empty') or resp == no('busy'))", "(resp == no('empty'))", 1),
 ("heartbeat memos kept a week", LUA, "if fn == 'heartbeat' and resp == ok() then return QUIET_MEMO_MS end", "", 1),
 ("every memo is short", LUA, "  return RETAIN_MS\nend\n\nlocal function out_key", "  return QUIET_MEMO_MS\nend\n\nlocal function out_key", 1),
 ("ingest memo off", LUA, "  if seen[3] then\n    -- A retry returns", "  if false then\n    -- A retry returns", 1),
 ("ingest rid conflict off", LUA, "    if seen[1] ~= fn or seen[2] ~= raw then return ingest_reject(slot, entry, rid, fn, 'rid_conflict', now) end\n", "", 1),
 ("ingest checkpoint skip off", LUA, "  if id_cmp(entry, redis.call('GET', checkpoint_key(slot)) or '0-0') <= 0 then\n    return ok({ skipped = true })", "  if false then\n    return ok({ skipped = true })", 1),
 ("ingest reject keeps the entry", LUA, "  checkpoint(slot, entry)\n  return body\nend", "  return body\nend", 1),
 ("ingest size limit off", LUA, "type(raw) ~= 'string' or #raw > MAX_REQUEST then", "type(raw) ~= 'string' then", 1),
 ("ingest accepts a bad request id", LUA, "  if not valid_id(rid) then return ingest_reject(slot, entry, nil, fn, 'bad_rid', now) end\n", "", 1),
 ("ingest memoizes a rejected id", LUA, "local function ingest_reject(slot, entry, rid, fn, reason, now)\n", "local function ingest_reject(slot, entry, rid, fn, reason, now)\n  if rid then redis.call('HSET', P .. 'rpc:' .. slot .. ':' .. rid, 'fn', fn or '', 'args', '', 'resp', 'x') end\n", 1),
 ("slot may write its inbox", SUP, "`%W~${p}out`, `%R~${p}resp`, `%R~${p}inbox`,", "`%W~${p}out`, `%R~${p}resp`, `%W~${p}inbox`, \"+xadd\",", 1),
 ("slot may write its response stream", SUP, "`%W~${p}out`, `%R~${p}resp`, `%R~${p}inbox`,", "`%W~${p}out`, `%W~${p}resp`, `%R~${p}inbox`,", 1),
 ("slot may read the orchestrator keys", SUP, "`%W~${p}out`, `%R~${p}resp`, `%R~${p}inbox`,", "`%W~${p}out`, `%R~${p}resp`, `%R~${p}inbox`, \"%R~mctl:bridge:*\",", 1),
 ("adapter accepts a foreign grant", CH, "g.conn_id !== conn.conn_id\n            || ", "false\n            || ", 1),
 ("adapter accepts a grant after re-registering", CH, "|| g.uuid !== conn.uuid || this.conn !== conn) {", "|| g.uuid !== conn.uuid) {", 1),
 ("link does not retry", "src/slotlink.ts", "for (let attempt = 0; attempt < this.attempts; attempt++) {", "for (let attempt = 0; attempt < 1; attempt++) {", 1),
 ("link retries under a new request id", "src/slotlink.ts", "await this.exec.execute([\"XADD\", key.out(this.slot), \"*\", \"rid\", rid,", "await this.exec.execute([\"XADD\", key.out(this.slot), \"*\", \"rid\", attempt === 0 ? rid : newId(\"x\"),", 1),

 ("cli trims stdin text", CLI, 'return stripOneNewline(fs.readFileSync(0, "utf8"));', 'return fs.readFileSync(0, "utf8").trim();', 1),
 ("cli keeps the trailing newline", CLI, 'return stripOneNewline(fs.readFileSync(0, "utf8"));', 'return fs.readFileSync(0, "utf8");', 1),
 ("cli ignores --file", CLI, "  if (file !== undefined) {\n    try {", "  if (false) {\n    try {", 1),
 ("cli accepts several text sources", CLI, "if (given !== 1) throw", "if (given === 0) throw", 1),
 ("cli resolve reason ignores stdin", CLI, 'return result(await b.resolve(id, values.as, readText(values, "reason"),', 'return result(await b.resolve(id, values.as, values.reason ?? "",', 1),
 ("slot.sh allows any git rebase", SLOT, '"Bash(git rebase origin/main)"', '"Bash(git rebase:*)"', 1),
 ("slot.sh drops the go -toolexec deny", SLOT, '"Bash(go *-toolexec*)",', '', 1),
 ("slot.sh drops the golangci-lint --fix deny", SLOT, '"Bash(golangci-lint *--fix*)",', '', 1),
 ("slot.sh allows every golangci-lint command", SLOT, '"Bash(golangci-lint run:*)"', '"Bash(golangci-lint:*)"', 1),
 ("slot.sh drops the golangci-lint allow", SLOT, '"Bash(golangci-lint run:*)",', '', 1),
 ("slot.sh lets rebase open an editor", SLOT, ' "env":{"GIT_EDITOR":"true"},', '', 1),
 ("slot.sh json not escaped", SLOT, "sys.stdout.write(json.dumps(sys.argv[1]))", "sys.stdout.write('\"' + sys.argv[1] + '\"')", 1),
 ("slot.sh hook path unquoted", SLOT, "${(qq)H}/plugin/hooks/state.py", "$H/plugin/hooks/state.py", 1),
 ("slot.sh run.sh cd unquoted", SLOT, "cd ${(qq)repo:A}", 'cd "${repo:A}"', 1),
 ("slot.sh run.sh settings path unquoted", SLOT, "--settings ${(qq)d}/settings.json", "--settings $d/settings.json", 1),
 ("slot.sh run.sh PATH unquoted", SLOT, "export PATH=${(qq)sh_home}/.local/bin", 'export PATH=$sh_home/.local/bin', 1),
 ("slot.sh runs without the slot user", SLOT, "elif [[ ${MCTL_BRIDGE_TRUSTED_EXPERIMENT:-0} == 1 ]]; then", "elif true; then", 1),
 ("slot.sh password copy world-readable", SLOT, "put $d/slot.pw 600 < $pw", "put $d/slot.pw 644 < $pw", 1),
 ("slot.sh sudo without -H", SLOT, 'sudo -n -H -u "$U" "$@"', 'sudo -n -u "$U" "$@"', 1),
 ("slot.sh session host as the operator", SLOT, "( cd /; as_ $PY -I $PTY start $d $d/run.sh )", "( cd /; $PY -I $PTY start $d $d/run.sh )", 1),
 ("slot.sh keychain password on argv", SLOT, "printf 'unlock-keychain -p %s %s\\\\n' \"\\$(<\\$kc)\" ${(qq)sh_home}/Library/Keychains/login.keychain-db | security -i >/dev/null 2>&1", 'security unlock-keychain -p "\\$(<\\$kc)" ${(qq)sh_home}/Library/Keychains/login.keychain-db', 1),
 ("probe accepts duplicate slots", "ops/host-boundary-probe.sh", "slots=(${(u)@})", "slots=($@)", 1),
 ("probe skips the operator secrets", "ops/host-boundary-probe.py", 'attempt(f"read operator secret {rel}", "DENIED", read1(f"{OPHOME}/{rel}"))', 'pass', 1),
 ("probe never tries the Codex socket", "ops/host-boundary-probe.py", 'attempt("connect Codex control socket (default path)", "DENIED", connect(', 'attempt("connect Codex control socket (default path)", "DENIED", lambda: None or (', 1),
 ("probe never signals foreign pids", "ops/host-boundary-probe.py", 'attempt(f"signal foreign pid {pid}", "DENIED", kill0(pid))', 'pass', 1),
 ("probe.sh passes no foreign pids", "ops/host-boundary-probe.sh", " pid=$$ pid=1", "", 1),
 ("probe drops a malformed pid silently", "ops/host-boundary-probe.py", 'if not a[4:].isdigit(): sys.exit(', 'if False: sys.exit(', 1),
 ("probe skips secrets it cannot stat", "ops/host-boundary-probe.py", '    attempt(f"read operator secret {rel}", "DENIED", read1(f"{OPHOME}/{rel}"))', '    if os.path.exists(f"{OPHOME}/{rel}"): attempt(f"read operator secret {rel}", "DENIED", read1(f"{OPHOME}/{rel}"))', 1),
 ("slot.sh drops Remote Control", SLOT, "exec claude ${rc}--model", "exec claude --model", 1),
 ("slot.sh Remote Control ignores the opt-out", SLOT, "[[ ${MCTL_BRIDGE_REMOTE_CONTROL:-1} == 0 ]] || rc=", "rc=", 1),
 ("slot.sh Remote Control name not per slot", SLOT, "rcname=${MCTL_BRIDGE_RC_PREFIX:-mctl-slot-}${(U)s}", "rcname=${MCTL_BRIDGE_RC_PREFIX:-mctl-slot-}x", 1),
 ("slot.sh resume id not validated", SLOT, '[[ $4 =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] ||', 'true ||', 1),
 ("slot.sh resume id not quoted", SLOT, 'resume="--resume ${(qq)4} "', 'resume="--resume $4 "', 1),
 ("slot.sh resume flag not wired", SLOT, "--model ${(qq)MODEL} ${resume}--mcp-config", "--model ${(qq)MODEL} --mcp-config", 1),
 ("slot.sh resume accepts stray arguments", SLOT, '[[ ${3-} == --resume && $# -eq 4 ]] ||', '[[ ${3-} == --resume ]] ||', 1),
 ("slot.sh session-id ignores whether the slot runs", SLOT, 'as_ $PY -I $PTY ping $D ) >/dev/null 2>&1 || { echo "slot $s is not running', 'as_ $PY -I $PTY ping $D ) >/dev/null 2>&1 || true; { echo "slot $s is not running', 1),
 ("slot.sh session-id takes the oldest state file", SLOT, "(best is None or t > best[0])", "(best is None or t < best[0])", 1),
 ("slot.sh session-id prints a non-UUID id", SLOT, 'if isinstance(sid, str) and re.fullmatch(r"[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}", sid) and', 'if isinstance(sid, str) and', 1),
 ("slot.sh session-id empty result is success", SLOT, "if best is None:\n    sys.exit(1)", "if best is None:\n    sys.exit(0)", 1),
 ("orchestrator AGENTS drops the single-send rule", "ops/orchestrator-AGENTS.md", "- Send exactly ONE new task:", "- Send a new task:", 1),
 ("orchestrator AGENTS drops the --idem key", "ops/orchestrator-AGENTS.md", "--idem continue-<old task id>-<new epoch>", "--idem continue", 1),
 ("orchestrator AGENTS lets Codex restart slots", "ops/orchestrator-AGENTS.md", "- Never run `slot.sh stop` or `slot.sh start`. Restarting is the operator's job.", "- Restarting is the operator's job.", 1),
 ("orchestrator AGENTS template drops the ack", "ops/orchestrator-AGENTS.md", "Call ack_task for this new task and attempt before performing any work. ", "", 1),
 ("orchestrator AGENTS drops the failed-resume rule", "ops/orchestrator-AGENTS.md", "Do not start a new session and do not restart the slot.", "", 1),
 ("send ignores the idempotency key", LUA, "    if existing then return ok({ id = existing, dedup = true }) end", "    if false then return ok({ id = existing, dedup = true }) end", 1),
 ("orchestrator AGENTS counts delivery_unknown as closed", "ops/orchestrator-AGENTS.md", "`delivery_unknown` or any open state does NOT count as closed.", "", 1),
 ("orchestrator AGENTS lets Codex resolve the old task", "ops/orchestrator-AGENTS.md", "You never run `resolve` on it yourself, and you never requeue it", "You may resolve it", 1),
 ("orchestrator AGENTS drops the operator resolve step", "ops/orchestrator-AGENTS.md", "The OPERATOR closes it, before asking you for a continuation,", "It gets closed", 1),
 ("orchestrator AGENTS drops the unmet-precondition refusal", "ops/orchestrator-AGENTS.md", "- If the old task is still `delivery_unknown` or open, refuse: send nothing, and report to", "- If the old task is still `delivery_unknown` or open, report to", 1),
 ("slot.sh start ignores an empty extra argument", SLOT, "    if (( $# > 2 )); then", "    if [[ -n ${3:-} ]]; then", 1),
 ("slot.sh run.sh leaves the state dir to the default", SLOT, "export MCTL_BRIDGE_STATE_DIR=${(qq)d}/state", "", 1),
 ("waitReady does not wait for LOADING", "src/store.ts", '(err instanceof Error && /\\bLOADING\\b/.test(msg)) || ', '', 1),
 ("waitReady waits for a missing library too", "src/store.ts", "      if (!unknown) throw err;", "      if (false) throw err;", 1),
 ("waitReady gives up silently", "src/store.ts", "throw new Error(`valkey not ready before the deadline: ${msg}`);", "return;", 1),
 ("waitServing does not wait for LOADING", "src/store.ts", "      const r = await this.exec.execute([\"PING\"]);\n      if (String(r) !== \"PONG\") throw new Error(`unexpected PING reply: ${String(r)}`);", "      return;", 1),
 ("init does not wait for the server", "src/cli.ts", "      await b.waitServing({ onWait: (r) => process.stderr.write(`waiting for valkey: ${r}\\n`) });\n", "", 1),
 ("install.sh takes a LOADING reply for ready", "ops/install.sh", "    [[ $(cli PING 2>/dev/null) == PONG ]] && return 0", "    cli PING >/dev/null 2>&1 && return 0", 1),
 ("install.sh stops at a failed readiness check", "ops/install.sh", '  fail="valkey did not become ready on :$PORT (see $H/log/valkey.err)"', '  echo "valkey did not become ready" >&2; exit 1', 1),
 ("install.sh stops at a failed init", "ops/install.sh", '  fail="mctl-bridge init failed: the function library is not loaded"', '  exit 1', 1),
 ("install.sh swallows a failed install", "ops/install.sh", "if [[ -n $fail ]]; then\n  echo \"INSTALL FAILED", "if false; then\n  echo \"INSTALL FAILED", 1),
 ("ingest dies on LOADING", "src/ingest.ts", "  await bridge.waitReady({ onWait: (r) => log(\"waiting for valkey\", { reason: r }) });", "  await bridge.checkVersion();", 1),
 ("waker dies on LOADING", "src/waker.ts", "  await bridge.waitReady({ onWait: (r) => log(\"waiting for valkey\", { reason: r }) });", "  await bridge.checkVersion();", 1),
 ("slot.sh drops the credential-path Bash denies", SLOT, '"Bash(*.ssh*)","Bash(*.config/gh*)","Bash(*.aws*)","Bash(*.git-credentials*)","Bash(*.pw*)","Bash(*keychain*)",', "", 1),
 ("slot.sh allows a general Bash reader", SLOT, '"Bash(wc:*)","Bash(cut:*)",', '"Bash(wc:*)","Bash(cut:*)","Bash(cat:*)",', 1),
 ("slot.sh drops the pipe filters", SLOT, '"Bash(head:*)","Bash(tail:*)",', "", 1),
 ("channel instructions drop the no-cd rule", CH, "Work from the repository root and never cd", "Work from anywhere", 1),
 ("channel instructions drop the edit-tools rule", CH, "Edit files with the built-in Edit or Write tools, never with a script", "Edit files however you like, including with a script", 1),
 ("slot.sh mcp reads the operator password", SLOT, '$(json "$d/slot.pw")', '$(json "$pw")', 1),
 ("slot.sh drops the ps allow", SLOT, ',"Bash(ps -o pid,ppid,stat,lstart,command -p:*)","Bash(date)","Bash(date -u)"', ',"Bash(date)","Bash(date -u)"', 1),
 ("slot.sh allows every ps form", SLOT, ',"Bash(ps -o pid,ppid,stat,lstart,command -p:*)","Bash(date)"', ',"Bash(ps:*)","Bash(date)"', 1),
 ("slot.sh drops the ps environment deny", SLOT, ',"Bash(ps *e*)","Bash(ps *E*)"', '', 1),
 ("slot.sh allows kill without the slot user boundary", SLOT, '    if (( BOUNDARY )); then allow+=\',"Bash(kill:*)"\'; fi', '    allow+=\',"Bash(kill:*)"\'', 1),
 ("slot.sh drops the pkill deny", SLOT, ',"Bash(pkill:*)","Bash(killall:*)"', '', 1),
 ("slot.sh deps install not frozen", SLOT, 'install --frozen-lockfile --ignore-scripts', 'install --ignore-scripts', 1),
 ("slot.sh deps install runs scripts", SLOT, 'install --frozen-lockfile --ignore-scripts', 'install --frozen-lockfile', 1),
 ("slot.sh deps opt-out ignored", SLOT, 'if [[ ${MCTL_BRIDGE_SLOT_DEPS:-1} != 0 ]]; then', 'if true; then', 1),
 ("slot.sh deps failure is fatal", SLOT, '          echo "deps: bun install failed in ${lock:h}; the slot\'s typecheck will fail: ${out[-300,-1]}" >&2', '          exit 1', 1),
 ("slot.sh deps installs inside node_modules", SLOT, " -not -path '*/node_modules/*'", '', 1),
 ("slot.sh default model back to haiku", SLOT, 'MODEL=${MCTL_BRIDGE_SLOT_MODEL:-sonnet}', 'MODEL=${MCTL_BRIDGE_SLOT_MODEL:-haiku}', 1),
 ("slot.sh start line hides the model", SLOT, ' on model $MODEL (pty session', ' (pty session', 1),
 ("channel instructions drop the one-command rule", CH, "no ; echo exit=$? and no && or ; chains", "chains are fine", 1),
 ("channel instructions drop the ps rule", CH, "use ps -o pid,ppid,stat,lstart,command -p <pid>", "use ps aux | grep", 1),

 ("poison memo off", LUA, "  redis.call('HSET', memo, 'fn', fn, 'args', raw, 'resp', body, 'entry', entry, 't', now)\n  redis.call('PEXPIRE', memo, RETAIN_MS)\n  ingest_reject(slot, entry, rid, fn, reason, now)", "  ingest_reject(slot, entry, rid, fn, reason, now)", 1),
 ("poison ingester drops the request id", "src/ingest.ts", '"handler_error", f.rid ?? "", f.fn ?? "", f.args ?? ""]', '"handler_error"]', 1),
 ("server bulk limit off", SUP, '["proto-max-bulk-len", "1048576"]', '["proto-max-bulk-len", "536870912"]', 1),
 ("server query buffer limit off", SUP, '["client-query-buffer-limit", "1048576"]', '["client-query-buffer-limit", "1073741824"]', 1),
 ("install.sh bulk limit off", "ops/install.sh", "proto-max-bulk-len 1048576", "proto-max-bulk-len 536870912", 1),
 ("install.sh maxmemory off", "ops/install.sh", "maxmemory 256mb\n", "", 1),
 ("no fsync", SUP, '"--appendfsync", "always"', '"--appendfsync", "no"', 1),
 ("no aof", SUP, '["--save", "", "--appendonly", "yes", "--appendfsync", "always"]', '["--save", "", "--appendonly", "no"]', 1),
 ("guard ignores remote-control flag", GUARD, "!/--remote-control/ { print $1 }", "{ print $1 }", 1),
 ("guard counts proxy as server", GUARD, "&& !/ proxy/ {", "{", 1),
 ("guard kills during wake", GUARD, 'if [ "$state" = open ]; then', 'if false; then', 1),
 ("guard unreadable log is idle", GUARD, 'if [ ! -r "$WAKER_LOG" ]; then', 'if false; then', 1),
 ("guard restart does not clear open wake", WAKE, '  /"msg":"started"/ { s = "idle" }\n', '', 1),
 ("guard failed wake stays open", WAKE, ' || /"msg":"wake failed"/', '', 1),
 ("guard ignores kill failure", GUARD, '$KILL "$pid" || { say "could not stop pid $pid"; exit 1; }', '$KILL "$pid" || true', 1),
 ("guard ps truncates", GUARD, '-axww -o pid=,command=', '-ax -o pid=,command=', 1),
  ("guard wake scan is a fixed tail", WAKE, "grep -E '\"msg\":\"(wake (intent|started|completed|failed|no longer ours)|started)\"' \"$1\" | tail -n 50 | awk '", "tail -n 400 \"$1\" | awk '", 1),
 ("guard never starts the daemon", GUARD, '"$CODEX" remote-control start 2>&1 ||', 'true ||', 1),
 ("updater ancestor check off", UPD, 'g merge-base --is-ancestor "$c" refs/heads/main', 'true', 1),
 ("updater lexical tag sort", UPD, "$(g tag -l | sort -t. -k1,1nr -k2,2nr -k3,3nr)", "$(g tag -l | sort -r)", 1),
 ("updater accepts any tag name", UPD, "''|*[!0-9.]*|.*|*.|*..*) return 1", "'') return 1", 1),
 ("updater dot count off", UPD, "[ \"$(printf '%s' \"$1\" | tr -cd . | wc -c | tr -d ' ')\" = 2 ] || return 1", "true", 1),
 ("updater compares tag name only", UPD, '[ "$have" = "$want $sha" ]', '[ "${have%% *}" = "$want" ]', 1),
 ("updater fetch failure ignored", UPD, 'say "could not fetch $REPO; not updating (unknown is not up to date)"\n    return 1', 'say "could not fetch $REPO; not updating (unknown is not up to date)"\n    :', 1),
 ("updater ignores wake in flight", UPD, 'if [ "$(waker_state "$log")" = open ]; then', 'if false; then', 1),
 ("updater unreadable log is idle", UPD, 'if [ ! -r "$log" ]; then', 'if false; then', 1),
 ("updater retries a failed release", UPD, 'if [ "$(cat "$H/etc/updater-failed" 2>/dev/null || true)" = "$want $sha" ] \\', 'if false \\', 1),
 ("updater forgets a failed install", UPD, '  echo "$want $sha" > "$H/etc/updater-failed"\n  say "install of', '  say "install of', 1),
 ("updater failed install reports success", UPD, "unchanged ('${have:-none}')\"\n  return 1", "unchanged ('${have:-none}')\"\n  return 0", 1),
 ("updater pin not checked", UPD, 'releasable "$pin" ||', 'true ||', 1),
 ("updater no thread check", UPD, 'if [ -z "$thread" ]; then', 'if false; then', 1),
 ("updater live lock ignored", UPD, 'kill -0 "$other" 2>/dev/null', 'false', 1),
 ("updater lock not released", UPD, "trap 'rm -rf \"$lock\" \"$tmp\"' EXIT\n", "trap 'rm -rf \"$tmp\"' EXIT\n", 1),
 ("updater hides its own run from install", UPD, "MCTL_BRIDGE_FROM_UPDATER=1 ", "", 1),
 ("updater never records the version", UPD, 'printf \'%s\\n\' "$want $sha" > "$H/VERSION" ||', ': ||', 1),
 ("updater records version before install", UPD, '  if MCTL_BRIDGE_HOME=$H MCTL_BRIDGE_FROM_UPDATER=1 \\\n', '  printf \'%s\\n\' "$want $sha" > "$H/VERSION"\n  if MCTL_BRIDGE_HOME=$H MCTL_BRIDGE_FROM_UPDATER=1 \\\n', 1),
 ("updater goes backwards", UPD, 'if [ "${have%% *}" != "$want" ] && [ "$top" = "${have%% *}" ]; then', 'if false; then', 1),
 ("updater pin never retries a failed release", UPD, '&& ! { [ -n "$pin" ] && [ "$H/etc/pin" -nt "$H/etc/updater-failed" ]; }; then', '; then', 1),
 ("updater pin retries a failed release every run", UPD, '[ "$H/etc/pin" -nt "$H/etc/updater-failed" ]', 'true', 1),
 ("updater downgrade check ignores pin", UPD, 'if [ -z "$pin" ] && [ -n "$have" ]; then', 'if [ -n "$have" ]; then', 1),
 ("install boots out the updater from the updater", INSTALL, "if [[ -z ${MCTL_BRIDGE_FROM_UPDATER:-} ]]; then", "if true; then", 1),
 ("install overwrites scripts in place", INSTALL, "mv -f $H/$f.new $H/$f", "cp $H/$f.new $H/$f", 1),
 ("install forgets the thread id", INSTALL, 'print -r -- "$THREAD_ID" > $H/etc/thread-id', ':', 1),
 # Slot observation (ops/slot-pty.py). These run the python suite (test_slot_pty.py), not bun.
 ("pty: an empty reply reads as a screen", PTY, '    if not reply:\n        sys.exit("slot host sent no answer', '    if False:\n        sys.exit("slot host sent no answer', 1),
 ("pty: an unreachable host reads as an empty screen", PTY, '        sys.exit(f"slot host unreachable ({e}): cannot observe this slot, its prompt state is UNKNOWN")', '        reply = b"\\n"', 1),
 ("pty: parameterless sequences ignored", PTY, 'if p and p[0] in "?><=!": return', 'if p[:1] in "?><=!": return', 1),
 ("pty: save and restore cursor ignored", PTY, 'elif ch == "8": self.r, self.c = self.saved', 'elif ch == "8": pass', 1),
 ("pty: wide glyphs take one column", PTY, 'w = 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1', 'w = 1', 1),
 ("pty: combining marks take a column", PTY, 'if unicodedata.combining(ch) or unicodedata.category(ch) in ("Mn", "Me", "Cf"):', 'if False:', 1),
 ("pty: half a wide glyph survives an overwrite", PTY, 'if row[self.c] == "" and self.c > 0: row[self.c - 1] = " "', 'pass', 1),
 ("pty: column moves ignored", PTY, 'elif f == "G": self.c = min(self.cols - 1, n - 1)', 'elif f == "G": pass', 1),
 ("pty: line erase ignored", PTY, 'elif f == "K":\n            m = a[0] if a else 0', 'elif f == "Kx":\n            m = a[0] if a else 0', 1),
 ("pty: cursor up ignored", PTY, 'if f == "A": self.r = max(0, self.r - n)', 'if f == "A": pass', 1),
 ("pty: one numbered option is a permission prompt", PTY, 'if len(opts) >= 2: q = (i, opts)', 'if len(opts) >= 1: q = (i, opts)', 1),
 ("pty: the command is cut at the wrong rule", PTY, 'while j >= 0 and not SOLID.search(lines[j]): j -= 1', 'j = max(i - 1, 0)', 1),
 ("pty: dialogs without options are not pending", PTY, 'FOOTER = re.compile(r"Enter to confirm|Esc to cancel|Press Enter to continue")', 'FOOTER = re.compile(r"NEVERMATCHES")', 1),
 ("pty: idle time is not measured", PTY, '"idle_s": round(time.time() - last_out, 1)', '"idle_s": 0.0', 1),
 ("pty: output does not reset idle time", PTY, 'screen.feed(data); last_out = time.time()', 'screen.feed(data)', 1),
 # Slot observation (src/cli.ts observe, ops/watch.sh). bun tests.
 ("observe: an empty record is finished", CLI, '  if (!rec.state) return { code: 1, out: { ok: false, code: "unknown", id } };', '  if (!rec.state) rec.state = "completed";', 1),
 ("observe: asked question is settled", CLI, '  q: ["reply_acknowledged", "closed", "cancelled", "expired"],', '  q: ["asked", "reply_acknowledged", "closed", "cancelled", "expired"],', 1),
 ("observe: delivery_unknown needs no operator", CLI, 'const NEEDS_OPERATOR = ["delivery_unknown", "wake_unknown"];', 'const NEEDS_OPERATOR = ["wake_unknown"];', 1),
 ("observe: wake_unknown needs no operator", CLI, 'const NEEDS_OPERATOR = ["delivery_unknown", "wake_unknown"];', 'const NEEDS_OPERATOR = ["delivery_unknown"];', 1),
 ("observe: busy passes as progress", CLI, 'note: "adapter liveness only, not evidence of progress",', 'note: "busy and a fresh heartbeat: working",', 1),
 ("observe: a question hides its wakes", CLI, '  if (k === "q") out.wakes', '  if (false) out.wakes', 1),
 ("observe: wake ids refused", CLI, 'kind !== "q-" && kind !== "w-")', 'kind !== "q-")', 1),
 ("watch: an empty reading is a state", WATCH, 'print("ERR empty output from the CLI"); sys.exit()', 'print("OK running empty"); sys.exit()', 1),
 ("watch: a garbled reading is a state", WATCH, 'print("ERR unreadable output: " + raw.strip()[:200].replace("\\n", " ")); sys.exit()', 'print("OK running garbled"); sys.exit()', 1),
 ("watch: a refused reading is a state", WATCH, 'if not isinstance(d, dict) or d.get("ok") is not True:', 'if False:', 1),
 ("watch: a reply without state is accepted", WATCH, 'if not state:\n    print("ERR reply carries no state"); sys.exit()', 'if False:\n    print("ERR reply carries no state"); sys.exit()', 1),
 ("watch: never gives up on failing readings", WATCH, 'if [ "$bad" -ge 3 ]; then', 'if false; then', 1),
 ("watch: a hung reading is waited for", WATCH, 'timeout=float(sys.argv[3]))', 'timeout=None)', 1),
 ("watch: needs-operator is swallowed", WATCH, "operator) printf 'WATCH-NEEDS-OPERATOR: %s\\n' \"$line\"; exit 4 ;;", "operator) : ;;", 1),
 ("watch: never times out", WATCH, 'if [ "$waited" -ge "$max" ]; then', 'if false; then', 1),
 ("watch: a terminal state is not settled", WATCH, 'verdict = "settled" if d.get("terminal") is True else', 'verdict = "running" if d.get("terminal") is True else', 1),
 ("watch: prints every poll", WATCH, 'if [ "$line" != "$last" ]; then', 'if true; then', 1),
 # Slots run the tests from the repository root and never need a Bash reader (test/launcher.test.ts).
 ("slot.sh drops the bun test rule", SLOT, ',"Bash(bun test:*)"', "", 1),
 ("slot.sh allows bun --cwd anywhere", SLOT, '"Bash(bun test:*)"', '"Bash(bun test:*)","Bash(bun --cwd:*)"', 1),
 ("slot.sh allows cmp", SLOT, '"Bash(wc:*)","Bash(cut:*)",', '"Bash(wc:*)","Bash(cut:*)","Bash(cmp:*)",', 1),
 ("slot.sh allows cd", SLOT, '"Bash(wc:*)","Bash(cut:*)",', '"Bash(wc:*)","Bash(cut:*)","Bash(cd:*)",', 1),
 ("slot.sh allows python3 from stdin", SLOT, '"Bash(wc:*)","Bash(cut:*)",', '"Bash(wc:*)","Bash(cut:*)","Bash(python3 -:*)",', 1),
 ("slot.sh PATH lacks bun", SLOT, "/usr/bin:/bin:${(qq)bun:h}:${(qq)H}/valkey/bin", "/usr/bin:/bin:${(qq)H}/valkey/bin", 1),
 ("slot.sh PATH lacks valkey", SLOT, "/usr/bin:/bin:${(qq)bun:h}:${(qq)H}/valkey/bin", "/usr/bin:/bin:${(qq)bun:h}", 1),
 ("slot.sh PATH test tools shadow the system", SLOT, "export PATH=${(qq)sh_home}/.local/bin:/usr/local/bin:/usr/bin:/bin:${(qq)bun:h}:${(qq)H}/valkey/bin", "export PATH=${(qq)bun:h}:${(qq)H}/valkey/bin:${(qq)sh_home}/.local/bin:/usr/local/bin:/usr/bin:/bin", 1),
 ("slot.sh PATH bun dir unquoted", SLOT, ":/bin:${(qq)bun:h}:", ":/bin:${bun:h}:", 1),
 ("slot.sh PATH valkey dir unquoted", SLOT, ":${(qq)H}/valkey/bin", ":$H/valkey/bin", 1),
 ("instructions drop the root bun test command", CH, "the bridge tests from the root too: bun test --cwd plugin/mctl-bridge and", "the bridge tests from the root too: and", 1),
 ("instructions drop the root python test command", CH, "python3 -m unittest discover -s plugin/mctl-bridge/test -p 'test_*.py'.", "python3 -m unittest.", 1),
 ("instructions drop commit first", CH, "For a temporary mutation check: commit first, edit", "For a temporary mutation check: edit", 1),
 ("instructions drop the git restore undo", CH, "   git restore <file>, and confirm with git status or git diff. Never", "   Never", 1),
 ("instructions drop the temp backup ban", CH, " Never copy backups to a temp dir and", " Keep copies and", 1),
]

def tests_for(f):
    """The suite that must notice a mutation of file f: the python host has its own unittest suite."""
    if f == PTY:
        return ['python3', '-m', 'unittest', 'discover', '-s', 'test', '-p', 'test_slot_pty.py']
    # --bail ends the run at the first failure. A kill needs only one failing test,
    # and a survivor fails none, so it still runs the whole suite: the verdict is
    # the same as a full run, about three times faster on average.
    return ['bun', 'test', '--bail']

def parse_shard(spec, total=None):
    """'I/N' -> (I, N); anything malformed or out of range is an error."""
    try:
        i, n = (int(x) for x in spec.split('/'))
    except ValueError:
        raise SystemExit(f"bad shard spec {spec!r}, want I/N")
    if n < 1 or not 1 <= i <= n:
        raise SystemExit(f"bad shard spec {spec!r}: need 1 <= I <= N")
    return i, n

def shard_of(entries, i, n):
    """Round-robin partition by index; deterministic from the list alone."""
    return [e for k, e in enumerate(entries) if k % n == i - 1]

def main(argv):
    shard = None; list_only = False; only = []
    args = list(argv)
    while args:
        a = args.pop(0)
        if a in ('--shard', '--list-shard'):
            if not args: sys.exit(f"{a} needs I/N")
            shard = parse_shard(args.pop(0)); list_only = a == '--list-shard'
        else:
            only.append(a)
    if shard and only:
        sys.exit("--shard and explicit names are mutually exclusive")
    names = [e[0] for e in M]
    if len(set(names)) != len(names):
        sys.exit("duplicate mutation names")
    # Every pattern must match exactly where intended before any file is touched,
    # in every shard, so a stale pattern fails all of them.
    ambiguous=[(name, open(f).read().count(old)) for name,f,old,new,n in M if open(f).read().count(old)!=n]
    if ambiguous:
        sys.exit(f"mutation patterns do not match as declared: {ambiguous}")
    if shard:
        todo = shard_of(M, *shard)
        if not todo:
            sys.exit(f"shard {shard[0]}/{shard[1]}: empty shard ({len(M)} total), refusing to pass")
        if list_only:
            print('\n'.join(e[0] for e in todo)); return
    else:
        unknown = [o for o in only if o not in names]
        if unknown: sys.exit(f"unknown mutation names: {unknown}")
        todo = [e for e in M if not only or e[0] in only]
    survived=[]; ran=0
    for name,f,old,new,n in todo:
        src=open(f).read()
        assert src.count(old)==n, (name, src.count(old))
        shutil.copy(f,f+'.bak')
        open(f,'w').write(src.replace(old,new))
        try:
            r=subprocess.run(tests_for(f),capture_output=True,text=True,timeout=300)
        finally:
            shutil.move(f+'.bak',f)
        ran += 1
        out=r.stdout+r.stderr
        fails=[l.strip() for l in out.splitlines() if l.strip().startswith(('(fail)', 'FAIL:', 'ERROR:'))]
        print(('KILLED ' if r.returncode else 'SURVIVED ')+name, '|', '; '.join(fails)[:200], flush=True)
        if not r.returncode: survived.append(name)
    label = f"shard {shard[0]}/{shard[1]}" if shard else "run"
    print(f"{label}: ran {ran} of {len(todo)} expected, {len(M)} total", flush=True)
    if ran != len(todo):
        sys.exit(f"{label}: ran {ran} mutations, expected {len(todo)}")
    if survived:
        sys.exit('survived: ' + ', '.join(survived))

if __name__ == '__main__':
    main(sys.argv[1:])
