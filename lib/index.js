/**
 * dsh-agent-notify — host half.
 *
 * Fires real Windows notifications (WinRT toast, i.e. Action Center + banner,
 * attributed to the DeepSeek Harness app) for three moments of a root session:
 *
 *   1. run finished   — the agent goes `running` → `idle` after closing a turn;
 *   2. permission wait — a tool call is blocked on user approval (`approval/asked`);
 *   3. user choice wait — the agent asks the user (`ask_user_question` tool call).
 *
 * Subagent sessions are ignored so delegation never spams the desktop.
 *
 * Detection uses documented host extension points:
 *   - `session/event` carries every durable session event: `turn/end`
 *     ({ turn, reason: { kind, message? } }), `approval/asked`
 *     ({ id, toolName, callId?, reason? }), and `tool/call`
 *     ({ turn, step, callId, name, arguments });
 *   - `agent/status` ({ agent, status }) is the harness "run ended" signal the
 *     web UI's running indicator is derived from.
 *
 * Delivery is fire-and-forget: lib/notify.ps1 receives a UTF-8 JSON payload (so
 * CJK text survives), shows the WinRT toast for the first AppUserModelID that
 * accepts it, and falls back to a bundled native card if the toast API is
 * unavailable. Every failure is logged without ever throwing into the loop.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Plugin identity for profile rows. */
export const name = 'agent-notify'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/**
 * Locate a support file next to the implementation, walking up a few levels:
 * the canonical source lives in `lib/`, while the installed copy runs as a
 * versioned build in `lib/releases/` and keeps the scripts one level up.
 */
function supportPath(fileName) {
  let directory = HERE
  for (let depth = 0; depth < 4; depth += 1) {
    const candidate = path.join(directory, fileName)
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return path.join(HERE, fileName)
}

const NOTIFY_SCRIPT = supportPath('notify.ps1')
const LOG_MAX_BYTES = 256 * 1024

const DEFAULTS = {
  enabled: true,
  /** Only notify when the run lasted at least this many seconds. */
  minDurationSec: 0,
  /** WinRT toast duration: 'long' (≈25 s) or 'short' (≈5 s). */
  duration: 'long',
  /** Mute the toast sound (silent="true"). */
  silent: false,
  /** Extra AppUserModelIDs to try; empty = the desktop app's own AUMID first. */
  appId: '',
  /** Draw the native fallback card when the toast API is unavailable. */
  fallbackCard: true,
  /** How long the fallback card stays on screen. */
  cardSeconds: 8,
  /** Skip when the DSH window title already shows this session. */
  skipWhenForeground: false,
  /** Override the headline (e.g. "任务完成"). */
  title: '',
  /** Notify when a tool call waits for the user to grant permission. */
  notifyApprovals: true,
  /** Notify when the agent asks the user a question (ask_user_question). */
  notifyQuestions: true,
  /** Minimum seconds between two waiting alerts for the same session+kind. */
  alertCooldownSec: 20,
}

/** `turn/end` reason kind → headline + fallback-card accent color. */
const REASONS = {
  completed: { headline: '任务完成', accent: '#3DB86E' },
  error: { headline: '任务出错', accent: '#E85454' },
  blocked: { headline: '任务被拦截', accent: '#E89A3D' },
  interrupted: { headline: '任务被中断', accent: '#E89A3D' },
  aborted: { headline: '任务已取消', accent: '#E89A3D' },
  'max-tokens': { headline: '任务达到长度上限', accent: '#E89A3D' },
  forked: { headline: '任务已结束', accent: '#548CE8' },
  unknown: { headline: '任务结束', accent: '#548CE8' },
}

/** Waiting-on-the-user alert kinds → headline + fallback-card accent color. */
const ALERTS = {
  approval: { headline: '需要你的授权', accent: '#E89A3D' },
  question: { headline: '需要你的选择', accent: '#548CE8' },
}

/** Tool names the harness uses for "ask the user a question". */
const TOOL_QUESTION_NAMES = new Set(['ask_user_question', 'request_user_input'])

function debugLogPath() {
  return path.join(tmpdir(), 'dsh-agent-notify.log')
}

/** Append one line to the temp log, rotating once it grows past the cap. */
function logLine(text) {
  try {
    const file = debugLogPath()
    if (existsSync(file) && statSync(file).size > LOG_MAX_BYTES) writeFileSync(file, '')
    appendFileSync(file, `${new Date().toISOString()} ${text}\n`, 'utf8')
  } catch {
    // Logging is diagnostics only.
  }
}

/** Locate Windows PowerShell 5.1 (the only host with the WinRT projection). */
function resolvePowerShell() {
  const root = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows'
  const candidate = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return existsSync(candidate) ? candidate : 'powershell.exe'
}

/** Pure fold over session events: latest `session/title` snapshot, else cwd name. */
export function sessionTitleOf(session) {
  try {
    const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : []
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type !== 'session/title') continue
      const title = event.data?.title
      if (typeof title === 'string' && title.trim() !== '') return title.trim()
    }
  } catch {
    // Fall through to the cwd-based label.
  }
  const cwd = session?.header?.cwd
  if (typeof cwd === 'string' && cwd !== '') {
    const base = path.basename(cwd)
    if (base !== '') return base
  }
  return '当前会话'
}

