#!/usr/bin/env node
/**
 * dsh-waker dev runner: edit → build → tiered hot-reload.
 *
 *   node scripts/dev.mjs            # build once, boot, watch & tiered reload
 *   node scripts/dev.mjs --once     # build + boot, no watching
 *
 * Tiered reload (closest approximation to dynamic-pkg hot swap):
 *   T0 client-only change   → rebuild only; page picks it up on next
 *                             hard refresh (client.js is read per-request).
 *                             The runner prints a hint; no restart.
 *   T1 bridge script change → rebuild (no-op) + restart `dsh web` (bridge is
 *                             spawned from disk at boot; ~8s).
 *   T2 host source change   → rebuild + restart `dsh web`.
 *
 * Dev RPC is enabled in dev boots (DSH_WAKER_DEV=1): inject simulated
 * DingTalk messages without the real DingTalk link — see scripts/sim.mjs.
 *
 * Storage (storageDomain dsh_waker), queue and webhook cache persist across
 * restarts; restarting is the designed recovery path, not a loss.
 */
import { spawn } from 'node:child_process'
import { watch } from 'node:fs'
import { existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const once = process.argv.includes('--once')
const PORT = process.env.WAKER_DEV_PORT || '3080'

let child = null
let restarting = false
let pendingRestart = false
let suppressedRestart = false

const C = { cyan: (s) => `\x1b[36m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m` }
const log = (...a) => console.log(C.cyan('[dev]'), ...a)

function mtime(p) { try { return statSync(join(root, p)).mtimeMs } catch { return 0 } }
function snapshots() {
  return { host: mtime('pkg/lib/index.js'), client: mtime('pkg/client/client.js'), bridge: mtime('pkg/bridge/bridge.cjs') }
}

function build() {
  const before = snapshots()
  return new Promise((res) => {
    const p = spawn(process.execPath, [join(root, 'scripts', 'build.mjs')], { stdio: 'inherit' })
    p.on('exit', (code) => {
      const after = snapshots()
      res({
        ok: code === 0,
        changed: {
          client: after.client !== before.client,
          host: after.host !== before.host,
          bridge: after.bridge !== before.bridge
        }
      })
    })
  })
}

async function start() {
  if (child) return
  log('booting dsh web …')
  const t0 = Date.now()
  child = spawn('dsh', ['web', '--no-open', '--port', PORT], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, { DSH_WAKER_DEV: '1' })
  })
  let booted = false
  const onLine = (buf) => {
    for (const line of buf.toString().split('\n')) {
      if (!line.trim()) continue
      if (!booted && /dsh web: http:|listening/i.test(line)) {
        booted = true
        log(C.green(`ready in ${Date.now() - t0}ms`) + ` → http://127.0.0.1:${PORT}  (Settings → Waker)`)
      }
      if (/waker|Waker/.test(line)) console.log(C.dim('  ' + line))
    }
  }
  child.stdout.on('data', onLine)
  child.stderr.on('data', onLine)
  child.on('exit', (code, sig) => {
    child = null
    if (suppressedRestart) return
    log(`dsh web exited (code=${code} sig=${sig})`)
  })
  for (let i = 0; i < 60 && !booted && child; i++) await new Promise((r) => setTimeout(r, 250))
  if (!child) { log(C.red('boot failed — see output above')); process.exit(1) }
}

async function stop() {
  if (!child) return
  const c = child
  child = null
  await new Promise((res) => {
    c.once('exit', res)
    c.kill('SIGTERM')
    setTimeout(() => { try { c.kill('SIGKILL') } catch {} ; res() }, 4000)
  })
}

async function restart(reason) {
  if (restarting) { pendingRestart = true; return }
  restarting = true
  log(C.yellow(`── restart (${reason}) ──`))
  await stop()
  await start()
  restarting = false
  if (pendingRestart) { pendingRestart = false; restart('queued change') }
}

// ── watch ────────────────────────────────────────────────────────────────────
let timer = null
let dirty = new Set()
function schedule(label) {
  dirty.add(label)
  clearTimeout(timer)
  timer = setTimeout(async () => {
    const labels = [...dirty].join(', ')
    dirty.clear()
    const b = await build()
    if (!b.ok) { log(C.red('build FAILED — fix and save again; old build keeps running')); return }
    const onlyClient = b.changed.client && !b.changed.host && !b.changed.bridge
    if (onlyClient) {
      log(C.green('client updated — hard-refresh the browser (⌘⇧R) to see it; no restart needed'))
      return
    }
    await restart(labels)
  }, 600)
}

const rootMap = {
  src: 'source',
  scripts: 'build script',
}
if (!once) {
  for (const dir of Object.keys(rootMap)) {
    watch(join(root, dir), { recursive: true }, (_ev, file) => {
      if (!file || file.endsWith('~') || file.startsWith('.')) return
      if (file === 'dev.mjs' || file === 'sim.mjs') return
      schedule(`${rootMap[dir]}: ${file}`)
    })
  }
  watch(join(root, 'package.json'), () => schedule('package.json'))
  watch(join(root, 'plugin.yaml'), () => schedule('plugin.yaml'))
}

process.on('SIGINT', async () => { suppressedRestart = true; log('shutting down'); await stop(); process.exit(0) })
process.on('SIGTERM', async () => { suppressedRestart = true; await stop(); process.exit(0) })

const b = await build()
if (!b.ok) process.exit(1)
await start()
log('watching src/ scripts/ package.json plugin.yaml')
log('  host/bridge change → auto restart (~8s); client-only change → just hard-refresh (⌘⇧R)')
log('  simulate DingTalk messages: node scripts/sim.mjs "帮我看看这个仓库"  (see --help)')
