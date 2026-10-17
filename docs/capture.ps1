# DPI-aware full-desktop capture (an unaware process gets a cropped, virtualized
# view on a scaled display). Used only for verification screenshots.
param([string]$Out = (Join-Path $PSScriptRoot 'capture.png'))
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DpiCapture {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
}
'@
$null = [DpiCapture]::SetProcessDpiAwarenessContext([IntPtr](-4))
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$width = [DpiCapture]::GetSystemMetrics(0)
$height = [DpiCapture]::GetSystemMetrics(1)
$bitmap = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen(0, 0, 0, 0, (New-Object System.Drawing.Size($width, $height)))
$graphics.Dispose()
$bitmap.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()
Write-Output "captured ${width}x${height} -> $Out"
