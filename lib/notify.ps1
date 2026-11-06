# dsh-agent-notify — real Windows notification entry point.
#
# Sends a genuine WinRT toast (Windows Action Center + banner) for a finished or
# blocked agent run. The payload travels through a UTF-8 JSON file, never through
# command-line arguments or the console codepage, so CJK titles/bodies arrive
# intact.
#
# Identity: a toast is only attributed (app name + icon + click target) when its
# AppUserModelID is registered by a Start Menu shortcut. The id is therefore
# discovered from the running app's own shortcut instead of being hardcoded;
# `com.deepseek.dsh` and other stale ids are gone, because sending to an
# unregistered id silently yields a banner titled with the raw id, no icon, and a
# click that activates nothing.
#
# Click: an unpackaged toast activates the Start Menu shortcut that owns its
# AUMID, so a click merely relaunches the app; the app's single-instance lock
# turns that into a focus of the existing window instead of a second copy. Only an
# explicit `launch` in the payload overrides that target.
#
# Fallback: if no toast API or no registered id is available, the bundled native
# card (card.ps1) is shown instead — still a desktop notification, never a popup.
#
# Any failure exits quietly: a finished run must never surface a script error.
param([Parameter(Mandatory = $true)][string]$PayloadPath)

$ErrorActionPreference = 'Stop'

function Get-LogPath {
  return (Join-Path ([System.IO.Path]::GetTempPath()) 'dsh-agent-notify.log')
}

# Never let a script failure surface anywhere: record it and exit quietly.
trap {
  try {
    Add-Content -LiteralPath (Get-LogPath) -Value ("{0:o} [notify.ps1] fatal: {1}" -f (Get-Date), $_.Exception.Message) -Encoding UTF8
  } catch { }
  exit 0
}

function Write-Trace([string]$text) {
  try {
    Add-Content -LiteralPath (Get-LogPath) -Value ("{0:o} [notify.ps1] {1}" -f (Get-Date), $text) -Encoding UTF8
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

<#
  Discover AppUserModelIDs that Windows can actually attribute.

  A toast's identity comes from a Start Menu shortcut whose System.AppUserModel.ID
  is set; without it CreateToastNotifier still succeeds but Windows renders the
  raw id as the app name, drops the icon, and gives the click no target. Only ids
  that a Start Menu shortcut registers are returned, so the caller never sends to
  an id that would look broken.
#>
function Get-RegisteredAppIds {
  $found = New-Object System.Collections.Generic.List[string]
  $shell = New-Object -ComObject Shell.Application
  $roots = @(
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
    'C:\ProgramData\Microsoft\Windows\Start Menu\Programs'
  )
  foreach ($root in $roots) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    $shortcuts = Get-ChildItem -LiteralPath $root -Recurse -Filter '*.lnk' -ErrorAction SilentlyContinue |
      Where-Object { $_.BaseName -match 'DeepSeek|(?<![a-z])dsh(?![a-z])' }
    foreach ($shortcut in $shortcuts) {
      try {
        $folder = $shell.NameSpace($shortcut.DirectoryName)
        if ($null -eq $folder) { continue }
        $item = $folder.ParseName($shortcut.Name)
        if ($null -eq $item) { continue }
        $id = [string]$item.ExtendedProperty('System.AppUserModel.ID')
        if ($id -ne '' -and -not $found.Contains($id)) { $found.Add($id) }
      } catch { }
    }
  }
  return $found
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
$launch = if ($data.launch) { [string]$data.launch } else { '' }
if ($title -eq '') { $title = 'DeepSeek Harness' }

if ($skipTitle -ne '') {
  $foreground = Get-ForegroundTitle
  if ($foreground -ne '' -and $foreground.Contains($skipTitle)) {
    Write-Trace 'skipped: foreground already shows this session'
    exit 0
  }
}

# Candidate ids: an explicit config override, the built-in defaults, then every id
# a Start Menu shortcut registers (so a renamed app build keeps working).
$candidates = New-Object System.Collections.Generic.List[string]
if ($data.appIds) {
  foreach ($id in @($data.appIds)) {
    if ([string]$id -ne '' -and -not $candidates.Contains([string]$id)) { $candidates.Add([string]$id) }
  }
}
foreach ($id in @('electron.app.DeepSeek Harness', 'com.deepseek.dsh')) {
  if (-not $candidates.Contains($id)) { $candidates.Add($id) }
}
$registered = Get-RegisteredAppIds
Write-Trace ("registered AUMIDs: {0}" -f ($registered -join ' | '))
foreach ($id in $registered) {
  if (-not $candidates.Contains($id)) { $candidates.Add($id) }
}

# An unregistered id does NOT throw at CreateToastNotifier: Windows accepts it,
# then renders the raw id as the app name with no icon and a click that activates
# nothing. Only ids backed by a Start Menu shortcut can be attributed, so restrict
# the send to those (or to one the user explicitly pinned in config).
if ($registered.Count -gt 0) {
  $attributable = New-Object System.Collections.Generic.List[string]
  foreach ($id in $candidates) {
    if ($registered.Contains($id)) { $attributable.Add($id) }
  }
  if ($attributable.Count -gt 0) { $candidates = $attributable }
  else {
    Write-Trace ("no candidate matches a registered shortcut; keeping {0} as best effort" -f $candidates[0])
  }
} else {
  Write-Trace 'no Start Menu shortcut exposed an AUMID; toasted identity may be unattributed'
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
  # Activate the app itself on click (single-instance => focuses the window).
  if ($launch -ne '') { $null = $root.SetAttribute('launch', $launch) }

  foreach ($appId in $candidates) {
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
