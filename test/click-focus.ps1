# Verify that clicking a toast brings DeepSeek Harness back to the foreground.
#
# Minimizes the app window, sends a real toast through lib/notify.ps1, finds the
# banner on screen, clicks it, and reports whether the window was restored and
# focused. The window is always restored afterwards, so a failing run cannot leave
# it minimized.
#
# Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File test/click-focus.ps1
param(
  [string]$AppId = '',
  [int]$SendDelayMs = 2600,
  [int]$VerifyMs = 2500,
  [string]$Shot = ''
)
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$notify = Join-Path $repo 'lib\notify.ps1'
if (-not (Test-Path -LiteralPath $notify)) { throw "missing $notify" }

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class ToastClick {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder t, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, UIntPtr e);
  public delegate bool EnumProc(IntPtr hWnd, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public const int SW_MINIMIZE = 6;
  public const int SW_RESTORE = 9;
  public const uint LEFTDOWN = 0x0002;
  public const uint LEFTUP = 0x0004;

  public static IntPtr FindAppWindow() {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      GetWindowText(h, sb, sb.Capacity);
      var t = sb.ToString();
      if (t.Contains("DeepSeek Harness")) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  /** The toast banner is the visible window in the bottom-right corner. */
  public static int[] FindBanner(int screenW, int screenH) {
    int[] hit = null;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      RECT r;
      if (!GetWindowRect(h, out r)) return true;
      int w = r.Right - r.Left, hh = r.Bottom - r.Top;
      bool bottomRight = r.Left > screenW * 0.60 && r.Top > screenH * 0.55;
      bool plausible = w > 240 && w < 720 && hh > 60 && hh < 260;
      if (bottomRight && plausible) { hit = new int[] { r.Left, r.Top, r.Right, r.Bottom }; return false; }
      return true;
    }, IntPtr.Zero);
    return hit;
  }

  public static string TitleOf(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, sb.Capacity); return sb.ToString(); }
  public static void Click(int x, int y) {
    SetCursorPos(x, y); System.Threading.Thread.Sleep(150);
    mouse_event(LEFTDOWN, 0, 0, 0, UIntPtr.Zero); System.Threading.Thread.Sleep(70);
    mouse_event(LEFTUP, 0, 0, 0, UIntPtr.Zero);
  }
}
'@
$null = [ToastClick]::SetProcessDpiAwarenessContext([IntPtr](-4))
Add-Type -AssemblyName System.Drawing, System.Windows.Forms
$screenW = [ToastClick]::GetSystemMetrics(0)
$screenH = [ToastClick]::GetSystemMetrics(1)

$window = [ToastClick]::FindAppWindow()
if ($window -eq [IntPtr]::Zero) { Write-Output 'SKIP: DeepSeek Harness window not found'; exit 2 }

$result = 1
try {
  $null = [ToastClick]::ShowWindow($window, [ToastClick]::SW_MINIMIZE)
  Start-Sleep -Milliseconds 700
  Write-Output "app minimized = $([ToastClick]::IsIconic($window))"

  $payload = Join-Path $env:TEMP ("dsh-click-probe-{0}.json" -f [guid]::NewGuid().ToString('n'))
  $json = @{ title = '点击测试'; body = '点击这条通知应恢复 DeepSeek Harness'; kind = 'completed'; duration = 'long'; fallbackCard = $false } | ConvertTo-Json -Compress
  if ($AppId -ne '') { $json = (@{ title = '点击测试'; body = '点击这条通知应恢复 DeepSeek Harness'; kind = 'completed'; duration = 'long'; fallbackCard = $false; appIds = @($AppId) } | ConvertTo-Json -Compress) }
  [System.IO.File]::WriteAllText($payload, $json, [System.Text.UTF8Encoding]::new($false))
  & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File $notify -PayloadPath $payload
  Start-Sleep -Milliseconds $SendDelayMs

  if ($Shot -ne '') {
    $bmp = New-Object System.Drawing.Bitmap $screenW, $screenH
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen(0, 0, 0, 0, (New-Object System.Drawing.Size($screenW, $screenH)))
    $g.Dispose(); $bmp.Save($Shot, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
    Write-Output "captured -> $Shot"
  }

  # The toast banner is a Shell XAML island, not an enumerable top-level window, so
  # it cannot be found by class/title. Its placement is stable though: roughly
  # 440x106 anchored above the taskbar in the bottom-right corner, so aim at the
  # middle of that box rather than at the screen edge.
  $bannerW = 440
  $bannerH = 106
  $taskbar = $screenH - (([System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea.Bottom))
  $right = $screenW - 20
  $bottom = $screenH - $taskbar - 14
  $clickX = $right - [int]($bannerW / 2)
  $clickY = $bottom - [int]($bannerH / 2)
  Write-Output "clicking banner body at ($clickX, $clickY) on ${screenW}x${screenH}"
  [ToastClick]::Click($clickX, $clickY)

  Start-Sleep -Milliseconds $VerifyMs
  $iconic = [ToastClick]::IsIconic($window)
  $foreground = [ToastClick]::TitleOf([ToastClick]::GetForegroundWindow())
  Write-Output "after click: minimized=$iconic foreground=[$foreground]"
  if (-not $iconic -and $foreground -like '*DeepSeek Harness*') {
    Write-Output 'PASS: clicking the toast focused the app'
    $result = 0
  } else {
    Write-Output 'FAIL: click did not focus the app'
  }
} finally {
  if ([ToastClick]::IsIconic($window)) {
    $null = [ToastClick]::ShowWindow($window, [ToastClick]::SW_RESTORE)
    $null = [ToastClick]::SetForegroundWindow($window)
    Write-Output 'restored app window'
  }
}
exit $result
