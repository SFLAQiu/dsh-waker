'use strict';
/*
 * dsh-waker bridge v4 — DingTalk Stream 多机器人桥接
 *
 * 零 npm 依赖（Node >= 22 原生 fetch / WebSocket / http）。
 * v4 架构（R2 多机器人）：每个 robotId 一条独立 Stream 连接（sessions Map），
 *   插件通过 stdin `robots-config` 下发期望态（全量 diff），桥接负责连接/断开/重连。
 * 协议时序与官方 dingtalk-stream SDK 对齐：
 *   1. POST /v1.0/gateway/connections/open  -> { endpoint, ticket }
 *   2. WebSocket endpoint?ticket=xxx
 *   3. SYSTEM ping -> 回 { code:200, headers, message:'OK', data }
 *   4. CALLBACK (机器人消息) -> stdout 事件（带 robotId）+ socketAck 防重推
 *
 * 与插件的两条通道（Desktop webServer 有渲染进程围栏，外部进程无法回调，故不用 HTTP）：
 *   stdout JSONL       : ready / status / log / event   （bridge -> plugin）
 *   stdin  JSONL       : robots-config / config(legacy) / reconnect / reconnect-robot / reply / webhooks / shutdown
 *   HTTP  127.0.0.1    : GET /health（人工诊断）、POST /rpc（人工诊断，需 x-waker-token）
 */

const http = require('node:http');
const fs = require('node:fs');

const GATEWAY_URL = 'https://api.dingtalk.com/v1.0/gateway/connections/open';
const TOPIC_ROBOT = '/v1.0/im/bot/messages/get';

const TOKEN = process.env.DTW_BRIDGE_TOKEN || '';
const ENV_CLIENT_ID = process.env.DTW_CLIENT_ID || '';
const ENV_CLIENT_SECRET = process.env.DTW_CLIENT_SECRET || '';
const PORT = Number(process.env.DTW_PORT || 0);

// 落盘诊断：回复链路（callback/reply）每次都追加 JSONL，便于脱离 stdout 排查
const DIAG_PATH = __dirname + '/diag.log';
const WEBHOOKS_PATH = __dirname + '/webhooks.json';
function diag(entry) {
  try { fs.appendFileSync(DIAG_PATH, JSON.stringify(Object.assign({ t: new Date().toISOString() }, entry)) + '\n'); } catch {}
}

function emit(obj) {
  try { process.stdout.write(JSON.stringify(obj) + '\n'); } catch {}
}
function log(msg) { emit({ type: 'log', msg: String(msg).slice(0, 500) }); }

// ---- 多机器人会话表 ----
// sessions: robotId -> { clientId, clientSecret, socket, endpoint, reconnectTimer,
//                        connecting, reconnectAttempts, phase, lastError }
const sessions = new Map();
const ROBOT_DEFAULT = 'robot-default';

function sessionPhase(robotId) {
  const s = sessions.get(robotId);
  return s ? (s.phase || 'disconnected') : 'absent';
}
function globalPhase() {
  if (!sessions.size) return 'no-robots';
  let connected = 0, errored = 0, connecting = 0;
  for (const s of sessions.values()) {
    if (s.phase === 'connected') connected++;
    else if (s.phase === 'error') errored++;
    else if (s.phase === 'connecting') connecting++;
  }
  if (connected) return 'connected';
  if (connecting) return 'connecting';
  if (errored) return 'error';
  return 'disconnected';
}
function emitStatus() {
  const robots = {};
  for (const [id, s] of sessions) {
    robots[id] = { phase: s.phase || 'disconnected', endpoint: s.endpoint || null, reconnectAttempts: s.reconnectAttempts || 0, lastError: s.lastError || null };
  }
  emit({ type: 'status', phase: globalPhase(), robots, endpoint: null, reconnectAttempts: 0, lastError: null });
}

// ---- webhooks: conversationId -> { robotId, hook, convType, senderId }（v5 按 robot 分桶持久化）----
const webhooks = new Map(); // conversationId -> { robotId, hook, convType, senderId }
function persistWebhooks() {
  try {
    const buckets = {};
    for (const [conv, rec] of webhooks) {
      const rid = rec.robotId || ROBOT_DEFAULT;
      if (!buckets[rid]) buckets[rid] = [];
      buckets[rid].push([conv, rec.hook, rec.convType || '', rec.senderId || '']);
    }
    fs.writeFileSync(WEBHOOKS_PATH, JSON.stringify({ version: 5, buckets }));
  } catch {}
}
function restoreWebhooks() {
  try {
    const saved = JSON.parse(fs.readFileSync(WEBHOOKS_PATH, 'utf8'));
    if (Array.isArray(saved)) {
      // v1 旧格式: [[conv, hook]] → 归 robot-default
      for (const [conv, hook] of saved) webhooks.set(String(conv), { robotId: ROBOT_DEFAULT, hook: String(hook) });
    } else if (saved && saved.version >= 2 && saved.buckets && typeof saved.buckets === 'object') {
      for (const rid of Object.keys(saved.buckets)) {
        for (const item of (saved.buckets[rid] || [])) {
          // v5: [conv, hook, convType, senderId];v3/v4: [conv, hook, convType];v2: [conv, hook]
          const conv = item[0], hook = item[1], convType = item[2] || '', senderId = item[3] || '';
          webhooks.set(String(conv), { robotId: rid, hook: String(hook), convType: String(convType), senderId: String(senderId) });
        }
      }
    }
  } catch {}
}

