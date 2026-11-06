#!lua name=mctl_bridge

-- State machine of the orchestrator bridge (docs/chatgpt-orchestrator-bridge.md).
--
-- Every state transition is one function call, so msg:<id>, the open indexes, the
-- ready/asked queues, dedup and audit always change together. Streams are doorbells
-- only: losing or trimming one never loses a message, because the queues below are
-- authoritative.
--
-- Roles. Orchestrator functions declare `mctl:bridge:orch` as their first key; slot
-- functions declare that slot's `mctl:bridge:s:<slot>:slot`. Keys are derived inside
-- the functions, so the library targets a standalone Valkey, not a Cluster.
--
-- Slot isolation (slice 4b). Valkey checks every key a function touches against the
-- caller's ACL, so a slot allowed to FCALL its own functions could write any other
-- key too. Slots therefore get no FCALL at all: a slot XADDs a request to its own
-- `s:<slot>:out` stream and reads the answer from `s:<slot>:resp`, which only the
-- orchestrator writes. `bridge_ingest` (orchestrator role) takes one request, takes
-- the slot's identity from the stream the request was read from, never from its
-- body, runs the slot function, and in the same call stores the answer under the
-- request id, appends it to the response stream and advances the slot's checkpoint.
-- A retried request id gets the stored answer, so nothing is applied twice.
--
-- Every function returns a JSON object: {"ok":true,...} or {"ok":false,"code":...}.
-- Rejections are data, not errors: a fenced or stale caller is an expected event.

local VERSION = '5'
local P = 'mctl:bridge:'
local MAX_PAYLOAD = 16384
local MAX_HOP = 4
local RETAIN_MS = 7 * 24 * 3600 * 1000
-- A request's memo only has to outlive the sender's retries, which take seconds.
local QUIET_MEMO_MS = 3600 * 1000
local AUDIT_MAXLEN = 100000
local FEED_MAXLEN = 10000
local LATE_MAXLEN = 100
local MSG_AUDIT_MAXLEN = 200
local EXPIRED_REPLY = '[mctl-bridge] No reply arrived before the question expired.'

-- Terminal states leave every open index and start the retention clock.
local TERMINAL = {
  completed = true, failed = true, expired = true, cancelled = true,
  reply_acknowledged = true, closed = true,
}

local function now_ms()
  local t = redis.call('TIME')
  return tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
end

local function ok(t)
  t = t or {}
  t.ok = true
  return cjson.encode(t)
end

local function no(code, t)
  t = t or {}
  t.ok = false
  t.code = code
  return cjson.encode(t)
end

local function hgetall(key)
  local r = redis.call('HGETALL', key)
  local t = {}
  for i = 1, #r, 2 do t[r[i]] = r[i + 1] end
  return t
end

local function valid_id(s)
  return type(s) == 'string' and #s > 0 and #s <= 128 and not s:find('[^%w%-_:.]')
end

local function valid_slot(s)
  return type(s) == 'string' and #s > 0 and #s <= 32 and not s:find('[^a-z0-9%-]')
end

local function valid_payload(s)
  return type(s) == 'string' and #s <= MAX_PAYLOAD
end

local function mkey(id) return P .. 'msg:' .. id end
local function skey(slot) return P .. 's:' .. slot .. ':slot' end
local function ready_key(slot) return P .. 's:' .. slot .. ':ready' end
local function inbox_key(slot) return P .. 's:' .. slot .. ':inbox' end
local function slot_open_key(slot) return P .. 's:' .. slot .. ':open' end
local OPEN = P .. 'open'
local ASKED = P .. 'asked'
local AUDIT = P .. 'audit'
local FEED = P .. 'outbox'
local SEQ = P .. 'seq'

-- Global trail plus a bounded per-message trail, so reading one message's history
-- never scans the whole audit stream.
local function audit(id, from, to, actor, reason, now)
  redis.call('XADD', AUDIT, 'MAXLEN', '~', AUDIT_MAXLEN, '*',
    'id', id, 'from', from or '', 'to', to, 'actor', actor or '', 'reason', reason or '', 't', now)
  redis.call('XADD', P .. 'audit:' .. id, 'MAXLEN', '~', MSG_AUDIT_MAXLEN, '*',
    'from', from or '', 'to', to, 'actor', actor or '', 'reason', reason or '', 't', now)
end

local function feed(id, event, now)
  redis.call('XADD', FEED, 'MAXLEN', '~', FEED_MAXLEN, '*', 'id', id, 'event', event, 't', now)
end

local function ring(slot, id, now)
  redis.call('XADD', inbox_key(slot), 'MAXLEN', '~', FEED_MAXLEN, '*', 'id', id, 't', now)
end

