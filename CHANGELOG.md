# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] - 2026-11-12

### Fixed

- A single event could deliver **two** notifications. Listener registration was not
  idempotent: every `apply()` (config reload, HMR re-activation) added another
  `session/event` + `agent/status` listener set to the same Cordis context, so each
  event was handled and delivered twice. Registration now disposes the previous set
  before installing a new one, and the listeners are owned by `ctx.effect()` so a
  torn-down fiber removes them. (`test/double-notify.mjs` covers this.)

### Added

- `test/double-notify.mjs` — regression test proving repeated `apply()` keeps exactly
  one listener set and one notification per finished run, plus fiber-disposal,
  re-enable, `enabled:false` and subagent-skip cases.
- Activation log now reports `listeners=N` so duplicate mounting is visible.

## [0.2.0] - 2026-11-06

### Fixed

- Toasts were attributed to a hardcoded `com.deepseek.dsh`, which the installed app
  build does not register: Windows rendered the raw id as the app name, drew no icon,
  and the click had no activation target. The AppUserModelID is now discovered from
  the app's own Start Menu shortcut, and only registered ids are used.
- Clicking a notification now brings the existing window to the front (the app's
  single-instance lock turns the AUMID shortcut activation into a focus).

### Added

- End-to-end click verification (`test/click-focus.ps1`), script syntax checking
  (`test/parse-check.ps1`), and privacy-safe screenshot capture
  (`docs/capture-crop.ps1`).

## [0.1.0] - 2026-10-17

### Added

- First release: real Windows notifications (WinRT toast, attributed to the DeepSeek
  Harness app) when an agent run finishes, waits for tool approval, or asks the user
  a question. Subagent sessions are skipped, and waiting alerts are rate-limited per
  session and kind.
- Native WPF card fallback for systems without the toast API.
- UTF-8 JSON task file between the host and `notify.ps1`, so CJK text survives.

[0.2.1]: https://github.com/Ssupervipuser/dsh-agent-notify/releases/tag/v0.2.1
[0.2.0]: https://github.com/Ssupervipuser/dsh-agent-notify/releases/tag/v0.2.0
[0.1.0]: https://github.com/Ssupervipuser/dsh-agent-notify/releases/tag/v0.1.0