/** Human duration: 45 秒 / 3 分 12 秒 / 1 小时 4 分. */
export function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.round(totalSeconds))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (minutes < 60) return rest === 0 ? `${minutes} 分` : `${minutes} 分 ${rest} 秒`
  const hours = Math.floor(minutes / 60)
  return `${hours} 小时 ${minutes % 60} 分`
}

/** Build the notification copy for one finished run. */
export function buildNotification({ reasonKind, reasonMessage, title, elapsedSeconds, cfg }) {
  const reason = REASONS[reasonKind] ?? REASONS.unknown
  const headline = cfg.title !== '' ? cfg.title : reason.headline
  const parts = [`「${title}」`]
  if (reasonKind === 'completed') parts.push('已完成')
  else if (reasonKind === 'error') parts.push('出错')
  else if (reasonKind === 'blocked') parts.push('被拦截')
  else if (reasonKind === 'interrupted') parts.push('被中断')
  else if (reasonKind === 'aborted') parts.push('已取消')
  else if (reasonKind === 'max-tokens') parts.push('达到长度上限')
  else parts.push('已结束')
  if (typeof reasonMessage === 'string' && reasonMessage.trim() !== '') {
    const message = reasonMessage.trim().replace(/\s+/g, ' ')
    parts.push(`：${message.length > 120 ? `${message.slice(0, 120)}…` : message}`)
  }
  if (elapsedSeconds >= 1) parts.push(`，用时 ${formatDuration(elapsedSeconds)}`)
  return { headline, body: parts.join(''), accent: reason.accent }
}

/** Pull the first question of an `ask_user_question` tool-call argument JSON. */
export function extractQuestionText(rawArguments) {
  try {
    const parsed = typeof rawArguments === 'string' ? JSON.parse(rawArguments) : rawArguments
    const first = Array.isArray(parsed?.questions) ? parsed.questions[0] : undefined
    if (first === undefined) {
      // Tolerate the flat single-question shape as well.
      if (typeof parsed?.question === 'string' && parsed.question.trim() !== '') return parsed.question.trim()
      return ''
    }
    const header = typeof first.header === 'string' && first.header.trim() !== '' ? `${first.header.trim()}：` : ''
    const question = typeof first.question === 'string' ? first.question.trim() : ''
    const text = `${header}${question}`.trim()
    if (text === '') return ''
    return text.length > 160 ? `${text.slice(0, 160)}…` : text
  } catch {
    return ''
  }
}

/** Build the copy for "the run is waiting on you" alerts. */
export function buildAlert({ kind, title, detail }) {
  const alert = ALERTS[kind] ?? ALERTS.question
  const parts = [`「${title}」`]
  parts.push(kind === 'approval' ? '请求你的授权' : '在等你回答')
  if (typeof detail === 'string' && detail.trim() !== '') {
    const text = detail.trim().replace(/\s+/g, ' ')
    parts.push(`：${text.length > 160 ? `${text.slice(0, 160)}…` : text}`)
  }
  return { headline: alert.headline, body: parts.join(''), accent: alert.accent }
}

