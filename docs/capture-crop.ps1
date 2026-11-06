# Capture a privacy-safe crop of the notification banner.
#
# Writes only the banner area, so documentation screenshots never include the
# desktop, window titles, session names or other machine-local context.
param(
  [string]$Out = '',
  [int]$Width = 470,
  [int]$Height = 150
)
$ErrorActionPreference = 'Stop'

if ($Out -eq '') {
  $repo = Split-Path -Parent $PSScriptRoot
  $Out = Join-Path $repo 'docs\toast-fixed.png'
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CropDpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
}
'@
$null = [CropDpi]::SetProcessDpiAwarenessContext([IntPtr](-4))
Add-Type -AssemblyName System.Drawing

$screenW = [CropDpi]::GetSystemMetrics(0)
$screenH = [CropDpi]::GetSystemMetrics(1)

$full = New-Object System.Drawing.Bitmap $screenW, $screenH
$graphics = [System.Drawing.Graphics]::FromImage($full)
$graphics.CopyFromScreen(0, 0, 0, 0, (New-Object System.Drawing.Size($screenW, $screenH)))
$graphics.Dispose()

# The banner is anchored in the bottom-right corner, above the taskbar.
$left = $screenW - $Width - 12
$top = $screenH - $Height - 96
if ($left -lt 0) { $left = 0 }
if ($top -lt 0) { $top = 0 }
$rect = New-Object System.Drawing.Rectangle($left, $top, $Width, $Height)
$crop = $full.Clone($rect, $full.PixelFormat)
$crop.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$crop.Dispose()
$full.Dispose()

Write-Output "cropped ${Width}x${Height} -> $Out"
