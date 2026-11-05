#!/usr/bin/env python3
"""Mutation check for the bridge's guarantees.

Each entry reverts one guarantee in src/bridge.lua (or the durable test
profile) and runs `bun test`; every mutation must make at least one test fail.
Run from plugin/mctl-bridge:  python3 test/mutate.py [name ...]

Sharding (CI runs 4 jobs in parallel):
  python3 test/mutate.py --shard I/N        run shard I of N (1-based)
  python3 test/mutate.py --list-shard I/N   print the names in that shard
The partition is round-robin over the full list by index (index % N == I-1),
so it is a pure function of the list. Every shard still validates the patterns
of the WHOLE list before touching a file and runs the FULL `bun test` per
mutation. A shard fails if a mutation survived, a run crashed or timed out, an
empty shard was requested, or it ran a different number of mutations than its
partition says. test/test_shards.py proves the partition is exact.
"""
import subprocess, sys, shutil
LUA='src/bridge.lua'; SUP='test/support.ts'; CH='src/channel.ts'; WK='src/waker.ts'; CLI='src/cli.ts'; SLOT='ops/slot.sh'; GUARD='ops/codex-remote-guard.sh'; WAKE='ops/wake-state.sh'; UPD='ops/bridge-updater.sh'; INSTALL='ops/install.sh'
M=[
 ("fencing off", LUA, "local function fenced(s, conn, epoch)\n  return", "local function fenced(s, conn, epoch)\n  do return false end\n  return", 1),
 ("busy gate off", LUA, "if s.busy ~= '0' then return no('busy') end", "", 1),
 ("admission attempt check off", LUA, "  if m.attempt_id ~= attempt or m.emit_epoch ~= epoch or m.emit_conn ~= conn then\n    return nil, m, 'attempt_mismatch'", "  if false then\n    return nil, m, 'attempt_mismatch'", 1),
 ("admission uuid check off", LUA, "if fenced(s, conn, epoch) or s.uuid ~= uuid then return nil, m, 'fenced' end", "if fenced(s, conn, epoch) then return nil, m, 'fenced' end", 1),
 ("claim NX off", LUA, "token, 'NX', 'PX', lease", "token, 'PX', lease", 1),
 ("reply token check off", LUA, "  if redis.call('GET', P .. 'claim:' .. qid) ~= token then return no('not_owner') end\n  local m = hgetall(mkey(qid))", "  local m = hgetall(mkey(qid))", 1),
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
 ("waker takes an unreadable status as idle", WK, "      return type === \"idle\";\n", "      return type === \"idle\" || type === undefined;\n", 1),
 ("waker takes a failed status read as idle", WK, "      log(\"thread status unreadable, no wake this pass\", { error: String(err) });\n      return false;\n", "      return true;\n", 1),
 ("waker accepts summary items", WK, "          if (t?.itemsView !== undefined && t.itemsView !== \"full\") throw", "          if (false) throw", 1),
 ("waker stops at the first page", WK, "        if (older || r.nextCursor === null", "        if (true || r.nextCursor === null", 1),
 ("waker pages past the wake", WK, "          if (typeof t?.startedAt === \"number\" && t.startedAt < sinceS) older = true;\n", "", 1),
 ("waker recovers only once", WK, "      this.recovered = false;\n      throw err;\n", "      throw err;\n", 1),
 ("quiet period ignores the last wake", LUA, "    since = math.max(since, tonumber(prev[2] or '0') or 0)\n", "", 1),
 ("handshake ignores a close", "src/appserver.ts", "      sock.once(\"close\", closed);\n", "", 1),
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
 ("slot.sh mcp reads the operator password", SLOT, '$(json "$d/slot.pw")', '$(json "$pw")', 1),

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
]

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
            r=subprocess.run(['bun','test'],capture_output=True,text=True,timeout=300)
        finally:
            shutil.move(f+'.bak',f)
        ran += 1
        out=r.stdout+r.stderr
        fails=[l.strip() for l in out.splitlines() if l.strip().startswith('(fail)')]
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
