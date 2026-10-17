# dsh-agent-notify

DSH 插件：**Agent 需要你的时候，发一条真正的 Windows 系统通知**（WinRT Toast，右下角横幅 + Windows 通知中心，来源显示 “DeepSeek Harness”，点击可回到应用）。

覆盖三种时机：

| 时机 | 触发事件 | 通知标题 |
| --- | --- | --- |
| 任务跑完 | `agent/status` 从 `running` 回到 `idle`（期间有 `turn/end`） | 任务完成 / 任务出错 / 任务被拦截 …（按结束原因） |
| 需要授权 | 会话事件 `approval/asked`（工具调用被权限确认卡住） | 需要你的授权 |
| 需要你选择 | 会话事件 `tool/call` 且工具为 `ask_user_question` | 需要你的选择 |

子会话（subagent）全部跳过，所以 agent team / 子代理不会刷屏；同一会话同类等待通知默认 20 秒冷却，重试不会连发。

## 通道

- **主通道**：`lib/notify.ps1` 调 WinRT `ToastNotificationManager`，用 DSH 桌面应用自己的 AppUserModelID（`com.deepseek.dsh`）发送，所以系统里显示为 “DeepSeek Harness” 的通知，进通知中心、可点回应用。
- **兜底**：系统没有 Toast API 或 AUMID 被拒时，用 `lib/card.ps1` 画一张原生置顶卡片（不是网页弹窗）。
- **中文不乱码**：文案通过 UTF-8 JSON 任务单文件传给 PowerShell，不走命令行码页。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖 `agent-notify` 这一行的 `config`（整段替换，保留需要的键）：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `minDurationSec` | `0` | 只通知耗时超过 N 秒的“任务完成”（0 = 总是通知） |
| `duration` | `long` | Toast 停留时长：`long`（≈25 秒）/ `short`（≈5 秒） |
| `silent` | `false` | 静音（`silent="true"`） |
| `appId` | `''` | 指定 AppUserModelID；空 = 先用桌面应用自己的 AUMID |
| `fallbackCard` | `true` | Toast 不可用时是否画兜底卡片 |
| `cardSeconds` | `8` | 兜底卡片停留秒数 |
| `skipWhenForeground` | `false` | 当前窗口标题已包含该会话时跳过通知 |
| `title` | `''` | 覆盖“任务完成”标题行；空 = 按结束原因自动取 |
| `notifyApprovals` | `true` | 权限请求（需要授权）时通知 |
| `notifyQuestions` | `true` | 需要用户选择/回答时通知 |
| `alertCooldownSec` | `20` | 同一会话同类等待通知的最小间隔（秒） |

## 安装 / 更新

```powershell
# 工作区里执行：复制到 profile、注册依赖与 bundle、发布新构建
node dsh-agent-notify/test/install.mjs
```

脚本会：备份 profile 清单 → 发布 `lib/releases/impl-<build>.js` → 写入稳定入口 shim → 更新 `package.json` 依赖与 `dsh.profile.bundles`。

> **Windows 硬链接**：pnpm 安装 `file:` 依赖时是用**硬链接**把插件连进 `node_modules` 的，所以安装副本里的文件和插件源码通常是**同一个文件**（`fsutil hardlink list <安装副本里的文件>` 会同时列出两个路径）。此时往里写不是“复制”而是**直接改源文件**：`writeFileSync` 会把源码截断成 shim，`cpSync` 会直接报 `ERR_FS_CP_EINVAL`。脚本已在每次写入前先 `rmSync` 掉目标目录项（`detach()`）来断开硬链接，所以正常情况是安全的；跑完会打印 `broke N hardlink(s)` 告诉你断开了哪些。
>
> 想验证这一点（不会动到真实 profile）：`node test/hardlink-safety.mjs`，它在临时目录里按同样方式建硬链接再跑安装，然后断言源码哈希没变。也可以设 `DSH_PROFILE_DIR=<某目录>` 把安装重定向到沙盒里。

**热更新原理**：DSH 宿主按 URL 缓存 ESM 模块，直接改入口文件不会生效。所以安装副本里 `lib/index.js` 是一个永不变化的 shim，它每次激活时读 `lib/current-build.txt` 并 `import()` 对应的 `lib/releases/impl-*.js`；重新发布后只要配置重载（保存 profile `package.json` / 行开关切换都会触发），新代码就生效，**无需重启应用**。工作区里的 `lib/index.js` 始终是真正的实现源码。

如果改了 `lib/index.js` 之后没有自动生效：切换一下插件行开关（`cordis.patch.yml` 里 `- id: agent-notify` + `disabled: true` 保存，再改回 `false`），或重启应用。

## 卸载

1. 从 profile `package.json` 的 `dsh.profile.bundles` 与 `dependencies` 删掉 `dsh-agent-notify`；
2. 删除 `node_modules/dsh-agent-notify`；
3. 保存后配置自动重载，通知即停止。

## 排查

日志：`%TEMP%\dsh-agent-notify.log`（插件激活、每次通知文案、Toast 用的 AUMID 与结果、兜底卡片是否触发）。

- **通知没出现**：确认 Windows 设置 → 系统 → 通知里 “DeepSeek Harness” 是开启的，且没开专注/勿扰；勿扰时横幅不弹，但会进通知中心。
- **Toast 被拒**：日志出现 `toast rejected appId=...` 时会走卡片兜底，可用配置 `appId` 指定其他已注册 AUMID。
- **子会话不通知**：故意设计。
- **本地验证**：`node dsh-agent-notify/test/manual-test.mjs` 用假 ctx 回放一次 run + 授权 + 提问，会真的弹出三条通知（并自检文案/冷却逻辑）。

## 文件

| 文件 | 作用 |
| --- | --- |
| `lib/index.js` | 宿主插件实现：监听 `session/event`、`agent/status`，组装文案，生成 UTF-8 JSON 任务单并拉起通知进程 |
| `lib/notify.ps1` | WinRT Toast 主通道（读 JSON 任务单），失败时调 `card.ps1` |
| `lib/card.ps1` | 原生置顶通知卡片（兜底） |
| `cordis.patch.yml` | bundle patch：插入 `agent-notify` 行 |
| `test/manual-test.mjs` | 无 DSH 的本地验证（逻辑自检 + 真实弹通知） |
| `test/install.mjs` | 安装/更新到 profile（含热更新 shim；写入前断开硬链接） |
| `test/hardlink-safety.mjs` | 回归测试：在沙盒里复现 pnpm 硬链接布局，断言安装不会破坏源码 |
| `test/hot-reload-probe.mjs` | 切换插件行开关，验证配置重载 |
| `docs/toast-verified.png` | 实测截图：任务完成通知 |
| `docs/toast-alerts.png` | 实测截图：需要选择通知 |
