# dsh-agent-notify — desktop notification card shown by the host plugin when a
# DeepSeek Harness agent run finishes.
#
# Rendered as a borderless, always-on-top, never-focus-stealing WPF card in the
# bottom-right corner of the primary work area. Windows toast banners are
# suppressed while the DSH window covers the screen / Do Not Disturb is on, so
# this card is the notification channel that always shows. Any failure exits
# silently and never blocks the host.
param(
  [Parameter(Mandatory = $true)][string]$Title,
  [Parameter(Mandatory = $true)][string]$Body,
  [ValidateSet('completed', 'error', 'blocked', 'interrupted', 'max-tokens', 'unknown', 'approval', 'question')]
  [string]$Kind = 'completed',
  [int]$Seconds = 8,
  [string]$Accent = '',
  [switch]$NoSound,
  [string]$SkipIfForegroundTitle = '',
  [string]$DebugLog = ''
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Drawing

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class DshNotifyNative
{
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int index);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int index, IntPtr value);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);

    public const int GWL_EXSTYLE = -20;
    public const long WS_EX_TOOLWINDOW = 0x00000080L;
    public const long WS_EX_NOACTIVATE = 0x08000000L;
    public const uint SWP_NOSIZE = 0x0001;
    public const uint SWP_NOMOVE = 0x0002;
    public const uint SWP_NOACTIVATE = 0x0010;
    public const uint SWP_SHOWWINDOW = 0x0040;

    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

    public static string ForegroundTitle()
    {
        var sb = new StringBuilder(1024);
        GetWindowText(GetForegroundWindow(), sb, sb.Capacity);
        return sb.ToString();
    }

    public static void MakeNoActivate(IntPtr hwnd)
    {
        long ex = GetWindowLongPtr(hwnd, GWL_EXSTYLE).ToInt64();
        SetWindowLongPtr(hwnd, GWL_EXSTYLE, new IntPtr(ex | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE));
    }

    public static void KeepAbove(IntPtr hwnd)
    {
        SetWindowPos(hwnd, new IntPtr(-1), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
    }

    /// <summary>Visible notification cards already on this desktop, top-to-bottom.</summary>
    public static List<int[]> ExistingCards(string title)
    {
        var found = new List<int[]>();
        EnumWindows((h, l) =>
        {
            if (!IsWindowVisible(h)) return true;
            var sb = new StringBuilder(512);
            GetWindowText(h, sb, sb.Capacity);
            if (sb.ToString() != title) return true;
            RECT r;
            if (GetWindowRect(h, out r)) found.Add(new int[] { r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top });
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
'@

function Write-DebugLog([string]$text) {
  if ($DebugLog -eq '') { return }
  try { Add-Content -Path $DebugLog -Value ("{0:o} {1}" -f (Get-Date), $text) -Encoding UTF8 } catch { }
}

try {
  # ── skip when the user is already looking at this session ───────────────────
  if ($SkipIfForegroundTitle -ne '') {
    try {
      if ([DshNotifyNative]::ForegroundTitle().Contains($SkipIfForegroundTitle)) {
        Write-DebugLog 'skipped: foreground shows this session'
        exit 0
      }
    } catch { }
  }

  $accentFallback = switch ($Kind) {
    'completed'   { [System.Windows.Media.Color]::FromRgb(0x3D, 0xB8, 0x6E) }
    'error'       { [System.Windows.Media.Color]::FromRgb(0xE8, 0x54, 0x54) }
    'blocked'     { [System.Windows.Media.Color]::FromRgb(0xE8, 0x9A, 0x3D) }
    'interrupted' { [System.Windows.Media.Color]::FromRgb(0xE8, 0x9A, 0x3D) }
    'max-tokens'  { [System.Windows.Media.Color]::FromRgb(0xE8, 0x9A, 0x3D) }
    'approval'    { [System.Windows.Media.Color]::FromRgb(0xE8, 0x9A, 0x3D) }
    'question'    { [System.Windows.Media.Color]::FromRgb(0x54, 0x8C, 0xE8) }
    default       { [System.Windows.Media.Color]::FromRgb(0x54, 0x8C, 0xE8) }
  }
  $accentColor = $accentFallback
  if ($Accent -match '^#?([0-9a-fA-F]{6})$') {
    $v = [Convert]::ToInt32($Matches[1], 16)
    $accentColor = [System.Windows.Media.Color]::FromRgb(($v -shr 16) -band 0xFF, ($v -shr 8) -band 0xFF, $v -band 0xFF)
  }
  $accentBrush = New-Object System.Windows.Media.SolidColorBrush $accentColor
  $cardBrush = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromRgb(0x1E, 0x1E, 0x21))
  $borderBrush = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromRgb(0x3C, 0x3C, 0x42))
  $titleBrush = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromRgb(0xF5, 0xF5, 0xF5))
  $bodyBrush = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromRgb(0xBE, 0xBE, 0xC6))
  $font = New-Object System.Windows.Media.FontFamily('Microsoft YaHei UI, Segoe UI')

  $width = 392
  $margin = 16
  $gap = 8
  $windowTitle = 'DSH.TaskNotify.Card'

  $window = New-Object System.Windows.Window
  $window.Title = $windowTitle
  $window.WindowStyle = 'None'
  $window.AllowsTransparency = $true
  $window.Background = [System.Windows.Media.Brushes]::Transparent
  $window.ShowInTaskbar = $false
  $window.ShowActivated = $false
  $window.Topmost = $true
  $window.ResizeMode = 'NoResize'
  $window.Width = $width
  $window.SizeToContent = 'Height'
  $window.UseLayoutRounding = $true
  $window.SnapsToDevicePixels = $true
  $window.Focusable = $false
  $window.Left = [System.Windows.SystemParameters]::WorkArea.Right - $width - $margin
  $window.Top = [System.Windows.SystemParameters]::WorkArea.Bottom - 120

  # Card body: accent column + text column.
  $card = New-Object System.Windows.Controls.Border
  $card.CornerRadius = New-Object System.Windows.CornerRadius(10)
  $card.Background = $cardBrush
  $card.BorderBrush = $borderBrush
  $card.BorderThickness = New-Object System.Windows.Thickness(1)
  $card.ClipToBounds = $true
  $shadow = New-Object System.Windows.Media.Effects.DropShadowEffect
  $shadow.BlurRadius = 20
  $shadow.Opacity = 0.5
  $shadow.ShadowDepth = 5
  $shadow.Color = [System.Windows.Media.Colors]::Black
  $card.Effect = $shadow

  $grid = New-Object System.Windows.Controls.Grid
  $colAccent = New-Object System.Windows.Controls.ColumnDefinition
  $colAccent.Width = New-Object System.Windows.GridLength(4)
  $colBody = New-Object System.Windows.Controls.ColumnDefinition
  $colBody.Width = New-Object System.Windows.GridLength(1, [System.Windows.GridUnitType]::Star)
  $null = $grid.ColumnDefinitions.Add($colAccent)
  $null = $grid.ColumnDefinitions.Add($colBody)

  $accentBar = New-Object System.Windows.Controls.Border
  $accentBar.Background = $accentBrush
  # Round only the outer (left) corners so the bar follows the card's rounded edge.
  $accentBar.CornerRadius = New-Object System.Windows.CornerRadius(10, 0, 0, 10)
  [System.Windows.Controls.Grid]::SetColumn($accentBar, 0)

  $content = New-Object System.Windows.Controls.StackPanel
  $content.Margin = New-Object System.Windows.Thickness(16, 12, 16, 13)
  [System.Windows.Controls.Grid]::SetColumn($content, 1)

  $titleBlock = New-Object System.Windows.Controls.TextBlock
  $titleBlock.Text = $Title
  $titleBlock.FontFamily = $font
  $titleBlock.FontSize = 14
  $titleBlock.FontWeight = 'Bold'
  $titleBlock.Foreground = $titleBrush
  $titleBlock.TextTrimming = 'CharacterEllipsis'

  $bodyBlock = New-Object System.Windows.Controls.TextBlock
  $bodyBlock.Text = $Body
  $bodyBlock.FontFamily = $font
  $bodyBlock.FontSize = 12.5
  $bodyBlock.Margin = New-Object System.Windows.Thickness(0, 5, 0, 0)
  $bodyBlock.Foreground = $bodyBrush
  $bodyBlock.TextWrapping = 'Wrap'
  $bodyBlock.LineHeight = 18

  $null = $content.Children.Add($titleBlock)
  $null = $content.Children.Add($bodyBlock)
  $null = $grid.Children.Add($accentBar)
  $null = $grid.Children.Add($content)
  $card.Child = $grid
  $window.Content = $card

  $window.Opacity = 0
  $fadeIn = New-Object System.Windows.Media.Animation.DoubleAnimation
  $fadeIn.From = 0
  $fadeIn.To = 1
  $fadeIn.Duration = New-Object System.Windows.Duration([TimeSpan]::FromMilliseconds(150))
  $window.BeginAnimation([System.Windows.Window]::OpacityProperty, $fadeIn)

  $timer = New-Object System.Windows.Threading.DispatcherTimer
  $timer.Interval = [TimeSpan]::FromSeconds([Math]::Max(2, $Seconds))
  $timer.Add_Tick({ $timer.Stop(); try { $window.Close() } catch { } })

  $positionCard = {
    try {
      $work = [System.Windows.SystemParameters]::WorkArea
      $height = $window.ActualHeight
      if ($height -le 0) { $height = 92 }
      $stacked = 0
      foreach ($card in [DshNotifyNative]::ExistingCards($windowTitle)) { $stacked += $card[3] + $gap }
      $window.Left = $work.Right - $window.ActualWidth - $margin
      $window.Top = $work.Bottom - $height - $margin - $stacked
    } catch { }
  }

  $window.Add_Loaded({
    try {
      $hwnd = (New-Object System.Windows.Interop.WindowInteropHelper($window)).Handle
      [DshNotifyNative]::MakeNoActivate($hwnd)
      # SizeToContent measures during layout; place the card once it settles.
      $window.UpdateLayout()
      & $positionCard
      [DshNotifyNative]::KeepAbove($hwnd)
      Write-DebugLog ("shown {0}x{1} at {2},{3}" -f [int]$window.ActualWidth, [int]$window.ActualHeight, [int]$window.Left, [int]$window.Top)
    } catch {
      Write-DebugLog ("loaded-hook error: {0}" -f $_.Exception.Message)
    }
    $timer.Start()
  })

  # Re-place once the auto height is known (Loaded can precede final layout).
  $window.Add_SizeChanged({ & $positionCard })

  $window.Add_MouseLeftButtonUp({ try { $window.Close() } catch { } })

  if (-not $NoSound) {
    try { [System.Media.SystemSounds]::Asterisk.Play() } catch { }
  }

  $null = $window.ShowDialog()
  Write-DebugLog 'closed'
} catch {
  Write-DebugLog ("fatal: {0}" -f $_.Exception.Message)
  exit 0
}