-- The one way a message changes state.
local function transition(id, m, to, actor, reason, now, fields)
  local args = { 'state', to, 'updated_ms', now, 'reason', reason or '' }
  if fields then
    for k, v in pairs(fields) do
      args[#args + 1] = k
      args[#args + 1] = v
    end
  end
  redis.call('HSET', mkey(id), unpack(args))
  audit(id, m.state, to, actor, reason, now)
  if TERMINAL[to] or to == 'delivery_unknown' then
    redis.call('ZREM', ready_key(m.slot), id)
    redis.call('ZREM', ASKED, id)
  end
  if TERMINAL[to] then
    redis.call('SREM', OPEN, id)
    redis.call('SREM', slot_open_key(m.slot), id)
    redis.call('PEXPIRE', mkey(id), RETAIN_MS)
    redis.call('PEXPIRE', P .. 'audit:' .. id, RETAIN_MS)
    redis.call('PEXPIRE', P .. 'late:' .. id, RETAIN_MS)
    if m.idem and m.idem ~= '' then
      redis.call('PEXPIRE', P .. 'dedup:' .. m.idem, RETAIN_MS)
    end
  end
  if to == 'delivery_unknown' then feed(id, 'delivery_unknown', now) end
  m.state = to
end

local function clear_inflight(slot, task_id)
  local s = skey(slot)
  if redis.call('HGET', s, 'inflight') == task_id then
    redis.call('HSET', s, 'inflight', '', 'inflight_attempt', '')
  end
end

-- A task that ends takes its open question with it: no reply can reach it any more.
local function close_question(task_m, actor, reason, now)
  local qid = task_m.open_question
  if not qid or qid == '' then return end
  local q = hgetall(mkey(qid))
  if q.state and not TERMINAL[q.state] then
    transition(qid, q, 'closed', actor, reason, now)
    redis.call('DEL', P .. 'claim:' .. qid)
  end
end

-- The caller is the slot's current adapter connection and epoch.
local function fenced(s, conn, epoch)
  return s.epoch == nil or s.conn_id == nil or s.conn_id == '' or s.conn_id ~= conn or s.epoch ~= epoch
end

-- Admission: {task_id, attempt_id, uuid, epoch, conn_id} must all match both the
-- slot's current registration and the task as it was acknowledged.
local function admit(slot, a)
  local task_id, attempt, uuid, epoch, conn = a[2], a[3], a[4], a[5], a[6]
  if not valid_id(task_id) then return nil, nil, 'bad_request' end
  local s = hgetall(skey(slot))
  local m = hgetall(mkey(task_id))
  if m.kind ~= 'task' or m.slot ~= slot then return nil, m, 'unknown_task' end
  if fenced(s, conn, epoch) or s.uuid ~= uuid then return nil, m, 'fenced' end
  if m.state ~= 'acked' then return nil, m, 'not_acked' end
  if m.attempt_id ~= attempt or m.emit_epoch ~= epoch or m.emit_conn ~= conn then
    return nil, m, 'attempt_mismatch'
  end
  if s.inflight ~= task_id then return nil, m, 'not_inflight' end
  return s, m, nil
end

-- Evidence from a caller that may no longer change state.
local function record_late(slot, task_id, m, a, code, kind, payload, now)
  redis.call('XADD', P .. 'late:' .. task_id, 'MAXLEN', '~', LATE_MAXLEN, '*',
    'kind', kind, 'slot', slot, 'attempt_id', a[3] or '', 'uuid', a[4] or '', 'epoch', a[5] or '',
    'conn_id', a[6] or '', 'reason', code, 'payload', payload or '', 't', now)
  -- Evidence lives as long as its message: open, or terminal plus retention.
  if m and m.state and not TERMINAL[m.state] then
    redis.call('PERSIST', P .. 'late:' .. task_id)
  else
    redis.call('PEXPIRE', P .. 'late:' .. task_id, RETAIN_MS)
  end
  if m and m.state then
    redis.call('HINCRBY', mkey(task_id), 'late_count', 1)
    audit(task_id, m.state, m.state, 'slot:' .. slot, 'late_' .. kind .. ':' .. code, now)
    feed(task_id, 'late', now)
  end
end

-- The slot's adapter is gone (stopped or silent): fence it off and move what it
-- held to delivery_unknown. Queued tasks stay; the next registration decides.
local function abandon(slot, actor, why, now)
  redis.call('HSET', skey(slot), 'conn_id', '', 'busy', '1', 'inflight', '', 'inflight_attempt', '')
  for _, id in ipairs(redis.call('SMEMBERS', slot_open_key(slot))) do
    local m = hgetall(mkey(id))
    local st = m.state
    if st == 'emit_intent' or st == 'emitted' or st == 'acked'
        or st == 'reply_emit_intent' or st == 'reply_emitted' then
      transition(id, m, 'delivery_unknown', actor, why, now)
    elseif st == 'asked' or st == 'reply_committed' then
      transition(id, m, 'delivery_unknown', actor, 'asker_' .. why, now)
      redis.call('DEL', P .. 'claim:' .. id)
    end
  end
end

---------------------------------------------------------------------------------
-- Slot functions (first key: mctl:bridge:s:<slot>:slot)
---------------------------------------------------------------------------------

-- ARGV: slot, uuid, conn_id, pid, pid_start, cwd, stale_ms
-- A new registration takes epoch + 1 and invalidates everything the previous
-- context held: nothing it may have seen is handed to the new one.
local function register(keys, a)
  local slot, uuid, conn, pid, pid_start, cwd = a[1], a[2], a[3], a[4], a[5], a[6]
  local stale_ms = tonumber(a[7] or '30000')
  if not valid_slot(slot) or not valid_id(uuid) or not valid_id(conn) or keys[1] ~= skey(slot)
      or stale_ms == nil or stale_ms <= 0 then
    return no('bad_request')
  end
  local now = now_ms()
  local s = hgetall(skey(slot))
  local alive = s.conn_id and s.conn_id ~= '' and (now - tonumber(s.heartbeat or '0')) < stale_ms
  if alive and (s.pid ~= pid or s.pid_start ~= pid_start) then
    return no('slot_live', { pid = s.pid })
  end
  local epoch = tostring(tonumber(s.epoch or '0') + 1)
  local actor = 'slot:' .. slot
  for _, id in ipairs(redis.call('SMEMBERS', slot_open_key(slot))) do
    local m = hgetall(mkey(id))
    local st = m.state
    if st == nil then
      redis.call('SREM', slot_open_key(slot), id)
    elseif m.kind == 'task' and st == 'queued' then
      transition(id, m, 'cancelled', actor, 'addressee_changed', now)
    elseif st == 'emit_intent' or st == 'emitted' or st == 'acked'
        or st == 'reply_emit_intent' or st == 'reply_emitted' then
      transition(id, m, 'delivery_unknown', actor, 'epoch_changed', now)
    elseif st == 'asked' or st == 'reply_committed' then
      transition(id, m, 'delivery_unknown', actor, 'asker_context_reset', now)
      redis.call('DEL', P .. 'claim:' .. id)
    end
  end
  redis.call('HSET', skey(slot), 'slot', slot, 'uuid', uuid, 'conn_id', conn, 'epoch', epoch,
    'pid', pid or '', 'pid_start', pid_start or '', 'cwd', cwd or '', 'heartbeat', now,
    'busy', '1', 'inflight', '', 'inflight_attempt', '', 'registered_ms', now)
  redis.call('SADD', P .. 'slots', slot)
  feed(slot, 'registered', now)
  return ok({ epoch = epoch })
end

-- ARGV: slot, conn_id, epoch, busy (0|1)
local function heartbeat(keys, a)
  local slot, conn, epoch, busy = a[1], a[2], a[3], a[4]
  if not valid_slot(slot) or keys[1] ~= skey(slot) then return no('bad_request') end
  local s = hgetall(skey(slot))
  if fenced(s, conn, epoch) then return no('fenced') end
  redis.call('HSET', skey(slot), 'heartbeat', now_ms(), 'busy', busy == '0' and '0' or '1')
  return ok()
end

-- ARGV: slot, conn_id, epoch
local function unregister(keys, a)
  local slot, conn, epoch = a[1], a[2], a[3]
  if not valid_slot(slot) or keys[1] ~= skey(slot) then return no('bad_request') end
  local s = hgetall(skey(slot))
  -- Fencing first: an old adapter must never touch a newer registration.
  if fenced(s, conn, epoch) then return no('fenced') end
  local now = now_ms()
  abandon(slot, 'slot:' .. slot, 'unregistered', now)
  redis.call('HSET', skey(slot), 'heartbeat', 0)
  feed(slot, 'unregistered', now)
  return ok()
end

-- emit_intent. ARGV: slot, conn_id, epoch, new_attempt_id
-- Picks the first message this slot may receive now and records the intent to
-- write it to stdio. The inflight rule: a new task only when nothing is in
-- flight; while a task is in flight, only the reply to that task's own question.
local function next_message(keys, a)
  local slot, conn, epoch, attempt = a[1], a[2], a[3], a[4]
  if not valid_slot(slot) or keys[1] ~= skey(slot) or not valid_id(attempt) then
    return no('bad_request')
  end
  local s = hgetall(skey(slot))
  if fenced(s, conn, epoch) then return no('fenced') end
  if s.busy ~= '0' then return no('busy') end
  local now = now_ms()
  local actor = 'slot:' .. slot
  local inflight = s.inflight or ''
  for _, id in ipairs(redis.call('ZRANGE', ready_key(slot), 0, -1)) do
    local m = hgetall(mkey(id))
    if m.state == nil then
      redis.call('ZREM', ready_key(slot), id)
    elseif m.kind == 'task' and m.state == 'queued' then
      if inflight == '' then
        if m.uuid ~= s.uuid or m.epoch ~= s.epoch then
          transition(id, m, 'cancelled', actor, 'addressee_changed', now)
        else
          transition(id, m, 'emit_intent', actor, '', now,
            { attempt_id = attempt, emit_epoch = epoch, emit_conn = conn })
          redis.call('ZREM', ready_key(slot), id)
          redis.call('HSET', skey(slot), 'inflight', id, 'inflight_attempt', attempt)
          return ok({ id = id, kind = 'task', attempt_id = attempt, payload = m.payload, hop = m.hop })
        end
      end
    elseif m.kind == 'question' and m.state == 'reply_committed' then
      -- The reply continues the asking attempt: its attempt_id is kept, not replaced.
      if inflight ~= '' and m.task_id == inflight and m.attempt_id == s.inflight_attempt
          and m.epoch == s.epoch then
        transition(id, m, 'reply_emit_intent', actor, '', now, { emit_epoch = epoch, emit_conn = conn })
        redis.call('ZREM', ready_key(slot), id)
        return ok({ id = id, kind = 'reply', reply_id = m.reply_id, payload = m.reply,
          question = m.payload, task_id = m.task_id, attempt_id = m.attempt_id })
      end
    else
      redis.call('ZREM', ready_key(slot), id)
    end
  end
  return no('empty')
end

-- ARGV: slot, conn_id, epoch, id
local function mark_emitted(keys, a)
  local slot, conn, epoch, id = a[1], a[2], a[3], a[4]
  if not valid_slot(slot) or keys[1] ~= skey(slot) or not valid_id(id) then return no('bad_request') end
  local s = hgetall(skey(slot))
  if fenced(s, conn, epoch) then return no('fenced') end
  local m = hgetall(mkey(id))
  if m.slot ~= slot or m.emit_epoch ~= epoch or m.emit_conn ~= conn then return no('not_mine') end
  local now = now_ms()
  if m.state == 'emit_intent' then
    transition(id, m, 'emitted', 'slot:' .. slot, '', now)
  elseif m.state == 'reply_emit_intent' then
    transition(id, m, 'reply_emitted', 'slot:' .. slot, '', now)
  else
    return no('wrong_state', { state = m.state })
  end
  return ok()
end

-- ARGV: slot, conn_id, epoch
-- The adapter lost the reply to its own `next`: the server may have recorded an
-- emit_intent the model never saw. Whatever this connection holds in emit_intent
-- or reply_emit_intent becomes delivery_unknown (never re-sent), and a task frees
-- inflight so the queue moves on. Idempotent; finds nothing if `next` never ran.
local function emit_lost(keys, a)
  local slot, conn, epoch = a[1], a[2], a[3]
  if not valid_slot(slot) or keys[1] ~= skey(slot) then return no('bad_request') end
  local s = hgetall(skey(slot))
  if fenced(s, conn, epoch) then return no('fenced') end
  local now = now_ms()
  local settled = 0
  for _, id in ipairs(redis.call('SMEMBERS', slot_open_key(slot))) do
    local m = hgetall(mkey(id))
    if (m.state == 'emit_intent' or m.state == 'reply_emit_intent')
        and m.emit_conn == conn and m.emit_epoch == epoch then
      transition(id, m, 'delivery_unknown', 'slot:' .. slot, 'emit_reply_lost', now)
      if m.kind == 'task' then clear_inflight(slot, id) end
      settled = settled + 1
    end
  end
  return ok({ settled = settled })
end

-- ack_task. ARGV: slot, conn_id, epoch, task_id, attempt_id
-- Returns the admission that report_result and ask_orchestrator require.
local function ack_task(keys, a)
  local slot, conn, epoch, id, attempt = a[1], a[2], a[3], a[4], a[5]
  if not valid_slot(slot) or keys[1] ~= skey(slot) or not valid_id(id) then return no('bad_request') end
  local s = hgetall(skey(slot))
  if fenced(s, conn, epoch) then return no('fenced') end
  local m = hgetall(mkey(id))
  if m.kind ~= 'task' or m.slot ~= slot then return no('unknown_task') end
  if m.attempt_id ~= attempt or m.emit_epoch ~= epoch or m.emit_conn ~= conn then
    return no('attempt_mismatch')
  end
  -- An ack proves delivery, so it may overtake mark_emitted.
  if m.state ~= 'emitted' and m.state ~= 'emit_intent' then return no('wrong_state', { state = m.state }) end
  local now = now_ms()
  transition(id, m, 'acked', 'slot:' .. slot, '', now)
  feed(id, 'acked', now)
  return ok({ admission = { task_id = id, attempt_id = attempt, uuid = s.uuid, epoch = epoch, conn_id = conn } })
end

-- ack of a reply. ARGV: slot, conn_id, epoch, question_id, reply_id
local function ack_reply(keys, a)
  local slot, conn, epoch, id, reply_id = a[1], a[2], a[3], a[4], a[5]
  if not valid_slot(slot) or keys[1] ~= skey(slot) or not valid_id(id) then return no('bad_request') end
  local s = hgetall(skey(slot))
  if fenced(s, conn, epoch) then return no('fenced') end
  local m = hgetall(mkey(id))
  if m.kind ~= 'question' or m.slot ~= slot then return no('unknown_question') end
  if m.reply_id ~= reply_id or m.emit_epoch ~= epoch or m.emit_conn ~= conn then
    return no('reply_mismatch')
  end
  if m.state ~= 'reply_emitted' and m.state ~= 'reply_emit_intent' then
    return no('wrong_state', { state = m.state })
  end
  local now = now_ms()
  transition(id, m, 'reply_acknowledged', 'slot:' .. slot, '', now)
  redis.call('HDEL', mkey(m.task_id), 'open_question')
  feed(id, 'reply_acknowledged', now)
  return ok({ task_id = m.task_id, attempt_id = m.attempt_id })
end

-- report_result. ARGV: slot, task_id, attempt_id, uuid, epoch, conn_id, status, payload
local function report_result(keys, a)
  local slot, status, payload = a[1], a[7], a[8]
  if not valid_slot(slot) or keys[1] ~= skey(slot) then return no('bad_request') end
  if (status ~= 'completed' and status ~= 'failed') or not valid_payload(payload) then
    return no('bad_request')
  end
  local now = now_ms()
  local s, m, code = admit(slot, a)
  if code then
    if code ~= 'bad_request' and code ~= 'unknown_task' then
      record_late(slot, a[2], m, a, code, 'result', payload, now)
      return no(code, { late = true })
    end
    return no(code)
  end
  transition(a[2], m, status, 'slot:' .. slot, '', now, { result = payload })
  close_question(m, 'slot:' .. slot, 'task_finished', now)
  clear_inflight(slot, a[2])
  feed(a[2], 'result', now)
  return ok()
end

-- ask_orchestrator. ARGV: slot, task_id, attempt_id, uuid, epoch, conn_id,
-- question_id, payload, ttl_ms
-- Stores the question and returns at once; the slot ends its turn and the reply
-- arrives later as an event. The task stays in flight.
local function ask(keys, a)
  local slot, qid, payload, ttl = a[1], a[7], a[8], tonumber(a[9] or '0')
  if not valid_slot(slot) or keys[1] ~= skey(slot) or not valid_id(qid) or not valid_payload(payload)
      or ttl == nil or ttl < 0 then
    return no('bad_request')
  end
  local now = now_ms()
  local s, m, code = admit(slot, a)
  if code then
    if code ~= 'bad_request' and code ~= 'unknown_task' then
      record_late(slot, a[2], m, a, code, 'question', payload, now)
      return no(code, { late = true })
    end
    return no(code)
  end
  if m.open_question and m.open_question ~= '' then
    local st = redis.call('HGET', mkey(m.open_question), 'state')
    if st and not TERMINAL[st] then return no('question_open', { question_id = m.open_question }) end
  end
  local hop = tonumber(m.hop or '0') + 1
  if hop > MAX_HOP then return no('hop_limit') end
  if redis.call('EXISTS', mkey(qid)) == 1 then return no('duplicate_id') end
  redis.call('HSET', mkey(qid), 'kind', 'question', 'state', 'asked', 'slot', slot,
    'task_id', a[2], 'attempt_id', a[3], 'uuid', a[4], 'epoch', a[5], 'conn_id', a[6],
    'payload', payload, 'hop', hop, 'created_ms', now, 'updated_ms', now,
    'expires_ms', ttl > 0 and (now + ttl) or 0)
  audit(qid, '', 'asked', 'slot:' .. slot, '', now)
  redis.call('SADD', OPEN, qid)
  redis.call('SADD', slot_open_key(slot), qid)
  redis.call('ZADD', ASKED, redis.call('INCR', SEQ), qid)
  redis.call('HSET', mkey(a[2]), 'open_question', qid)
  feed(qid, 'asked', now)
  return ok({ question_id = qid })
end

-- ARGV: slot. The slot's own registration, as the adapter's bridge_status shows it.
local function slot_status(keys, a)
  local slot = a[1]
  if not valid_slot(slot) or keys[1] ~= skey(slot) then return no('bad_request') end
  local s = hgetall(skey(slot))
  return ok({ epoch = s.epoch or '', conn_id = s.conn_id or '', uuid = s.uuid or '',
    inflight = s.inflight or '', inflight_attempt = s.inflight_attempt or '', busy = s.busy or '' })
end

---------------------------------------------------------------------------------
-- Orchestrator functions (first key: mctl:bridge:orch)
---------------------------------------------------------------------------------

local ORCH = P .. 'orch'

-- ARGV: id, slot, payload, hop, ttl_ms, idempotency_key
local function send(keys, a)
  local id, slot, payload, hop, ttl, idem = a[1], a[2], a[3], tonumber(a[4] or '0'), tonumber(a[5] or '0'), a[6] or ''
  if keys[1] ~= ORCH or not valid_id(id) or not valid_slot(slot) or not valid_payload(payload)
      or (idem ~= '' and not valid_id(idem)) or hop == nil or ttl == nil then
    return no('bad_request')
  end
  if idem ~= '' then
    local existing = redis.call('GET', P .. 'dedup:' .. idem)
    if existing then return ok({ id = existing, dedup = true }) end
  end
  if hop > MAX_HOP then return no('hop_limit') end
  local s = hgetall(skey(slot))
  if s.conn_id == nil or s.conn_id == '' then return no('slot_not_registered') end
  if redis.call('EXISTS', mkey(id)) == 1 then return no('duplicate_id') end
  local now = now_ms()
  redis.call('HSET', mkey(id), 'kind', 'task', 'state', 'queued', 'slot', slot, 'uuid', s.uuid,
    'epoch', s.epoch, 'payload', payload, 'hop', hop, 'idem', idem, 'created_ms', now,
    'updated_ms', now, 'expires_ms', ttl > 0 and (now + ttl) or 0)
  audit(id, '', 'queued', 'orch', '', now)
  redis.call('SADD', OPEN, id)
  redis.call('SADD', slot_open_key(slot), id)
  redis.call('ZADD', ready_key(slot), redis.call('INCR', SEQ), id)
  if idem ~= '' then redis.call('SET', P .. 'dedup:' .. idem, id) end
  ring(slot, id, now)
  return ok({ id = id, epoch = s.epoch })
end

-- ARGV: question_id, claim_token, lease_ms
local function claim(keys, a)
  local qid, token, lease = a[1], a[2], tonumber(a[3] or '0')
  if keys[1] ~= ORCH or not valid_id(qid) or not valid_id(token) or not lease or lease <= 0 then
    return no('bad_request')
  end
  local st = redis.call('HGET', mkey(qid), 'state')
  if st ~= 'asked' then return no('not_asked', { state = st or '' }) end
  if not redis.call('SET', P .. 'claim:' .. qid, token, 'NX', 'PX', lease) then return no('claimed') end
  audit(qid, st, st, 'orch', 'claimed', now_ms())
  return ok({ question_id = qid, claim_token = token })
end

-- ARGV: question_id, claim_token, lease_ms
local function renew(keys, a)
  local qid, token, lease = a[1], a[2], tonumber(a[3] or '0')
  if keys[1] ~= ORCH or not valid_id(qid) or not lease or lease <= 0 then return no('bad_request') end
  if redis.call('GET', P .. 'claim:' .. qid) ~= token then return no('not_owner') end
  redis.call('PEXPIRE', P .. 'claim:' .. qid, lease)
  return ok()
end

-- ARGV: question_id, claim_token, reply_id, payload
-- Commits the one authoritative reply. It does not claim the slot has it.
local function reply(keys, a)
  local qid, token, reply_id, payload = a[1], a[2], a[3], a[4]
  if keys[1] ~= ORCH or not valid_id(qid) or not valid_id(reply_id) or not valid_payload(payload) then
    return no('bad_request')
  end
  if redis.call('GET', P .. 'claim:' .. qid) ~= token then return no('not_owner') end
  local m = hgetall(mkey(qid))
  if m.state ~= 'asked' then return no('not_asked', { state = m.state or '' }) end
  local now = now_ms()
  transition(qid, m, 'reply_committed', 'orch', '', now,
    { reply_id = reply_id, reply = payload, replied_ms = now, reply_by = 'orch' })
  redis.call('ZREM', ASKED, qid)
  redis.call('ZADD', ready_key(m.slot), redis.call('INCR', SEQ), qid)
  redis.call('DEL', P .. 'claim:' .. qid)
  ring(m.slot, qid, now)
  return ok({ question_id = qid, reply_id = reply_id })
end

-- ARGV: id, as, reason, author
-- The manual way out of delivery_unknown (and of anything not yet terminal).
-- requeue readdresses a task to the slot's current registration as a new attempt.
local function resolve(keys, a)
  local id, as, reason, author, force = a[1], a[2], a[3] or '', a[4] or '', a[5] == '1'
  if keys[1] ~= ORCH or not valid_id(id) or reason == '' or author == '' then return no('bad_request') end
  local m = hgetall(mkey(id))
  if m.state == nil then return no('unknown') end
  local now = now_ms()
  local actor = 'resolve:' .. author
  if as == 'requeue' then
    if m.state ~= 'delivery_unknown' and m.state ~= 'cancelled' then
      return no('wrong_state', { state = m.state })
    end
    -- Evidence that an earlier attempt already acted must be looked at first.
    if tonumber(m.late_count or '0') > 0 and not force then
      return no('late_evidence', { late_count = tonumber(m.late_count) })
    end
    local s = hgetall(skey(m.slot))
    if s.conn_id == nil or s.conn_id == '' then return no('slot_not_registered') end
    if m.kind == 'task' then
      redis.call('PERSIST', mkey(id))
      redis.call('PERSIST', P .. 'audit:' .. id)
      redis.call('PERSIST', P .. 'late:' .. id)
      if m.idem and m.idem ~= '' then redis.call('PERSIST', P .. 'dedup:' .. m.idem) end
      redis.call('HDEL', mkey(id), 'attempt_id', 'emit_epoch', 'emit_conn', 'open_question')
      transition(id, m, 'queued', actor, reason, now, { uuid = s.uuid, epoch = s.epoch })
      redis.call('SADD', OPEN, id)
      redis.call('SADD', slot_open_key(m.slot), id)
      redis.call('ZADD', ready_key(m.slot), redis.call('INCR', SEQ), id)
      ring(m.slot, id, now)
      return ok({ id = id, state = 'queued' })
    end
    -- A question can only go back to a context that still holds its task.
    if m.epoch ~= s.epoch or s.inflight ~= m.task_id then return no('asker_gone') end
    if m.reply_id and m.reply_id ~= '' then
      transition(id, m, 'reply_committed', actor, reason, now)
      redis.call('ZADD', ready_key(m.slot), redis.call('INCR', SEQ), id)
      ring(m.slot, id, now)
    else
      transition(id, m, 'asked', actor, reason, now)
      redis.call('ZADD', ASKED, redis.call('INCR', SEQ), id)
      feed(id, 'asked', now)
    end
    return ok({ id = id, state = m.state })
  end
  if TERMINAL[m.state] then return no('terminal', { state = m.state }) end
  local target
  if m.kind == 'task' and (as == 'completed' or as == 'failed' or as == 'cancelled') then
    target = as
  elseif m.kind == 'question' and as == 'closed' then
    -- While the asking attempt still holds inflight, closing the question would
    -- leave that task waiting for a reply that never comes, and the slot wedged.
    -- The operator ends the task instead; that closes the question with it.
    if m.state ~= 'delivery_unknown' then
      local s = hgetall(skey(m.slot))
      if s.inflight == m.task_id and s.inflight_attempt == m.attempt_id then
        return no('task_waiting', { task_id = m.task_id,
          hint = 'resolve the task instead: mctl-bridge resolve ' .. m.task_id .. ' --as failed|cancelled --reason ...' })
      end
    end
    target = 'closed'
  else
    return no('bad_request')
  end
  transition(id, m, target, actor, reason, now)
  if m.kind == 'task' then
    close_question(m, actor, 'task_resolved', now)
    clear_inflight(m.slot, id)
  end
  if m.kind == 'question' then redis.call('DEL', P .. 'claim:' .. id) end
  return ok({ id = id, state = target })
end

---------------------------------------------------------------------------------
-- Ingest (orchestrator role): the only way a slot's request changes state.
---------------------------------------------------------------------------------

local MAX_REQUEST = 40000
local MAX_ARGS = 16
local RESP_MAXLEN = 10000
local SLOT_FN = {
  register = register, heartbeat = heartbeat, unregister = unregister, next = next_message,
  emitted = mark_emitted, emit_lost = emit_lost, ack_task = ack_task, ack_reply = ack_reply,
  result = report_result, ask = ask, status = slot_status,
}

-- A slot polls every few seconds and heartbeats every ten, so a week of these memos filled
-- the server (150 of 256 MB by 2026-11-06, with noeviction). They answer nothing a later
-- run could not answer again. A delivered message and every other request keep the full
-- retention: their memo is what stops a retry from acting twice.
local function memo_ms(fn, resp)
  if fn == 'heartbeat' and resp == ok() then return QUIET_MEMO_MS end
  if fn == 'next' and (resp == no('empty') or resp == no('busy')) then return QUIET_MEMO_MS end
  return RETAIN_MS
end

local function out_key(slot) return P .. 's:' .. slot .. ':out' end
local function resp_key(slot) return P .. 's:' .. slot .. ':resp' end
local function checkpoint_key(slot) return P .. 'ingest:' .. slot end

-- Stream ids are '<ms>-<seq>'; -1, 0, 1.
local function id_cmp(x, y)
  local xm, xs = x:match('^(%d+)%-(%d+)$')
  local ym, ys = y:match('^(%d+)%-(%d+)$')
  xm, xs, ym, ys = tonumber(xm), tonumber(xs), tonumber(ym), tonumber(ys)
  if xm ~= ym then return xm < ym and -1 or 1 end
  if xs ~= ys then return xs < ys and -1 or 1 end
  return 0
end

local function valid_entry(s) return type(s) == 'string' and s:match('^%d+%-%d+$') ~= nil end

-- Done with an entry: advance the checkpoint and drop what is behind it.
local function checkpoint(slot, entry)
  redis.call('SET', checkpoint_key(slot), entry)
  redis.call('XTRIM', out_key(slot), 'MINID', entry)
  redis.call('XDEL', out_key(slot), entry)
end

-- An entry that cannot be applied is recorded once, keyed by slot and entry id, and
-- skipped. Its request id is not remembered: a forged id must not stand in the way of
-- a later valid request that carries the same one.
local function ingest_reject(slot, entry, rid, fn, reason, now)
  redis.call('XADD', P .. 'rejected:' .. slot, 'MAXLEN', '~', 1000, '*',
    'entry', entry, 'rid', rid or '', 'fn', fn or '', 'reason', reason, 't', now)
  redis.call('XADD', AUDIT, 'MAXLEN', '~', AUDIT_MAXLEN, '*',
    'id', 'ingest:' .. slot, 'from', '', 'to', 'rejected', 'actor', 'slot:' .. slot,
    'reason', reason .. ':' .. entry, 't', now)
  local body = no('rejected', { reason = reason })
  if valid_id(rid) then
    redis.call('XADD', resp_key(slot), 'MAXLEN', '~', RESP_MAXLEN, '*', 'rid', rid, 'resp', body)
  end
  checkpoint(slot, entry)
  return body
end

-- ARGV: slot, entry_id, rid, fn, args_json
local function ingest(keys, a)
  local slot, entry, rid, fn, raw = a[1], a[2], a[3], a[4], a[5]
  if keys[1] ~= ORCH or not valid_slot(slot) or not valid_entry(entry) then return no('bad_request') end
  local now = now_ms()
  if id_cmp(entry, redis.call('GET', checkpoint_key(slot)) or '0-0') <= 0 then
    return ok({ skipped = true })
  end
  if not valid_id(rid) then return ingest_reject(slot, entry, nil, fn, 'bad_rid', now) end
  if type(raw) ~= 'string' or #raw > MAX_REQUEST then return ingest_reject(slot, entry, rid, fn, 'too_large', now) end
  local memo = P .. 'rpc:' .. slot .. ':' .. rid
  local seen = redis.call('HMGET', memo, 'fn', 'args', 'resp')
  local resp
  if seen[3] then
    -- A retry returns the stored answer. The same id for another request is refused.
    if seen[1] ~= fn or seen[2] ~= raw then return ingest_reject(slot, entry, rid, fn, 'rid_conflict', now) end
    resp = seen[3]
  else
    local handler = SLOT_FN[fn]
    if handler == nil then return ingest_reject(slot, entry, rid, fn, 'unknown_fn', now) end
    local okd, args = pcall(cjson.decode, raw)
    if not okd or type(args) ~= 'table' or #args > MAX_ARGS then
      return ingest_reject(slot, entry, rid, fn, 'bad_args', now)
    end
    local call = { slot }
    for i = 1, #args do
      if type(args[i]) ~= 'string' then return ingest_reject(slot, entry, rid, fn, 'bad_args', now) end
      call[#call + 1] = args[i]
    end
    resp = handler({ skey(slot) }, call)
    redis.call('HSET', memo, 'fn', fn, 'args', raw, 'resp', resp, 'entry', entry, 't', now)
    redis.call('PEXPIRE', memo, memo_ms(fn, resp))
  end
  redis.call('XADD', resp_key(slot), 'MAXLEN', '~', RESP_MAXLEN, '*', 'rid', rid, 'resp', resp)
  checkpoint(slot, entry)
  return ok({ applied = true })
end

-- ARGV: slot, entry_id, reason, rid, fn, args_json. For an entry whose handling raised
-- an error. Valkey functions do not roll back writes made before the error, so the
-- failing handler must never run again for this request id: when the id is valid and has
-- no memo yet, the rejection becomes the stored answer (same memo as a normal one), goes
-- to the slot's response stream, and a retry of the same request returns it. A retry that
-- carries another request under the same id is still a rid_conflict.
local function ingest_poison(keys, a)
  local slot, entry, reason = a[1], a[2], a[3] or 'handler_error'
  local rid, fn, raw = a[4], a[5], a[6]
  if keys[1] ~= ORCH or not valid_slot(slot) or not valid_entry(entry) then return no('bad_request') end
  if id_cmp(entry, redis.call('GET', checkpoint_key(slot)) or '0-0') <= 0 then return ok({ skipped = true }) end
  local now = now_ms()
  if not valid_id(rid) or type(fn) ~= 'string' or type(raw) ~= 'string' or MAX_REQUEST < #raw then
    ingest_reject(slot, entry, nil, nil, reason, now)
    return ok()
  end
  local memo = P .. 'rpc:' .. slot .. ':' .. rid
  local seen = redis.call('HMGET', memo, 'fn', 'args', 'resp')
  if seen[3] then
    if seen[1] ~= fn or seen[2] ~= raw then
      ingest_reject(slot, entry, rid, fn, 'rid_conflict', now)
    else
      redis.call('XADD', resp_key(slot), 'MAXLEN', '~', RESP_MAXLEN, '*', 'rid', rid, 'resp', seen[3])
      checkpoint(slot, entry)
    end
    return ok()
  end
  -- Record the entry (rejected stream and audit) without a second answer, then memoize.
  local body = no('rejected', { reason = reason })
  redis.call('HSET', memo, 'fn', fn, 'args', raw, 'resp', body, 'entry', entry, 't', now)
  redis.call('PEXPIRE', memo, RETAIN_MS)
  ingest_reject(slot, entry, rid, fn, reason, now)
  return ok()
end

---------------------------------------------------------------------------------
-- Sweeper (orchestrator role)
---------------------------------------------------------------------------------

-- ARGV: id. Expiry is an explicit transition, and only for messages no slot has
-- seen: anything already handed to stdio stays for the operator.
local function expire(keys, a)
  local id = a[1]
  if keys[1] ~= ORCH or not valid_id(id) then return no('bad_request') end
  local m = hgetall(mkey(id))
  if m.state == nil then return no('unknown') end
  local exp = tonumber(m.expires_ms or '0')
  local now = now_ms()
  if exp <= 0 or now < exp then return ok({ expired = false }) end
  if m.kind == 'task' and m.state == 'queued' then
    transition(id, m, 'expired', 'sweeper', 'expires_at', now)
    return ok({ expired = true })
  end
  -- The asking task is waiting with its turn ended; silence would wedge the slot.
  -- It gets a system reply instead, delivered like any reply, so it can go on.
  if m.kind == 'question' and m.state == 'asked' then
    transition(id, m, 'reply_committed', 'sweeper', 'expires_at', now,
      { reply_id = 'r-expired-' .. id, reply = EXPIRED_REPLY, replied_ms = now, reply_by = 'system' })
    redis.call('ZREM', ASKED, id)
    redis.call('DEL', P .. 'claim:' .. id)
    redis.call('ZADD', ready_key(m.slot), redis.call('INCR', SEQ), id)
    ring(m.slot, id, now)
    feed(id, 'question_expired', now)
    return ok({ expired = true })
  end
  return ok({ expired = false })
end

-- ARGV: slot, stale_ms. A slot whose heartbeat stopped is fenced off, and what it
-- held becomes delivery_unknown.
local function slot_stale(keys, a)
  local slot, stale_ms = a[1], tonumber(a[2] or '0')
  if keys[1] ~= ORCH or not valid_slot(slot) or not stale_ms or stale_ms <= 0 then return no('bad_request') end
  local s = hgetall(skey(slot))
  local now = now_ms()
  if s.conn_id == nil or s.conn_id == '' or (now - tonumber(s.heartbeat or '0')) < stale_ms then
    return ok({ stale = false })
  end
  abandon(slot, 'sweeper', 'heartbeat_lost', now)
  feed(slot, 'stale', now)
  return ok({ stale = true })
end

-- ARGV: id. Recovery driven by the open index, independent of streams: puts a
-- message that may be handed out back into its queue, drops dangling ids.
local function repair(keys, a)
  local id = a[1]
  if keys[1] ~= ORCH or not valid_id(id) then return no('bad_request') end
  local m = hgetall(mkey(id))
  if m.state == nil then
    redis.call('SREM', OPEN, id)
    return ok({ action = 'dropped' })
  end
  if TERMINAL[m.state] then
    redis.call('SREM', OPEN, id)
    redis.call('SREM', slot_open_key(m.slot), id)
    return ok({ action = 'closed' })
  end
  local action = 'none'
  redis.call('SADD', slot_open_key(m.slot), id)
  if (m.kind == 'task' and m.state == 'queued') or (m.kind == 'question' and m.state == 'reply_committed') then
    if not redis.call('ZSCORE', ready_key(m.slot), id) then
      redis.call('ZADD', ready_key(m.slot), redis.call('INCR', SEQ), id)
      ring(m.slot, id, now_ms())
      action = 'requeued'
    end
  elseif m.kind == 'question' and m.state == 'asked' then
    if not redis.call('ZSCORE', ASKED, id) then
      redis.call('ZADD', ASKED, redis.call('INCR', SEQ), id)
      action = 'requeued'
    end
  end
  return ok({ action = action })
end

---------------------------------------------------------------------------------
-- Wakes (orchestrator role). A wake is the waker's attempt to start a turn in the
-- orchestrator thread for one question. It never answers; the turn has to claim.
-- States: intent -> started -> completed, intent -> failed (the app server refused
-- turn/start outright), and wake_unknown, which stays open until resolved.
---------------------------------------------------------------------------------

local WAKES = P .. 'wakes'
local WAKE_OPEN = { intent = true, started = true, wake_unknown = true }
local function wkey(id) return P .. 'wake:' .. id end
local function lock_key(thread) return P .. 'wakelock:' .. thread end

local function wake_move(id, w, to, reason, now, fields)
  local args = { 'state', to, 'updated_ms', now, 'reason', reason or '' }
  if fields then
    for k, v in pairs(fields) do
      args[#args + 1] = k
      args[#args + 1] = v
    end
  end
  redis.call('HSET', wkey(id), unpack(args))
  audit(id, w.state, to, 'waker', reason, now)
  if w.question_id then audit(w.question_id, 'wake', 'wake', 'waker', 'wake_' .. to .. ':' .. id, now) end
  if not WAKE_OPEN[to] then
    redis.call('SREM', WAKES, id)
    redis.call('PEXPIRE', wkey(id), RETAIN_MS)
    redis.call('PEXPIRE', P .. 'audit:' .. id, RETAIN_MS)
  end
  feed(id, 'wake_' .. to, now)
  w.state = to
end

-- The lock goes only when this wake holds it; an unknown wake keeps it until PX.
local function release(w, id)
  if redis.call('GET', lock_key(w.thread_id)) == id then redis.call('DEL', lock_key(w.thread_id)) end
end

-- ARGV: question_id, thread_id, wake_id, lock_ms, per_hour, quiet_ms, per_question
-- One call decides everything before any RPC: the question still waits unclaimed
-- and long enough, it has no wake in progress or unresolved, the thread is free
-- (wakelock NX) and the hourly budget allows it.
local function wake_begin(keys, a)
  local qid, thread, id = a[1], a[2], a[3]
  local lock_ms, per_hour, quiet_ms, per_q = tonumber(a[4] or ''), tonumber(a[5] or ''), tonumber(a[6] or ''), tonumber(a[7] or '')
  if keys[1] ~= ORCH or not valid_id(qid) or not valid_id(thread) or not valid_id(id)
      or not lock_ms or lock_ms <= 0 or not per_hour or per_hour < 0 or not quiet_ms or quiet_ms < 0
      or not per_q or per_q < 1 then
    return no('bad_request')
  end
  local q = hgetall(mkey(qid))
  if q.kind ~= 'question' or q.state ~= 'asked' then return no('not_asked', { state = q.state }) end
  if redis.call('EXISTS', P .. 'claim:' .. qid) == 1 then return no('claimed') end
  local now = now_ms()
  -- The quiet period runs from the later of the question and its last wake, so a
  -- second wake waits as long after the first turn ended as the first did.
  local since = tonumber(q.updated_ms or q.created_ms or '0')
  if q.wake_id and q.wake_id ~= '' then
    local prev = redis.call('HMGET', wkey(q.wake_id), 'state', 'updated_ms')
    if prev[1] and WAKE_OPEN[prev[1]] then return no('woken', { wake_id = q.wake_id, state = prev[1] }) end
    since = math.max(since, tonumber(prev[2] or '0') or 0)
  end
  if now - since < quiet_ms then return no('too_early') end
  if tonumber(q.wakes or '0') >= per_q then return no('question_wake_limit') end
  if redis.call('EXISTS', wkey(id)) == 1 then return no('duplicate_id') end
  local holder = redis.call('GET', lock_key(thread))
  if holder then return no('thread_busy', { wake_id = holder }) end
  local bucket = P .. 'wakes:hour:' .. math.floor(now / 3600000)
  if tonumber(redis.call('GET', bucket) or '0') >= per_hour then return no('rate_limited') end
  redis.call('INCR', bucket)
  redis.call('PEXPIRE', bucket, 2 * 3600000)
  redis.call('SET', lock_key(thread), id, 'PX', lock_ms)
  redis.call('HSET', wkey(id), 'question_id', qid, 'thread_id', thread, 'state', 'intent',
    'created_ms', now, 'updated_ms', now, 'turn_id', '', 'reason', '')
  redis.call('SADD', WAKES, id)
  redis.call('HSET', mkey(qid), 'wake_id', id)
  redis.call('HINCRBY', mkey(qid), 'wakes', 1)
  audit(id, '', 'intent', 'waker', qid, now)
  audit(qid, 'wake', 'wake', 'waker', 'wake_intent:' .. id, now)
  feed(id, 'wake_intent', now)
  return ok({ wake_id = id })
end

-- ARGV: wake_id, turn_id
local function wake_started(keys, a)
  local id, turn = a[1], a[2]
  if keys[1] ~= ORCH or not valid_id(id) or not valid_id(turn) then return no('bad_request') end
  local w = hgetall(wkey(id))
  if w.state == nil then return no('unknown') end
  if w.state ~= 'intent' then return no('wrong_state', { state = w.state }) end
  wake_move(id, w, 'started', '', now_ms(), { turn_id = turn })
  return ok()
end

-- ARGV: wake_id, outcome (completed|failed|wake_unknown), reason
local function wake_finish(keys, a)
  local id, outcome, reason = a[1], a[2], a[3] or ''
  if keys[1] ~= ORCH or not valid_id(id) then return no('bad_request') end
  local w = hgetall(wkey(id))
  if w.state == nil then return no('unknown') end
  local from_ok = (outcome == 'completed' and w.state == 'started')
    or (outcome == 'failed' and w.state == 'intent')
    or (outcome == 'wake_unknown' and (w.state == 'intent' or w.state == 'started'))
  if not from_ok then return no('wrong_state', { state = w.state }) end
  wake_move(id, w, outcome, reason, now_ms())
  if outcome ~= 'wake_unknown' then release(w, id) end
  return ok()
end

-- ARGV: wake_id, reason, author. The way out of wake_unknown, after a look at the thread.
local function wake_resolve(keys, a)
  local id, reason, author = a[1], a[2] or '', a[3] or ''
  if keys[1] ~= ORCH or not valid_id(id) or reason == '' or author == '' then return no('bad_request') end
  local w = hgetall(wkey(id))
  if w.state == nil then return no('unknown') end
  if not WAKE_OPEN[w.state] then return no('wrong_state', { state = w.state }) end
  wake_move(id, w, 'resolved', 'resolve:' .. author .. ':' .. reason, now_ms())
  release(w, id)
  return ok()
end

local function version() return VERSION end

local function reg(name, fn, ro)
  redis.register_function({
    function_name = name,
    callback = fn,
    flags = ro and { 'no-writes' } or {},
  })
end

reg('bridge_version', version, true)
reg('bridge_register', register)
reg('bridge_heartbeat', heartbeat)
reg('bridge_unregister', unregister)
reg('bridge_next', next_message)
reg('bridge_emitted', mark_emitted)
reg('bridge_emit_lost', emit_lost)
reg('bridge_ack_task', ack_task)
reg('bridge_ack_reply', ack_reply)
reg('bridge_result', report_result)
reg('bridge_ask', ask)
reg('bridge_ingest', ingest)
reg('bridge_ingest_poison', ingest_poison)
reg('bridge_send', send)
reg('bridge_claim', claim)
reg('bridge_renew', renew)
reg('bridge_reply', reply)
reg('bridge_resolve', resolve)
reg('bridge_expire', expire)
reg('bridge_slot_stale', slot_stale)
reg('bridge_repair', repair)
reg('bridge_wake_begin', wake_begin)
reg('bridge_wake_started', wake_started)
reg('bridge_wake_finish', wake_finish)
reg('bridge_wake_resolve', wake_resolve)
