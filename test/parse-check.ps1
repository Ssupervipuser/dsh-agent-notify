# Parse-check a PowerShell script without executing it.
param([Parameter(Mandatory = $true)][string]$Path)
$tokens = $null
$errors = $null
$null = [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
if ($errors -and $errors.Count -gt 0) {
  foreach ($e in $errors) { Write-Output ("PARSE ERROR: {0} (line {1})" -f $e.Message, $e.Extent.StartLineNumber) }
  exit 1
}
Write-Output "PARSE OK: $Path"