// 回复频控：每聊天 20 条/分钟（PRD 8.3）
const RATE_LIMIT = 20;
const RATE_FLUSH_MS = 55000; // 窗口几乎滑空时补发节流提示
const replyWindows = new Map(); // conversationId -> [ts]
const throttledConvs = new Set();

// 消息幂等：按 messageId 去重（服务端 60s 重推、断线重连重放都不重复处理）
const seenMessages = new Map(); // messageId -> ts
function seenOnce(id) {
  if (!id) return true;
  const now = Date.now();
  for (const [k, t] of seenMessages) if (now - t > 10 * 60 * 1000) seenMessages.delete(k);
  if (seenMessages.has(id)) return false;
  seenMessages.set(id, now);
  if (seenMessages.size > 800) {
    const first = seenMessages.keys().next().value;
    seenMessages.delete(first);
  }
  return true;
}

function wsReady(ws) { return ws && ws.readyState === 1; }

function socketAck(robotId, messageId, result) {
  const s = sessions.get(robotId);
  if (s && wsReady(s.socket)) {
    try {
      s.socket.send(JSON.stringify({
        code: 200,
        headers: { contentType: 'application/json', messageId },
        message: 'OK',
        data: JSON.stringify({ response: result })
      }));
    } catch {}
  }
}

