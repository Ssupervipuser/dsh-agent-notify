// Manual harness for dsh-agent-notify's host logic + real notification rendering.
// Runs the plugin against a fake Cordis ctx, replays a run lifecycle plus the two
// "waiting on the user" moments, and lets the real PowerShell notifier fire so
// both the logic and the visual result can be inspected.
import { apply, buildAlert, buildNotification, extractQuestionText, formatDuration, sessionTitleOf } from '../lib/index.js'

const handlers = new Map()
const ctx = {
  on(event, handler) {
    if (!handlers.has(event)) handlers.set(event, [])
    handlers.get(event).push(handler)
    return () => {}
  },
  logger: { warn: (message) => console.log('[logger.warn]', message) },
}

const title = '国内IP直连不走Warp脚本'
const session = {
  id: 'session-test-1',
  header: { id: 'session-test-1', cwd: process.cwd() },
  snapshotEvents: () => [{ type: 'session/title', data: { title } }],
}
const subagentSession = {
  id: 'session-test-child',
  header: { id: 'session-test-child', cwd: 'C:\\tmp', origin: 'subagent' },
  snapshotEvents: () => [],
}

const emit = (event, ...args) => {
  for (const handler of handlers.get(event) ?? []) handler(...args)
}

const questionArguments = JSON.stringify({
  questions: [{ id: 'q1', header: '通知策略', question: '要改成只在前台时通知吗？', options: [{ label: '是' }, { label: '否' }] }],
})

// Self-checks for the pure helpers.
const checks = [
  ['formatDuration 45', formatDuration(45) === '45 秒'],
  ['formatDuration 192', formatDuration(192) === '3 分 12 秒'],
  ['formatDuration 3900', formatDuration(3900) === '1 小时 5 分'],
  ['sessionTitleOf folds session/title', sessionTitleOf(session) === title],
  ['sessionTitleOf falls back to cwd', sessionTitleOf({ header: { cwd: 'C:\\a\\my-project' } }) === 'my-project'],
  ['extractQuestionText header+question', extractQuestionText(questionArguments) === '通知策略：要改成只在前台时通知吗？'],
  ['extractQuestionText flat shape', extractQuestionText('{"question":"只问一句"}') === '只问一句'],
  ['extractQuestionText bad json', extractQuestionText('not json') === ''],
  ['buildAlert approval copy', buildAlert({ kind: 'approval', title, detail: '工具 pwsh · 需要写目录外文件' }).headline === '需要你的授权'],
  ['buildAlert question copy', buildAlert({ kind: 'question', title, detail: '通知策略：要改吗？' }).headline === '需要你的选择'],
]
let failed = 0
for (const [label, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`)
  if (!ok) failed += 1
}
const built = buildNotification({ reasonKind: 'completed', title, elapsedSeconds: 133, cfg: { title: '' } })
console.log('built:', JSON.stringify(built))

apply(ctx, { durationSec: 18, minDurationSec: 0, alertCooldownSec: 20 })

// Subagent sessions never notify: none of their state may be recorded.
emit('agent/status', { agent: { session: subagentSession }, status: 'running' })
emit('session/event', subagentSession, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
emit('session/event', subagentSession, { type: 'approval/asked', data: { id: 'ap0', toolName: 'pwsh' } })
emit('agent/status', { agent: { session: subagentSession }, status: 'idle' })

// 1) A real root run: running → one closed turn → idle (completion toast).
emit('agent/status', { agent: { session }, status: 'running' })
emit('session/event', session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
emit('agent/status', { agent: { session }, status: 'idle' })

// 2) Permission request while the run is blocked (approval toast).
emit('session/event', session, { type: 'approval/asked', data: { id: 'ap1', toolName: 'pwsh', reason: '需要写入会话目录以外的文件' } })

// 3) Agent asks the user a question (question toast).
emit('session/event', session, { type: 'tool/call', data: { name: 'ask_user_question', callId: 'call-1', arguments: questionArguments } })

// 4) A retry within the cooldown window must not fire a second approval toast.
emit('session/event', session, { type: 'approval/asked', data: { id: 'ap2', toolName: 'pwsh' } })

console.log(failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`)

// Stay alive long enough for the notifier processes to start (the DSH host is
// long-lived; this only emulates it for a manual run).
await new Promise((resolve) => setTimeout(resolve, 5000))
console.log('done')
