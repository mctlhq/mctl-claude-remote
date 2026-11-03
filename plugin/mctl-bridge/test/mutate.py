#!/usr/bin/env python3
"""Mutation check for the bridge's guarantees.

Each entry reverts one guarantee in src/bridge.lua (or the durable test
profile) and runs `bun test`; every mutation must make at least one test fail.
Run from plugin/mctl-bridge:  python3 test/mutate.py [name ...]
"""
import subprocess, sys, shutil
LUA='src/bridge.lua'; SUP='test/support.ts'; CH='src/channel.ts'; WK='src/waker.ts'
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
 ("waker reads a broken history as empty", WK, "        throw new ConnectionLost(\"thread/read returned no turns\"); // unreadable, not empty\n", "        return { turns: [] };\n", 1),
 ("waker treats a refused start as unknown", WK, "        if (err instanceof RpcError) {\n", "        if (err instanceof RpcError && false) {\n", 1),
 ("wake ignores the thread lock", LUA, "  if holder then return no('thread_busy', { wake_id = holder }) end\n", "", 1),
 ("wake ignores the hourly limit", LUA, "  if tonumber(redis.call('GET', bucket) or '0') >= per_hour then return no('rate_limited') end\n", "", 1),
 ("wake ignores the claim", LUA, "  if redis.call('EXISTS', P .. 'claim:' .. qid) == 1 then return no('claimed') end\n  local now = now_ms()\n  if now - tonumber(q.updated_ms", "  local now = now_ms()\n  if now - tonumber(q.updated_ms", 1),
 ("wake ignores the quiet period", LUA, "then return no('too_early') end\n", "then end\n", 1),
 ("wake again while unresolved", LUA, "    if prev and WAKE_OPEN[prev] then return no('woken', { wake_id = q.wake_id, state = prev }) end\n", "", 1),
 ("unknown wake frees the thread", LUA, "  if outcome ~= 'wake_unknown' then release(w, id) end\n", "  release(w, id)\n", 1),
 ("no fsync", SUP, '"--appendfsync", "always"', '"--appendfsync", "no"', 1),
 ("no aof", SUP, '["--save", "", "--appendonly", "yes", "--appendfsync", "always"]', '["--save", "", "--appendonly", "no"]', 1),
]
only=sys.argv[1:]
# Every pattern must match exactly where intended before any file is touched.
ambiguous=[(name, open(f).read().count(old)) for name,f,old,new,n in M if open(f).read().count(old)!=n]
if ambiguous:
    sys.exit(f"mutation patterns do not match as declared: {ambiguous}")
survived=[]
for name,f,old,new,n in M:
    if only and name not in only: continue
    src=open(f).read()
    assert src.count(old)==n, (name, src.count(old))
    shutil.copy(f,f+'.bak')
    open(f,'w').write(src.replace(old,new))
    try:
        r=subprocess.run(['bun','test'],capture_output=True,text=True,timeout=300)
    finally:
        shutil.move(f+'.bak',f)
    out=r.stdout+r.stderr
    fails=[l.strip() for l in out.splitlines() if l.strip().startswith('(fail)')]
    print(('KILLED ' if r.returncode else 'SURVIVED ')+name, '|', '; '.join(fails)[:200])
    if not r.returncode: survived.append(name)
if survived:
    sys.exit('survived: ' + ', '.join(survived))