async function postJSON(url, body, headers) {
  const res = await fetch(url, {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' }, headers || {}),
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

async function reqJSON(method, url, body, headers) {
  const res = await fetch(url, {
    method,
    headers: Object.assign({ 'content-type': 'application/json' }, headers || {}),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

// ---- AI 卡片(钉钉卡片平台): 表格/代码块等完整 markdown 仅卡片 markdown 组件支持 ----
// 机器人 markdown 消息(msgtype=markdown)不支持表格与代码块;AI 卡片的 markdown
// 组件支持表格、代码块等富语法。API 契约对齐 dingtalk-stream-sdk AICardReplier:
//   POST /v1.0/card/instances/createAndDeliver → 卡片直达会话
//   PUT  /v1.0/card/streaming                  → 内容整体更新 + finalize
const DINGTALK_API = 'https://api.dingtalk.com';
const AICARD_CONTENT_KEY = 'content';
// 公开测试模板(官方示例同款)内容组件为旧版 markdown(mdVer=0),不渲染表格/代码块;
// 自建模板 resource/waker-aicard-receipt.json 把 mdVer 升到 1(新版渲染器,支持表格与代码)。
const AICARD_TEMPLATE_PUBLIC_TEST = '8aebdfb9-28f4-4a98-98f5-396c3dde41a0.schema';
const AICARD_TEMPLATE_OWN_NAME = 'Waker AI 回执';
let aiCardTemplateResolved = null;   // 已解析则缓存,避免重复建模板
let aiCardTemplatePending = null;    // 进行中的解析 Promise
function aiCardOwnTemplateSource() {
  try {
    const p = require('node:path').join(__dirname, '..', 'resource', 'waker-aicard-receipt.json');
    const raw = fs.readFileSync(p, 'utf8');
    // 卡片平台导入文件 = {editorData: string, ...};saveTemplate.templateSource 接收同样的编辑器导出串
    const parsed = JSON.parse(raw);
    return typeof parsed.editorData === 'string' ? raw : JSON.stringify(parsed);
  } catch (e) { return null; }
}
// 幂等解析模板 ID: 显式 env → 已发布自有模板(listTemplate) → 自动创建/保存/发布 → 公开测试模板兜底
async function resolveAiCardTemplate(robotId) {
  if (aiCardTemplateResolved) return aiCardTemplateResolved;
  if (aiCardTemplatePending) return aiCardTemplatePending;
  aiCardTemplatePending = (async () => {
    try {
      if (process.env.DTW_AICARD_TEMPLATE) { aiCardTemplateResolved = process.env.DTW_AICARD_TEMPLATE; return aiCardTemplateResolved; }
      const token = await aiCardToken(robotId);
      if (!token) return (aiCardTemplateResolved = AICARD_TEMPLATE_PUBLIC_TEST);
      const headers = { 'x-acs-dingtalk-access-token': token };
      const listRes = await reqJSON('POST', DINGTALK_API + '/v1.0/card/templates/lists/query', {}, headers);
      const rows = listRes.data && Array.isArray(listRes.data.data) ? listRes.data.data : [];
      const mine = rows.filter((t) => t && t.name === AICARD_TEMPLATE_OWN_NAME && t.templateId);
      if (mine.length) { aiCardTemplateResolved = mine[0].templateId; log('[aicard] using own template ' + aiCardTemplateResolved); return aiCardTemplateResolved; }
      // 未开通 Card.Template.ReadWrite.All 时 list 也会 403 → 直接走公开测试模板
      if (listRes.status >= 400) {
        diag({ kind: 'aicard-template-list-denied', status: listRes.status, hint: 'open Card.Template.ReadWrite.All at open-dev.dingtalk.com (permission point)' });
        return (aiCardTemplateResolved = AICARD_TEMPLATE_PUBLIC_TEST);
      }
      const source = aiCardOwnTemplateSource();
      if (!source) { aiCardTemplateResolved = AICARD_TEMPLATE_PUBLIC_TEST; return aiCardTemplateResolved; }
      const created = await postJSON(DINGTALK_API + '/v1.0/card/templates', {
        name: AICARD_TEMPLATE_OWN_NAME, type: 'im', extendType: 'card'
      }, headers);
      const newId = created.data && created.data.data ? (created.data.data.templateId || created.data.data.id) : null;
      if (created.status >= 400 || !newId) {
        diag({ kind: 'aicard-template-create-denied', status: created.status, data: JSON.stringify(created.data || {}).slice(0, 200) });
        return (aiCardTemplateResolved = AICARD_TEMPLATE_PUBLIC_TEST);
      }
      const saved = await postJSON(DINGTALK_API + '/v1.0/card/templates/save', {
        templateId: newId, name: AICARD_TEMPLATE_OWN_NAME, templateSource: source
      }, headers);
      if (saved.status >= 400) diag({ kind: 'aicard-template-save-failed', status: saved.status, data: JSON.stringify(saved.data || {}).slice(0, 200) });
      const published = await postJSON(DINGTALK_API + '/v1.0/card/templates/publish', {
        templateId: newId, name: AICARD_TEMPLATE_OWN_NAME
      }, headers);
      if (published.status >= 400) {
        diag({ kind: 'aicard-template-publish-failed', status: published.status, data: JSON.stringify(published.data || {}).slice(0, 200) });
        return (aiCardTemplateResolved = AICARD_TEMPLATE_PUBLIC_TEST);
      }
      log('[aicard] own template created+published: ' + newId);
      aiCardTemplateResolved = newId;
      return aiCardTemplateResolved;
    } catch (e) {
      diag({ kind: 'aicard-template-error', error: String((e && e.message) || e).slice(0, 200) });
      return (aiCardTemplateResolved = AICARD_TEMPLATE_PUBLIC_TEST);
    } finally {
      aiCardTemplatePending = null;
    }
  })();
  return aiCardTemplatePending;
}
// robotId -> { accessToken, expireAt }
const aiCardTokens = new Map();
async function aiCardToken(robotId) {
  const s = sessions.get(robotId);
  if (!s || !s.clientId || !s.clientSecret) return null;
  const cached = aiCardTokens.get(robotId);
  if (cached && Date.now() < cached.expireAt) return cached.accessToken;
  const res = await postJSON(DINGTALK_API + '/v1.0/oauth2/accessToken', {
    appKey: s.clientId,
    appSecret: s.clientSecret
  });
  const tok = res.data && typeof res.data === 'object' ? res.data.accessToken : null;
  if (!tok) {
    diag({ kind: 'aicard-token-failed', robotId, status: res.status, data: typeof res.data === 'string' ? res.data.slice(0, 160) : JSON.stringify(res.data || {}).slice(0, 160) });
    return null;
  }
  const expireIn = Number((res.data && res.data.expireIn) || 7200);
  aiCardTokens.set(robotId, { accessToken: tok, expireAt: Date.now() + (expireIn - 300) * 1000 });
  return tok;
}
// 单条 AI 卡片回执: createAndDeliver(content 全量, flowStatus FINISHED)。
// 失败抛错由调用方回退 markdown。
async function sendAiCard(robotId, conv, convType, title, text) {
  const token = await aiCardToken(robotId);
  if (!token) throw new Error('no access token');
  const headers = { 'x-acs-dingtalk-access-token': token };
  const outTrackId = 'wkaicard-' + robotId + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const group = convType !== '1';
  const body = {
    cardTemplateId: await resolveAiCardTemplate(robotId),
    outTrackId,
    callbackType: 'STREAM',
    cardData: { cardParamMap: {
      [AICARD_CONTENT_KEY]: String(text).slice(0, 18000),
      flowStatus: '3'
    } },
    openSpaceId: group
      ? 'dtv1.card//IM_GROUP.' + conv
      : 'dtv1.card//IM_ROBOT.' + conv,
    imGroupOpenSpaceModel: { supportForward: true },
    imRobotOpenSpaceModel: { supportForward: true }
  };
  if (group) {
    body.imGroupOpenDeliverModel = { robotCode: (sessions.get(robotId) || {}).clientId };
  } else {
    body.imRobotOpenDeliverModel = { spaceType: 'IM_ROBOT' };
  }
  const created = await postJSON(DINGTALK_API + '/v1.0/card/instances/createAndDeliver', body, headers);
  const dr = created.data && created.data.result && Array.isArray(created.data.result.deliverResults) ? created.data.result.deliverResults[0] : null;
  if (created.status !== 200 || !created.data || created.data.success !== true || !dr || dr.success !== true) {
    throw new Error('createAndDeliver failed: HTTP ' + created.status + ' ' + JSON.stringify(created.data || {}).slice(0, 200));
  }
  // 整体更新并收尾(isFinalize)——回执为完整文本,无需逐段流式
  const streamed = await reqJSON('PUT', DINGTALK_API + '/v1.0/card/streaming', {
    outTrackId,
    guid: 'g-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    key: AICARD_CONTENT_KEY,
    content: String(text).slice(0, 18000),
    isFull: true,
    isFinalize: true,
    isError: false
  }, headers);
  diag({ kind: 'aicard-sent', robotId, conversationId: String(conv).slice(-10), outTrackId, spaceType: group ? 'IM_GROUP' : 'IM_ROBOT', streamingOk: !(streamed.status >= 400) });
  return { ok: true, outTrackId };
}

// ---- 每 robot 连接生命周期 ----
function scheduleReconnect(robotId) {
  const s = sessions.get(robotId);
  if (!s || s.reconnectTimer || !s.clientSecret) return;
  const delay = Math.min(1000 * Math.pow(2, s.reconnectAttempts) + Math.floor(Math.random() * 1000), 60000);
  s.reconnectAttempts += 1;
  log(`[${robotId}] reconnect in ${(delay / 1000).toFixed(1)}s (attempt ${s.reconnectAttempts})`);
  s.reconnectTimer = setTimeout(() => { s.reconnectTimer = null; connectRobot(robotId); }, delay);
}

async function connectRobot(robotId) {
  const s = sessions.get(robotId);
  if (!s || s.connecting) return;
  s.connecting = true;
  if (s.reconnectTimer) { clearTimeout(s.reconnectTimer); s.reconnectTimer = null; }
  s.phase = 'connecting';
  emitStatus();
  try {
    const res = await postJSON(GATEWAY_URL, {
      clientId: s.clientId,
      clientSecret: s.clientSecret,
      ua: 'dsh-waker-bridge/4.0',
      subscriptions: [{ type: 'CALLBACK', topic: TOPIC_ROBOT }]
    }, { Accept: 'application/json' });
    if (res.status !== 200 || !res.data || !res.data.endpoint || !res.data.ticket) {
      throw new Error('gateway response invalid: ' + JSON.stringify(res.data).slice(0, 300));
    }
    s.endpoint = res.data.endpoint;
    openSocket(robotId, `${res.data.endpoint}?ticket=${encodeURIComponent(res.data.ticket)}`);
  } catch (err) {
    s.lastError = String((err && err.message) || err).slice(0, 300);
    s.phase = 'error';
    emitStatus();
    scheduleReconnect(robotId);
  } finally {
    s.connecting = false;
  }
}

function openSocket(robotId, url) {
  const s = sessions.get(robotId);
  if (!s) return;
  let ws;
  try { ws = new WebSocket(url); } catch (err) {
    s.lastError = 'WebSocket construct failed: ' + String((err && err.message) || err);
    s.phase = 'error';
    emitStatus();
    scheduleReconnect(robotId);
    return;
  }
  s.socket = ws;
  ws.addEventListener('open', () => {
    s.reconnectAttempts = 0;
    s.phase = 'connected';
    s.lastError = null;
    log(`[${robotId}] websocket open`);
    emitStatus();
  });
  ws.addEventListener('message', (ev) => {
    let msg;
    try {
      const raw = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8');
      msg = JSON.parse(raw);
    } catch { return; }
    handleDownstream(robotId, msg);
  });
  ws.addEventListener('close', (ev) => {
    log(`[${robotId}] websocket close code=${ev && ev.code} reason=${String((ev && ev.reason) || '').slice(0, 120)}`);
    if (s.socket !== ws) return;
    s.socket = null;
    if (sessions.get(robotId) === s) {
      s.phase = 'disconnected';
      emitStatus();
      scheduleReconnect(robotId);
    }
  });
  ws.addEventListener('error', (err) => {
    s.lastError = 'websocket error: ' + String((err && err.message) || err || '').slice(0, 160);
    log(`[${robotId}] ${s.lastError}`);
    try { ws.close(); } catch {}
  });
}

function disconnectRobot(robotId) {
  const s = sessions.get(robotId);
  if (!s) return;
  if (s.reconnectTimer) { clearTimeout(s.reconnectTimer); s.reconnectTimer = null; }
  if (s.socket) { try { s.socket.close(); } catch {} }
  s.socket = null;
  s.phase = 'stopping';
  sessions.delete(robotId);
  log(`[${robotId}] disconnected (removed)`);
  emitStatus();
}

function upsertRobot(robotId, clientId, clientSecret, doConnect) {
  const prev = sessions.get(robotId);
  const changed = !prev || prev.clientId !== clientId || prev.clientSecret !== clientSecret;
  if (changed && prev) {
    // 凭据变化：断开旧连接后重建
    if (prev.reconnectTimer) { clearTimeout(prev.reconnectTimer); prev.reconnectTimer = null; }
    if (prev.socket) { try { prev.socket.close(); } catch {} }
    sessions.delete(robotId);
  }
  if (!sessions.has(robotId)) {
    sessions.set(robotId, {
      clientId, clientSecret,
      socket: null, endpoint: null, reconnectTimer: null,
      connecting: false, reconnectAttempts: 0, phase: 'connecting', lastError: null
    });
    if (doConnect !== false) connectRobot(robotId);
  }
  return { changed };
}

// 期望态全量 diff：不在名单的断开，凭据变化的重建，其余保持
function applyRobotsConfig(robots) {
  if (!Array.isArray(robots) || !robots.length) return { ok: false, error: 'robots array required' };
  const seen = new Set();
  const errors = [];
  for (const r of robots) {
    const robotId = String((r && r.robotId) || ROBOT_DEFAULT);
    const clientId = String((r && r.clientId) || '').trim();
    const clientSecret = String((r && r.clientSecret) || '').trim();
    if (!clientId || !clientSecret) { errors.push(`${robotId}: clientId/clientSecret required`); continue; }
    seen.add(robotId);
    upsertRobot(robotId, clientId, clientSecret);
  }
  for (const robotId of [...sessions.keys()]) {
    if (!seen.has(robotId)) disconnectRobot(robotId);
  }
  if (errors.length) log('robots-config errors: ' + errors.join('; '));
  return { ok: true, connected: seen.size, errors };
}

function handleDownstream(robotId, msg) {
  if (!msg || !msg.headers) return;
  switch (msg.type) {
    case 'SYSTEM': {
      const topic = msg.headers.topic;
      log(`[${robotId}] SYSTEM frame topic=` + String(topic));
      if (topic === 'ping') {
        // ping 应答格式与 CALLBACK ack 不同：直接回原始 data（不能发 CALLBACK 风格 ack，避免服务端误判）
        const s = sessions.get(robotId);
        if (s && wsReady(s.socket)) {
          try { s.socket.send(JSON.stringify({ code: 200, headers: msg.headers, message: 'OK', data: msg.data })); } catch {}
        }
      } else if (topic === 'CONNECTED') {
        log(`[${robotId}] gateway connected`);
      } else if (topic === 'REGISTERED') {
        const s = sessions.get(robotId);
        if (s) { s.phase = 'connected'; emitStatus(); }
      } else if (topic === 'KEEPALIVE') {
        /* 服务端保活 */
      } else if (topic === 'disconnect') {
        const s = sessions.get(robotId);
        if (s) { s.phase = 'disconnected'; emitStatus(); scheduleReconnect(robotId); }
      }
      break;
    }
    case 'CALLBACK': {
      // 幂等：同一 messageId 的重推/重放直接确认，不再转发插件
      if (!seenOnce(msg.headers.messageId)) {
        socketAck(robotId, msg.headers.messageId, { status: 'SUCCESS' });
        return;
      }
      let data = msg.data;
      if (typeof data === 'string') { try { data = JSON.parse(data); } catch {} }
      if (data && data.conversationId && data.sessionWebhook) {
        const rec = { robotId, hook: String(data.sessionWebhook), convType: String(data.conversationType || '1'), senderId: String(data.senderStaffId || '') };
        const prev = webhooks.get(data.conversationId);
        const isNew = !prev || prev.hook !== rec.hook || prev.robotId !== robotId || prev.senderId !== rec.senderId;
        webhooks.set(data.conversationId, rec);
        if (webhooks.size > 400) {
          const first = webhooks.keys().next().value;
          webhooks.delete(first);
        }
        if (isNew) persistWebhooks();
      }
      diag({ kind: 'callback', robotId, conversationId: data ? String(data.conversationId || '').slice(-10) : null, hasWebhook: !!(data && data.sessionWebhook), msgType: data ? data.msgtype : null, isAtAll: !!(data && data.isAtAll), atUsers: data && Array.isArray(data.atUsers) ? data.atUsers.length : null, convType: data ? data.conversationType : null, text: data && data.text ? JSON.stringify(data.text).slice(0, 120) : null });
      // 事件直接走 stdout JSONL（Desktop webServer 有渲染进程围栏，HTTP 回调不可用）
      emit({
        type: 'event',
        kind: 'bot-message',
        robotId,
        messageId: msg.headers.messageId,
        receivedAt: Date.now(),
        data
      });
      // 已受理，避免服务端 60s 重推
      socketAck(robotId, msg.headers.messageId, { status: 'SUCCESS' });
      break;
    }
    case 'EVENT': {
      socketAck(robotId, msg.headers.messageId, { status: 'SUCCESS' });
      break;
    }
    default:
      break;
  }
}

// 主动发送通道：开放平台机器人主动发消息 API（凭据自取 accessToken），不依赖 sessionWebhook（90 分钟时效）。
// 群聊 /v1.0/robot/groupMessages/send（实测 200 + processQueryKey）；单聊 /v1.0/robot/privateChatMessages/send。
// 报文映射: sessionWebhook 的 msgtype 报文 → msgKey + msgParam(JSON 串,不带 msgtype)。
function activeSendPayload(payload) {
  if (payload && payload.msgtype === 'text' && payload.text) {
    return { msgKey: 'sampleText', msgParam: { content: String(payload.text.content || '') } };
  }
  if (payload && payload.msgtype === 'markdown' && payload.markdown) {
    return { msgKey: 'sampleMarkdown', msgParam: { title: String(payload.markdown.title || ''), content: String(payload.markdown.text || '') } };
  }
  if (payload && payload.msgtype === 'actionCard' && payload.actionCard) {
    return { msgKey: 'sampleActionCard', msgParam: { title: String(payload.actionCard.title || ''), text: String(payload.actionCard.text || '') } };
  }
  return null;
}
async function activeSend(robotId, conversationId, convType, payload) {
  const s = sessions.get(robotId);
  if (!s || !s.clientId) throw new Error('no robot credentials for active send');
  const mapped = activeSendPayload(payload);
  if (!mapped) throw new Error('payload not mappable for active send: ' + String(payload && payload.msgtype));
  const token = await aiCardToken(robotId);
  const headers = { 'x-acs-dingtalk-access-token': token };
  const isGroup = String(convType || '2') !== '1';
  const body = {
    robotCode: s.clientId,
    openConversationId: String(conversationId),
    msgKey: mapped.msgKey,
    msgParam: JSON.stringify(mapped.msgParam)
  };
  const url = isGroup ? DINGTALK_API + '/v1.0/robot/groupMessages/send' : DINGTALK_API + '/v1.0/robot/privateChatMessages/send';
  const res = await postJSON(url, body, headers);
  if (res.status !== 200) {
    const detail = typeof res.data === 'string' ? res.data.slice(0, 200) : JSON.stringify(res.data || {}).slice(0, 200);
    throw new Error('active send HTTP ' + res.status + ': ' + detail);
  }
  return res;
}

async function replyToConversation(conversationId, text, opts) {
  const rec = webhooks.get(conversationId);
  const webhook = rec ? rec.hook : null;
  opts = opts || {};
  const robotId0 = rec ? rec.robotId : null;
  diag({ kind: 'reply-attempt', robotId: robotId0, conversationId: String(conversationId).slice(-10), hasWebhook: !!webhook, textLen: String(text || '').length, format: opts.format || 'text' });
  if (!webhook && !robotId0) {
    // 既无 webhook 也无机器人凭据归属：主动发送无从发起(如 sim 注入的假 conv)
    return { ok: false, error: 'unknown conversationId (no sessionWebhook recorded)' };
  }
  // 频控：同一聊天 20 条/分钟（钉钉机器人上限），超限合并为一条提示
  const now = Date.now();
  const win = replyWindows.get(conversationId) || [];
  const recent = win.filter((t) => now - t < 60000);
  if (recent.length >= RATE_LIMIT) {
    diag({ kind: 'reply-throttled', conversationId: String(conversationId).slice(-10), pendingLen: String(text || '').length });
    throttledConvs.add(conversationId);
    return { ok: true, throttled: true };
  }
  recent.push(now);
  replyWindows.set(conversationId, recent);
  // 报文分型：text = 纯文本(状态通知);markdown = 任务回执(AI 输出按 markdown 渲染,无跳转按钮——
  // 暂无落地页能力,原 actionCard 自带的「查看任务看板」按钮已移除);
  // aicard = AI 卡片(表现形态最丰富: markdown 组件支持表格、代码块;失败自动回退 markdown)。
  // 钉钉 markdown 报文换行需 \n\n,单 \n 不换行,发送前规范化。
  let payload;
  if (opts.format === 'actioncard') {
    // ActionCard(无按钮): text 渲染子集最全(实测表格/代码块可渲染,单 \n 即换行),
    // 不带 singleTitle/singleURL/btns 时无底部跳转按钮(实测 errcode 0)
    payload = { msgtype: 'actionCard', actionCard: {
      title: String(opts.title || 'Waker 任务回执').slice(0, 40),
      text: String(text).slice(0, 18000)
    } };
  } else if (opts.format === 'markdown') {
    payload = { msgtype: 'markdown', markdown: {
      title: String(opts.title || 'Waker 任务回执').slice(0, 40),
      text: String(text).slice(0, 18000).replace(/\n/g, '\n\n')
    } };
  } else if (opts.format !== 'text') {
    payload = { msgtype: 'markdown', markdown: {
      title: String(opts.title || 'Waker 任务回执').slice(0, 40),
      text: String(text).slice(0, 18000).replace(/\n/g, '\n\n')
    } };
  } else {
    payload = { msgtype: 'text', text: { content: String(text).slice(0, 3000) } };
  }
  // aicard: 任务回执走 AI 卡片(表格/代码可渲染),失败回退 markdown 报文
  if (opts.format === 'aicard') {
    try {
      const card = await sendAiCard(robotId0 || ROBOT_DEFAULT, conversationId, rec ? (rec.convType || '2') : '2', opts.title, text);
      diag({ kind: 'reply-result', conversationId: String(conversationId).slice(-10), via: 'aicard', outTrackId: card.outTrackId });
      return { ok: true, via: 'aicard' };
    } catch (cardErr) {
      diag({ kind: 'aicard-fallback', conversationId: String(conversationId).slice(-10), error: String((cardErr && cardErr.message) || cardErr).slice(0, 200) });
      // 落回下方 markdown 报文发送
    }
  }
  // 双通道发送: sessionWebhook 优先(即时上下文),失败/过期/缺失 → 开放平台主动发送 API 兜底。
  // 主动发送不依赖 webhook 时效(90 分钟),任务回执在长任务/冷群场景不再失联。
  let webhookExpired = false;
  if (webhook) {
    try {
      const res = await postJSON(webhook, payload);
      const errcode = res.data && typeof res.data === 'object' ? res.data.errcode : null;
      diag({ kind: 'reply-result', conversationId: String(conversationId).slice(-10), via: 'webhook', status: res.status, data: typeof res.data === 'string' ? res.data.slice(0, 300) : res.data });
      if (res.status === 200 && (errcode == null || errcode === 0)) {
        await maybeFlushThrottle(conversationId, webhook, payload, recent, now);
        return { ok: true, via: 'webhook' };
      }
      if (errcode === 300001) {
        // webhook 过期：清除失效缓存；主动发送通道接管本轮
        webhookExpired = true;
        webhooks.delete(conversationId);
        persistWebhooks();
        diag({ kind: 'webhook-evicted', conversationId: String(conversationId).slice(-10) });
      }
    } catch (err) {
      diag({ kind: 'reply-error', conversationId: String(conversationId).slice(-10), error: String((err && err.message) || err).slice(0, 200) });
    }
  }
  // 主动发送兜底（webhook 失败/过期/缺失时到达这里）
  if (robotId0 && sessions.get(robotId0)) {
    try {
      await activeSend(robotId0, conversationId, rec ? rec.convType : '2', payload);
      diag({ kind: 'reply-result', conversationId: String(conversationId).slice(-10), via: 'active' });
      await maybeFlushThrottle(conversationId, null, payload, recent, now);
      return { ok: true, via: 'active' };
    } catch (err) {
      const error = String((err && err.message) || err);
      diag({ kind: 'reply-error', conversationId: String(conversationId).slice(-10), via: 'active', error: error.slice(0, 220) });
      return { ok: false, error };
    }
  }
  return { ok: false, error: webhookExpired ? 'webhook expired and active send unavailable' : 'reply failed' };
}

// 窗口滑出后补发一条节流提示；webhook 不可用时走主动发送
async function maybeFlushThrottle(conversationId, webhook, lastPayload, recent, now) {
  if (!throttledConvs.has(conversationId)) return;
  if (!recent.every((t) => now - t > RATE_FLUSH_MS)) return;
  throttledConvs.delete(conversationId);
  const notice = { msgtype: 'text', text: { content: '（刚才消息较多，部分回复已合并节流）' } };
  setTimeout(() => {
    const send = webhook
      ? postJSON(webhook, notice).then((r) => {
          const ec = r.data && typeof r.data === 'object' ? r.data.errcode : null;
          if (r.status !== 200 || (ec !== null && ec !== 0)) throw new Error('webhook notice failed ec=' + ec);
          return r;
        })
      : Promise.reject(new Error('no webhook'));
    send.catch(() => {
      const rec2 = webhooks.get(conversationId);
      const rid2 = rec2 ? rec2.robotId : null;
      if (rid2 && sessions.get(rid2)) {
        activeSend(rid2, conversationId, rec2 ? rec2.convType : '2', notice).catch(() => {});
      }
    });
  }, 1500);
}

// v1 兼容：单凭证 config 动作 → robot-default
function applyConfig(body) {
  const clientId = String((body && body.clientId) || '').trim();
  const clientSecret = String((body && body.clientSecret) || '').trim();
  if (!clientId || !clientSecret) return { ok: false, error: 'clientId/clientSecret required' };
  return applyRobotsConfig([{ robotId: ROBOT_DEFAULT, clientId, clientSecret }]);
}

function handleAction(body) {
  const action = body && body.action;
  switch (action) {
    case 'robots-config': return applyRobotsConfig(body && body.robots);
    case 'config': return applyConfig(body); // v1 兼容
    case 'reconnect': {
      // 兼容：无 robotId = 全部重连；有 robotId = 单 robot
      const rid = body && body.robotId ? String(body.robotId) : null;
      if (rid) {
        const s = sessions.get(rid);
        if (!s) return { ok: false, error: 'no session for robot: ' + rid };
        s.reconnectAttempts = 0;
        if (s.socket) { try { s.socket.close(); } catch {} }
        connectRobot(rid);
        return { ok: true };
      }
      if (!sessions.size) return { ok: false, error: 'no sessions' };
      for (const [rid2, s] of sessions) {
        s.reconnectAttempts = 0;
        if (s.socket) { try { s.socket.close(); } catch {} }
        connectRobot(rid2);
      }
      return { ok: true };
    }
    case 'reconnect-robot': {
      const rid = String((body && body.robotId) || '');
      const s = sessions.get(rid);
      if (!s) return { ok: false, error: 'no session for robot: ' + rid };
      s.reconnectAttempts = 0;
      if (s.socket) { try { s.socket.close(); } catch {} }
      connectRobot(rid);
      return { ok: true };
    }
    case 'reply': return replyToConversation(body && body.conversationId, body && body.text, { format: body && body.format, title: body && body.title, btnTitle: body && body.btnTitle, btnUrl: body && body.btnUrl });
    case 'webhooks': return { ok: true, count: webhooks.size, webhooks: [...webhooks.entries()].map(([conv, rec]) => [conv, rec.robotId]) };
    case 'shutdown':
      for (const s of sessions.values()) { if (s.socket) { try { s.socket.close(); } catch {} } }
      setTimeout(() => process.exit(0), 100);
      return { ok: true };
    default: return { ok: false, error: 'unknown action: ' + String(action) };
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const jsonOut = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (req.method === 'GET' && url.pathname === '/health') {
    const robots = {};
    for (const [id, s] of sessions) {
      robots[id] = { phase: s.phase, endpoint: s.endpoint, reconnectAttempts: s.reconnectAttempts, lastError: s.lastError };
    }
    jsonOut(200, {
      ok: true,
      version: 4,
      phase: globalPhase(),
      robots,
      reconnectAttempts: 0,
      lastError: null,
      uptimeMs: Date.now() - stateStartedAt,
      conversations: webhooks.size
    });
    return;
  }
  if (TOKEN && req.headers['x-waker-token'] !== TOKEN) {
    jsonOut(403, { ok: false, error: 'forbidden' });
    return;
  }
  if (req.method === 'POST' && (url.pathname === '/rpc' || url.pathname === '/waker/bridge')) {
    try {
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw); } catch { jsonOut(400, { ok: false, error: 'bad json' }); return; }
      jsonOut(200, handleAction(body));
    } catch (err) {
      jsonOut(500, { ok: false, error: String((err && err.message) || err) });
    }
    return;
  }
  jsonOut(404, { ok: false, error: 'not found' });
});

const stateStartedAt = Date.now();

// stdin JSONL：插件通过 handle.stdin 写入动作
let stdinBuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdinBuf += chunk;
  let idx;
  while ((idx = stdinBuf.indexOf('\n')) !== -1) {
    const line = stdinBuf.slice(0, idx).trim();
    stdinBuf = stdinBuf.slice(idx + 1);
    if (!line) continue;
    try {
      const body = JSON.parse(line);
      const r = handleAction(body);
      if (r && r.ok === false) log(`stdin action "${(body && body.action) || '?'}" failed: ${r.error || 'unknown'}`);
    } catch (err) { log('stdin action failed: ' + String((err && err.message) || err)); }
  }
});
process.stdin.on('error', () => {});

server.listen(PORT, '127.0.0.1', () => {
  const httpPort = server.address().port;
  // 恢复上一进程记录的 webhooks（sessionWebhook 有效期约 90 分钟，恢复可容忍重启间隙）
  restoreWebhooks();
  if (webhooks.size) log(`restored ${webhooks.size} webhooks from disk`);
  // 环境变量兜底（v1 兼容）：仅当插件尚未下发 robots-config 时提供单机器人凭据
  if (ENV_CLIENT_ID && ENV_CLIENT_SECRET && !sessions.has(ROBOT_DEFAULT)) {
    upsertRobot(ROBOT_DEFAULT, ENV_CLIENT_ID, ENV_CLIENT_SECRET, false);
  }
  emit({ type: 'ready', httpPort, pid: process.pid, hasCredentials: sessions.size > 0, robots: [...sessions.keys()] });
  if (sessions.size) for (const rid of sessions.keys()) connectRobot(rid);
  else emitStatus();
});

process.on('SIGTERM', () => {
  for (const s of sessions.values()) { if (s.socket) { try { s.socket.close(); } catch {} } }
  setTimeout(() => process.exit(0), 50);
});
