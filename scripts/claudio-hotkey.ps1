# Slow fallback: create a desktop shortcut that toggles Claudio with Ctrl+Alt+K.
# The shortcut Hotkey field is global. The target runs hidden and POSTs /api/control.
# PowerShell 5 compatible. Keep this file ASCII.
param(
  [ValidateSet('Install', 'Toggle', 'Remove')]
  [string]$Action = 'Install',
  [string]$BaseUrl = 'http://127.0.0.1:8080',
  [string]$Hotkey = 'CTRL+ALT+K',
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
    throw "Hotkey must look like CTRL+ALT+K. Windows desktop shortcuts only register Ctrl+Alt plus one key."
  }
  return $text
}

function Invoke-ClaudioToggle {
  Test-SafeArg 'BaseUrl' $BaseUrl
  $root = $BaseUrl.TrimEnd('/')
  if (-not $root) { throw "BaseUrl is empty." }
  $params = @{
    Method = 'Post'
    Uri = "$root/api/control"
    ContentType = 'application/json'
    Body = '{"command":"toggle"}'
  }
  if (([string]$env:CLAUDIO_REQUIRE_TOKEN).Trim() -match '^(?i:1|true|yes|on)$') {
    $Token = ([string]$env:CLAUDIO_API_TOKEN).Trim()
    if (-not $Token) { throw 'CLAUDIO_REQUIRE_TOKEN is enabled but CLAUDIO_API_TOKEN is empty.' }
    $params.Headers = @{ Authorization = "Bearer $Token" }
  }
  Invoke-RestMethod @params | Out-Null
}

function Get-ShortcutPath {
  Test-SafeArg 'ShortcutName' $ShortcutName
  if (-not $ShortcutName) { throw "ShortcutName is empty." }
  if ($ShortcutName -match '[\\/:*?<>|]') { throw "ShortcutName has an invalid character." }
  $desktop = [Environment]::GetFolderPath('Desktop')
  if (-not $desktop) { throw "Desktop folder is not available." }
  return Join-Path $desktop ($ShortcutName + '.lnk')
}

function Assert-ClaudioShortcut($Shortcut) {
  if ([IO.Path]::GetFileName($Shortcut.TargetPath) -ine 'powershell.exe' -or
      $Shortcut.Arguments -notmatch '(?i)-File\s+"[^"\r\n]*[\\/]claudio-hotkey\.ps1"\s+-Action\s+Toggle\b') {
    throw 'Refusing to change a shortcut not created by claudio-hotkey.ps1.'
  }
}

function Test-CanKeepShortcutHotkey([bool]$IsClaudioShortcut, [string]$CurrentHotkey, [string]$RequestedHotkey) {
  return $IsClaudioShortcut -and $RequestedHotkey -and
    (($CurrentHotkey -replace '\s', '') -ieq ($RequestedHotkey -replace '\s', ''))
}

function Test-ShortcutHotkey([string]$Value) {
  if (-not ('ClaudioShortcutHotkey' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ClaudioShortcutHotkey
{
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool RegisterHotKey(IntPtr window, int id, uint modifiers, uint key);
    [DllImport("user32.dll")]
    static extern bool UnregisterHotKey(IntPtr window, int id);
    public static int Probe(uint key)
    {
        if (!RegisterHotKey(IntPtr.Zero, 1, 0x4003, key)) return Marshal.GetLastWin32Error();
        UnregisterHotKey(IntPtr.Zero, 1);
        return 0;
    }
}
'@
  }
  $key = $Value.Split('+')[-1]
  $vk = [int][char]$key[0]
  if ($key.Length -gt 1) { $vk = 111 + [int]$key.Substring(1) }
  $errorCode = [ClaudioShortcutHotkey]::Probe($vk)
  if ($errorCode -eq 1409) {
    return $false
  }
  if ($errorCode -ne 0) { throw "RegisterHotKey probe failed (Win32 $errorCode)." }
  return $true
}

function Remove-ClaudioShortcutHotkey {
  $lnkPath = Get-ShortcutPath
  if (-not (Test-Path -LiteralPath $lnkPath)) { Write-Output 'Claudio shortcut not found'; return }
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($lnkPath)
  Assert-ClaudioShortcut $shortcut
  $shortcut.Hotkey = ''
  $shortcut.Save()
  Write-Output "Cleared hotkey from $lnkPath"
}

function Install-ClaudioShortcut {
  Test-SafeArg 'BaseUrl' $BaseUrl
  $hotkey = ConvertTo-ShortcutHotkey $Hotkey
  $lnkPath = Get-ShortcutPath
  $scriptPath = $PSCommandPath
  if (-not $scriptPath) { throw "Run this file with -File so the shortcut can find it." }
  $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`" -Action Toggle -BaseUrl `"$BaseUrl`""
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($lnkPath)
  $isClaudioShortcut = $false
  if (Test-Path -LiteralPath $lnkPath) {
    Assert-ClaudioShortcut $shortcut
    $isClaudioShortcut = $true
  }
  $available = Test-ShortcutHotkey $hotkey
  if (-not $available -and -not (Test-CanKeepShortcutHotkey $isClaudioShortcut $shortcut.Hotkey $hotkey)) {
    Write-Warning "$hotkey is already registered by another program, the resident listener, or a desktop shortcut. No shortcut was created or modified. Pick another -Hotkey. The shortcut and resident listener are mutually exclusive; use one. To use the shortcut instead of the listener, first run: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\claudio-hotkey-listener.ps1 -Action Stop"
    throw 'Shortcut installation stopped (Win32 1409).'
  }
  $shortcut.TargetPath = $powershell
  $shortcut.Arguments = $arguments
  $shortcut.WorkingDirectory = $env:SystemRoot
  $shortcut.WindowStyle = 7
  $shortcut.Hotkey = $hotkey
  $shortcut.Description = "Toggle Claudio playback ($hotkey)"
  $shortcut.Save()
  Write-Output "Created $lnkPath"
  if ($available) {
    Write-Output "Hotkey $hotkey"
  } else {
    Write-Output "Hotkey $hotkey already held by this Claudio shortcut; kept"
  }
}

if ($Action -eq 'Toggle') {
  Invoke-ClaudioToggle
} elseif ($Action -eq 'Remove') {
  Remove-ClaudioShortcutHotkey
} else {
  Install-ClaudioShortcut
}
