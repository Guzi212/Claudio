# Create a desktop shortcut that toggles Claudio with Ctrl+Alt+P.
# The shortcut Hotkey field is global. The target runs hidden and POSTs /api/control.
# PowerShell 5 compatible. Keep this file ASCII.
param(
  [ValidateSet('Install', 'Toggle')]
  [string]$Action = 'Install',
  [string]$BaseUrl = 'http://127.0.0.1:8080',
  [string]$Hotkey = 'CTRL+ALT+P',
  [string]$Token = '',
  [string]$ShortcutName = 'Claudio Play-Pause'
)

$ErrorActionPreference = 'Stop'

function Test-SafeArg([string]$Name, [string]$Value) {
  if ($Value -match '["\r\n]') {
    throw "$Name cannot contain quotes or newlines."
  }
}

function ConvertTo-ShortcutHotkey([string]$Value) {
  $text = ($Value -replace '\s', '').ToUpper()
  if ($text -notmatch '^CTRL\+ALT\+(F([1-9]|1[0-2])|[A-Z0-9])$') {
    throw "Hotkey must look like CTRL+ALT+P. Windows desktop shortcuts only register Ctrl+Alt plus one key."
  }
  return $text
}

function Invoke-ClaudioToggle {
  Test-SafeArg 'BaseUrl' $BaseUrl
  Test-SafeArg 'Token' $Token
  $root = $BaseUrl.TrimEnd('/')
  if (-not $root) { throw "BaseUrl is empty." }
  $params = @{
    Method = 'Post'
    Uri = "$root/api/control"
    ContentType = 'application/json'
    Body = '{"command":"toggle"}'
  }
  if ($Token) {
    $params.Headers = @{ Authorization = "Bearer $Token" }
  }
  Invoke-RestMethod @params | Out-Null
}

function Install-ClaudioShortcut {
  Test-SafeArg 'BaseUrl' $BaseUrl
  Test-SafeArg 'Token' $Token
  Test-SafeArg 'ShortcutName' $ShortcutName
  if (-not $ShortcutName) { throw "ShortcutName is empty." }
  if ($ShortcutName -match '[\\/:*?<>|]') { throw "ShortcutName has an invalid character." }
  $hotkey = ConvertTo-ShortcutHotkey $Hotkey
  $desktop = [Environment]::GetFolderPath('Desktop')
  if (-not $desktop) { throw "Desktop folder is not available." }
  $lnkPath = Join-Path $desktop ($ShortcutName + '.lnk')
  $scriptPath = $PSCommandPath
  if (-not $scriptPath) { throw "Run this file with -File so the shortcut can find it." }
  $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`" -Action Toggle -BaseUrl `"$BaseUrl`""
  if ($Token) {
    $arguments = "$arguments -Token `"$Token`""
  }
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($lnkPath)
  $shortcut.TargetPath = $powershell
  $shortcut.Arguments = $arguments
  $shortcut.WorkingDirectory = $env:SystemRoot
  $shortcut.WindowStyle = 7
  $shortcut.Hotkey = $hotkey
  $shortcut.Description = "Toggle Claudio playback ($hotkey)"
  $shortcut.Save()
  Write-Output "Created $lnkPath"
  Write-Output "Hotkey $hotkey"
}

if ($Action -eq 'Toggle') {
  Invoke-ClaudioToggle
} else {
  Install-ClaudioShortcut
}
