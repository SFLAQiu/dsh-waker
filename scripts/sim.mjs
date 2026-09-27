#!/usr/bin/env node
/**
 * dsh-waker dev simulator: inject simulated DingTalk messages into a RUNNING
 * dev instance (DSH_WAKER_DEV=1), exercising the real pipeline end-to-end
 * (route → @filter → mapping → session creation/dispatch → queue → state
 * machine) without the real DingTalk link.
 *
 *   node scripts/sim.mjs "帮我看看这个仓库"            # one message (new conversation)
 *   node scripts/sim.mjs --conv cidXxx "继续"          # continue an existing mapping
 *   node scripts/sim.mjs --sender 花叔 "你好"          # custom sender nick
 *   node scripts/sim.mjs --script "任务A" "继续"       # multi-step script, 1.2s apart
 *   node scripts/sim.mjs --robot robot-2               # target a specific robot
 *   node scripts/sim.mjs --at                          # group chat, @ 了机器人
 *   node scripts/sim.mjs --no-at                       # group chat, 未 @(应静默)
 *   node scripts/sim.mjs --conv-type 2                 # 1 单聊 / 2 群聊(默认单聊)
 *   node scripts/sim.mjs --list                        # show known mappings to reuse
 *
 * Reply sending goes through the bridge; when the DingTalk link is down the
 * pipeline still runs — replies are skipped (visible in the runner log).
 */
const args = process.argv.slice(2)
const PORT = process.env.WAKER_DEV_PORT || '3080'
const BASE = `http://127.0.0.1:${PORT}/dsh-waker/api/rpc`

async function rpc(method, rpcArgs) {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, args: rpcArgs || {} })
  })
  const data = await res.json().catch(() => null)
  if (!data || data.ok !== true) throw new Error((data && data.error) || `HTTP ${res.status}`)
  return data.result
}

function usage() {
  console.log(`usage:
  node scripts/sim.mjs "消息文本"                注入一条新会话消息
  node scripts/sim.mjs --conv <cid> "继续"       注入到已有会话
  node scripts/sim.mjs --sender <nick> "文本"    自定义发送者
  node scripts/sim.mjs --script "A" "B" "C"      依次注入多条(间隔 1.2s)
  node scripts/sim.mjs --robot <robotId>         指定来源机器人(默认 robot-default)
  node scripts/sim.mjs --at                      群聊 @ 机器人
  node scripts/sim.mjs --no-at                   群聊未 @(静默用例)
  node scripts/sim.mjs --conv-type 1|2           1 单聊 / 2 群聊
  node scripts/sim.mjs --list                    列出现有会话映射`)
  process.exit(0)
}

async function listMappings() {
  const r = await rpc('waker.pipelineStatus')
  if (!r.mappings || !r.mappings.length) { console.log('(无映射 — 先注入一条消息建立)'); return }
  for (const m of r.mappings) {
    console.log(`${m.conversationId}  →  ${m.sessionId}  ${m.title ? '· ' + m.title : ''} (${m.turnCount || 0} 轮)`)
  }
}

let conv = null
let sender = null
let script = false
let robotId = null
let atMode = null // null=默认 | 'at' | 'no-at'
let convType = null
const texts = []
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--help' || a === '-h') usage()
  else if (a === '--conv') conv = args[++i]
  else if (a === '--sender') sender = args[++i]
  else if (a === '--script') script = true
  else if (a === '--robot') robotId = args[++i]
  else if (a === '--at') atMode = 'at'
  else if (a === '--no-at') atMode = 'no-at'
  else if (a === '--conv-type') convType = String(args[++i])
  else if (a === '--list') { await listMappings(); process.exit(0) }
  else texts.push(a)
}
if (!texts.length) usage()

const ct = convType || (atMode ? '2' : '1')
const isGroup = ct === '2'
const atUsers = isGroup && atMode !== 'no-at' ? [{ nick: sender || '测试用户', staffId: 'dev-test' }] : []
const isAtAll = false

if (script) {
  const r = await rpc('waker.injectScript', { conversationId: conv, texts, sender: sender || undefined, delayMs: 1200 })
  console.log(`剧本注入完成: ${r.count} 条`)
  r.results.forEach((x, i) => console.log(`  [${i + 1}] ${texts[i]} → conv ${x.conversationId || '?'}`))
} else {
  const r = await rpc('waker.injectEvent', {
    conversationId: conv, text: texts[0], sender: sender || undefined,
    robotId: robotId || undefined,
    conversationType: ct,
    isAtAll, atUsers
  })
  console.log(`已注入 → conv ${r.conversationId}${robotId ? ` (robot ${robotId})` : ''}${isGroup ? (atUsers.length ? ' [群聊·已@]' : ' [群聊·未@]') : ' [单聊]'}`)
  console.log('  查看流转: 设置 → Waker 看板,或 node scripts/sim.mjs --list')
}
