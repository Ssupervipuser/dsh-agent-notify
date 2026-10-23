---
name: Bug report / 问题反馈
about: A notification did not appear, appeared twice, or the plugin failed to install. / 通知没弹、重复弹、或安装失败。
title: '[bug] '
labels: ['bug']
---

<!--
  Please fill this in. "It doesn't work" is not actionable: this plugin's whole
  job is to hand a payload to Windows, so the useful information is what the log
  said and what Windows did next.

  请把下面的信息填上。"不工作" 没法定位问题——这个插件做的就是把手里的 payload
  交给 Windows，所以真正有用的是日志说了什么、以及 Windows 随后做了什么。
-->

## What happened / 实际现象

<!-- One or two sentences. Which of the three triggers was it: run finished, approval wait, or question wait? -->
<!-- 一两句话。是哪一种触发：任务结束 / 等待授权 / 等待选择？ -->

## What you expected / 期望现象

## Environment / 环境

| Item / 项 | Value / 值 |
| --- | --- |
| Windows version (`winver`) | |
| DSH desktop version | |
| Plugin version (`package.json`) | |
| Install method (`dsh plugin add` / `test/install.mjs`) | |

## Log / 日志

<!--
  Paste the tail of %TEMP%\dsh-agent-notify.log (usually
  C:\Users\<you>\AppData\Local\Temp\dsh-agent-notify.log).
  It records the plugin activation line, every notification's text, the AUMID
  each toast was tried against, and whether the fallback card fired.

  请贴上 %TEMP%\dsh-agent-notify.log 的最后若干行。里面有插件激活一行、
  每次通知的文案、每个 toast 试过的 AUMID、以及是否走了兜底卡片。
-->

```text

```

## Config overrides / 配置覆盖

<!--
  If you changed anything in cordis.patch.yml, paste just the agent-notify
  config block. Note that the row config REPLACES the whole default object, so a
  partial edit silently reverts the keys you left out.

  如果你改过 cordis.patch.yml，只要贴 agent-notify 的 config 段。
  注意行配置是整段替换默认值的，漏写的键会被悄悄还原成默认。
-->

```yaml

```

## Windows notification settings / Windows 通知设置

- [ ] Settings → System → Notifications → **DeepSeek Harness** is on / 系统设置里 "DeepSeek Harness" 通知已开启
- [ ] Focus assist / Do not disturb is off / 专注助手（勿扰）已关闭
- [ ] I checked the log and it shows an AUMID being attempted / 日志里能看出发送时用的 AUMID
