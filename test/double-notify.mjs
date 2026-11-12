// Regression test: re-applying the plugin must never stack listeners.
//
// Config reloads and HMR re-activation can call `apply` again on the same context.
// Before the fix each call added another listener set, so one finished run
// delivered two Windows notifications. This test drives `apply` repeatedly and
// asserts that a single completion produces exactly one `notify` call.
//
// Run: node test/double-notify.mjs
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { apply } from '../lib/index.js'

const LOG = path.join(tmpdir(), 'dsh-agent-notify.log')
const marker = `双重通知回归 ${Date.now()}`

/** Minimal Cordis context: real on/off semantics plus effect disposal. */
function createContext() {
  const handlers = new Map()
  const effects = []
  return {
    handlers,
    effects,
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(handler)
      return () => {
        const list = handlers.get(event)
        const index = list.indexOf(handler)
        if (index >= 0) list.splice(index, 1)
      }
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') effects.push(dispose)
      return dispose
    },
    emit(event, ...args) {
      for (const handler of [...(handlers.get(event) ?? [])]) handler(...args)
    },
    disposeFiber() {
      for (const dispose of effects.splice(0)) dispose()
    },
    logger: { warn: (message) => console.log('[logger.warn]', message) },
  }
}

const session = {
  id: 'session-double-notify',
  header: { id: 'session-double-notify', cwd: 'C:\\tmp' },
  snapshotEvents: () => [{ type: 'session/title', data: { title: marker } }],
}

const checks = []
function check(label, ok) {
  checks.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`)
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Replay one finished run through the live handlers. */
function finishOneRun(ctx) {
  ctx.emit('agent/status', { agent: { session }, status: 'running' })
  ctx.emit('session/event', session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  ctx.emit('agent/status', { agent: { session }, status: 'idle' })
}

rmSync(LOG, { force: true })

// 1. Repeated apply on the same context must not stack listeners.
const ctx = createContext()
apply(ctx, { duration: 'long', minDurationSec: 0 })
apply(ctx, { duration: 'long', minDurationSec: 0 })
apply(ctx, { duration: 'long', minDurationSec: 0 })
check('session/event has one live handler', (ctx.handlers.get('session/event') ?? []).length === 1)
check('agent/status has one live handler', (ctx.handlers.get('agent/status') ?? []).length === 1)

// 2. One finished run must produce exactly one notification.
finishOneRun(ctx)
await wait(4000)
const entries = readFileSync(LOG, 'utf8')
  .split('\n')
  .filter((line) => line.includes('notify kind=') && line.includes(marker))
check('one finished run produced exactly one notification', entries.length === 1)
if (entries.length !== 1) for (const line of entries) console.log('  got:', line)

// 3. Disposing the fiber must remove every listener, and a later apply must work
//    again (the guard cannot permanently disable the plugin).
ctx.disposeFiber()
check('fiber disposal removed session/event handlers', (ctx.handlers.get('session/event') ?? []).length === 0)
check('fiber disposal removed agent/status handlers', (ctx.handlers.get('agent/status') ?? []).length === 0)

apply(ctx, { duration: 'long', minDurationSec: 0 })
check('re-apply after disposal registers one handler', (ctx.handlers.get('agent/status') ?? []).length === 1)

// 4. `enabled: false` must leave nothing registered.
const disabled = createContext()
apply(disabled, { enabled: false })
check('enabled:false registers no handlers', (disabled.handlers.get('agent/status') ?? []).length === 0)

// 5. Subagent sessions are still ignored.
const subagentCtx = createContext()
apply(subagentCtx, { duration: 'long', minDurationSec: 0 })
const child = {
  id: 'session-child',
  header: { id: 'session-child', cwd: 'C:\\tmp', origin: 'subagent' },
  snapshotEvents: () => [],
}
subagentCtx.emit('agent/status', { agent: { session: child }, status: 'running' })
subagentCtx.emit('session/event', child, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
subagentCtx.emit('agent/status', { agent: { session: child }, status: 'idle' })
await wait(1200)
const childEntries = readFileSync(LOG, 'utf8').split('\n').filter((line) => line.includes('session-child'))
check('subagent session produced no notification', childEntries.length === 0)

const failed = checks.filter((entry) => !entry.ok).length
console.log(failed === 0 ? '\nALL CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`)
process.exitCode = failed === 0 ? 0 : 1
