# dsh-agent-notify — real Windows notification entry point.
#
# Sends a genuine WinRT toast (Windows Action Center + banner, attributed to the
# DeepSeek Harness app) for a finished agent run. The payload travels through a
# UTF-8 JSON file, never through command-line arguments or the console codepage,
# so CJK titles/bodies arrive intact.
#
# Order of attempts:
#   1. Toast via every candidate AppUserModelID (the desktop app's own AUMID
#      first, so the banner shows the DeepSeek Harness name and icon).
#   2. If no AUMID is accepted or the toast API throws, fall back to the bundled
#      WPF card (card.ps1) — still a native desktop window, never a browser popup.
#
# Any failure exits quietly: a finished run must never surface a script error.
param([Parameter(Mandatory = $true)][string]$PayloadPath)

$ErrorActionPreference = 'Stop'

# Never let a script failure surface anywhere: record it and exit quietly.
trap {
  try {
    $logPath = Join-Path ([System.IO.Path]::GetTempPath()) 'dsh-agent-notify.log'
    Add-Content -LiteralPath $logPath -Value ("{0:o} [notify.ps1] fatal: {1}" -f (Get-Date), $_.Exception.Message) -Encoding UTF8
  } catch { }
  exit 0
}

function Write-Trace([string]$text) {
  try {
    $logPath = Join-Path ([System.IO.Path]::GetTempPath()) 'dsh-agent-notify.log'
    Add-Content -LiteralPath $logPath -Value ("{0:o} [notify.ps1] {1}" -f (Get-Date), $text) -Encoding UTF8
  } catch { }
}

function Read-Payload([string]$path) {
  try {
    $raw = Get-Content -LiteralPath $path -Raw -Encoding UTF8
    return ($raw | ConvertFrom-Json)
  } catch {
    Write-Trace ("payload read failed: {0}" -f $_.Exception.Message)
    return $null
  } finally {
    Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
  }
}

function Get-ForegroundTitle {
  try {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class DshNotifyForeground {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  public static string Title() {
    var sb = new StringBuilder(1024);
    GetWindowText(GetForegroundWindow(), sb, sb.Capacity);
    return sb.ToString();
  }
}
'@ -ErrorAction SilentlyContinue
    return [DshNotifyForeground]::Title()
  } catch {
    return ''
  }
}

# NB: do not name this `$payload` — the string-typed parameter above owns that
# name and would coerce the parsed object back into text.
$data = Read-Payload $PayloadPath
if ($null -eq $data) { exit 0 }

$title = [string]$data.title
$body = [string]$data.body
$kind = if ($data.kind) { [string]$data.kind } else { 'completed' }
$silent = $data.silent -eq $true
$duration = if ($data.duration -eq 'short') { 'short' } else { 'long' }
$skipTitle = if ($data.skipIfForegroundTitle) { [string]$data.skipIfForegroundTitle } else { '' }
$appIds = @()
if ($data.appIds) { $appIds = @($data.appIds | ForEach-Object { [string]$_ }) }
if ($appIds.Count -eq 0) { $appIds = @('com.deepseek.dsh', 'DeepSeek.Harness.TaskNotify') }
if ($title -eq '') { $title = 'DeepSeek Harness' }

if ($skipTitle -ne '') {
  $foreground = Get-ForegroundTitle
  if ($foreground -ne '' -and $foreground.Contains($skipTitle)) {
    Write-Trace 'skipped: foreground already shows this session'
    exit 0
  }
}

# ── 1. Real Windows toast (Action Center + banner) ────────────────────────────
$shown = $false
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
  $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
  $texts = $template.GetElementsByTagName('text')
  $null = $texts.Item(0).AppendChild($template.CreateTextNode($title))
  $null = $texts.Item(1).AppendChild($template.CreateTextNode($body))
  $root = $template.DocumentElement
  $null = $root.SetAttribute('duration', $duration)
  if ($silent) { $null = $root.SetAttribute('silent', 'true') }

  foreach ($appId in $appIds) {
    try {
      $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId)
      $notifier.Show([Windows.UI.Notifications.ToastNotification]::new($template))
      $shown = $true
      Write-Trace ("toast shown appId={0} setting={1}" -f $appId, $notifier.Setting)
      break
    } catch {
      Write-Trace ("toast rejected appId={0}: {1}" -f $appId, $_.Exception.Message)
    }
  }
} catch {
  Write-Trace ("toast unavailable: {0}" -f $_.Exception.Message)
}

# ── 2. Native card fallback (systems without the toast API) ───────────────────
if (-not $shown -and $data.fallbackCard -ne $false) {
  $cardScript = Join-Path $PSScriptRoot 'card.ps1'
  if (Test-Path -LiteralPath $cardScript) {
    $cardArgs = @{
      Title   = $title
      Body    = $body
      Kind    = if ($kind -in @('completed', 'error', 'blocked', 'interrupted', 'max-tokens', 'approval', 'question')) { $kind } else { 'unknown' }
      Seconds = if ($data.cardSeconds) { [int]$data.cardSeconds } else { 8 }
      NoSound = $silent
    }
    if ($data.cardAccent) { $cardArgs.Accent = [string]$data.cardAccent }
    try {
      & $cardScript @cardArgs
    } catch {
      Write-Trace ("card fallback failed: {0}" -f $_.Exception.Message)
    }
  }
}
