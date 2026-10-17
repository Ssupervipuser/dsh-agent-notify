// Smoke-test the INSTALLED plugin (stable shim -> versioned build -> PS scripts),
// i.e. the exact layout the DSH host loads. Fires one of each notification with a
// gap between them so every delivery can be observed in %TEMP%\dsh-agent-notify.log.
import { homedir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const installed = path.join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-agent-notify', 'lib', 'index.js')
const plugin = await import(pathToFileURL(installed).href)

const handlers = new Map()
const ctx = {
  on(event, handler) {
    if (!handlers.has(event)) handlers.set(event, [])
    handlers.get(event).push(handler)
    return () => {}
  },
  logger: { warn: (message) => console.log('[logger.warn]', message) },
}
const session = {
  id: 'session-installed-smoke',
  header: { id: 'session-installed-smoke', cwd: process.cwd() },
  snapshotEvents: () => [{ type: 'session/title', data: { title: '插件安装后的冒烟测试' } }],
}
const emit = (event, ...args) => {
  for (const handler of handlers.get(event) ?? []) handler(...args)
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

console.log('shim exports:', Object.keys(plugin))
await plugin.apply(ctx, { duration: 'long', alertCooldownSec: 0 })

// 1) permission request
emit('session/event', session, { type: 'approval/asked', data: { id: 'ap-smoke', toolName: 'pwsh', reason: '冒烟测试：写工作区外文件' } })
await wait(2600)

// 2) user question
emit('session/event', session, {
  type: 'tool/call',
  data: {
    name: 'ask_user_question',
    callId: 'call-smoke',
    arguments: JSON.stringify({ questions: [{ id: 'q', header: '冒烟测试', question: '装好之后能收到这条通知吗？', options: [{ label: '能' }, { label: '不能' }] }] }),
  },
})
await wait(2600)

// 3) run finished
emit('agent/status', { agent: { session }, status: 'running' })
emit('session/event', session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
emit('agent/status', { agent: { session }, status: 'idle' })

await wait(3000)
console.log('done')