/** Fire one notification; never throws. */
export function notify({ headline, body, kind, accent, cfg, skipIfForegroundTitle }) {
  const summary = `notify kind=${kind} title=${JSON.stringify(headline)} body=${JSON.stringify(body)}`
  try {
    if (!existsSync(NOTIFY_SCRIPT)) {
      logLine(`error: missing ${NOTIFY_SCRIPT}`)
      return
    }
    const payload = {
      title: headline,
      body,
      kind,
      silent: cfg.silent === true,
      duration: cfg.duration === 'short' ? 'short' : 'long',
      fallbackCard: cfg.fallbackCard !== false,
      cardSeconds: Math.max(2, Math.round(cfg.cardSeconds)),
      cardAccent: accent,
      appIds: cfg.appId !== '' ? [cfg.appId] : [],
      skipIfForegroundTitle: skipIfForegroundTitle ?? '',
    }
    const payloadPath = path.join(tmpdir(), `dsh-agent-notify-${process.pid}-${Date.now()}.json`)
    writeFileSync(payloadPath, JSON.stringify(payload), 'utf8')

    // Attached spawn with ignored stdio: the notifier outlives this call without
    // holding the host open (`unref`), and a non-detached child keeps the
    // console handles a detached one loses on Windows.
    const child = spawn(resolvePowerShell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', NOTIFY_SCRIPT, '-PayloadPath', payloadPath], {
      stdio: 'ignore',
      windowsHide: true,
    })
    child.on('error', (error) => logLine(`${summary} spawn-error=${error instanceof Error ? error.message : String(error)}`))
    child.unref()
    logLine(summary)
  } catch (error) {
    logLine(`${summary} failed=${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Cordis plugin entry: track root-session runs and notify when they go idle.
 * @param ctx - the plugin context.
 * @param config - row config from the profile patch.
 */
export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) }
  if (cfg.enabled === false) return
  const logger = ctx?.logger
  const warn = (message) => {
    logLine(`warn ${message}`)
    try {
      logger?.warn?.(`[agent-notify] ${message}`)
    } catch {
      // Logger absence is fine.
    }
  }

  /** sessionId → { startedAt, reasonKind, reasonMessage, title } */
  const runs = new Map()
  const MAX_TRACKED = 128

  const prune = () => {
    while (runs.size > MAX_TRACKED) {
      const oldest = runs.keys().next().value
      if (oldest === undefined) return
      runs.delete(oldest)
    }
  }

  const isRoot = (session) => session !== undefined && session !== null && session.header?.origin !== 'subagent'

  /** `${sessionId}:${kind}` → last alert timestamp, so retries cannot spam the desktop. */
  const alertedAt = new Map()
  const alert = (kind, session, detail) => {
    if (kind === 'approval' && cfg.notifyApprovals === false) return
    if (kind === 'question' && cfg.notifyQuestions === false) return
    const title = sessionTitleOf(session)
    const key = `${session.id}:${kind}`
    const now = Date.now()
    const cooldownMs = Math.max(0, Number(cfg.alertCooldownSec) || 0) * 1000
    if (now - (alertedAt.get(key) ?? -Infinity) < cooldownMs) return
    alertedAt.set(key, now)
    while (alertedAt.size > 256) {
      const oldest = alertedAt.keys().next().value
      if (oldest === undefined) break
      alertedAt.delete(oldest)
    }
    const { headline, body, accent } = buildAlert({ kind, title, detail })
    notify({
      headline,
      body,
      kind,
      accent,
      cfg,
      skipIfForegroundTitle: cfg.skipWhenForeground ? title : undefined,
    })
  }

  ctx.on('session/event', (session, event) => {
    try {
      if (!isRoot(session)) return
      const type = event?.type

      // 1. How this turn ended — recorded so the idle notification can explain it.
      if (type === 'turn/end') {
        const sessionId = session.id
        const kind = event.data?.reason?.kind
        const state = runs.get(sessionId) ?? { startedAt: Date.now(), title: sessionTitleOf(session) }
        state.reasonKind = typeof kind === 'string' ? kind : 'unknown'
        const message = event.data?.reason?.message
        state.reasonMessage = typeof message === 'string' ? message : undefined
        state.title = sessionTitleOf(session)
        runs.set(sessionId, state)
        prune()
        return
      }

      // 2. A tool call is blocked waiting for the user to grant permission.
      if (type === 'approval/asked') {
        const toolName = typeof event.data?.toolName === 'string' ? event.data.toolName.trim() : ''
        const reason = typeof event.data?.reason === 'string' ? event.data.reason.trim() : ''
        const detail = [toolName === '' ? '' : `工具 ${toolName}`, reason].filter((part) => part !== '').join(' · ')
        alert('approval', session, detail)
        return
      }

      // 3. The agent asked the user a question (ask_user_question tool call).
      if (type === 'tool/call' && TOOL_QUESTION_NAMES.has(event.data?.name)) {
        alert('question', session, extractQuestionText(event.data?.arguments))
      }
    } catch (error) {
      warn(`session/event handler failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  // `running` starts the clock; the first `idle` after a closed turn notifies once.
  ctx.on('agent/status', ({ agent, status } = {}) => {
    try {
      const session = agent?.session
      if (!isRoot(session)) return
      const sessionId = session.id

      if (status === 'running') {
        const existing = runs.get(sessionId)
        if (existing === undefined) runs.set(sessionId, { startedAt: Date.now(), title: sessionTitleOf(session) })
        prune()
        return
      }
      if (status !== 'idle') return

      const state = runs.get(sessionId)
      runs.delete(sessionId)
      // No observed `running` transition → nothing actually ran (blank session),
      // never notify for that.
      if (state === undefined) return
      const reasonKind = state.reasonKind ?? 'unknown'
      const elapsedSeconds = (Date.now() - state.startedAt) / 1000
      if (elapsedSeconds < cfg.minDurationSec) return
      const title = state.title ?? sessionTitleOf(session)
      const { headline, body, accent } = buildNotification({
        reasonKind,
        reasonMessage: state?.reasonMessage,
        title,
        elapsedSeconds,
        cfg,
      })
      notify({
        headline,
        body,
        kind: reasonKind in REASONS ? reasonKind : 'unknown',
        accent,
        cfg,
        skipIfForegroundTitle: cfg.skipWhenForeground ? title : undefined,
      })
    } catch (error) {
      warn(`agent/status handler failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  logLine(`plugin activated (minDurationSec=${cfg.minDurationSec}, duration=${cfg.duration}, approvals=${cfg.notifyApprovals !== false}, questions=${cfg.notifyQuestions !== false})`)
}
