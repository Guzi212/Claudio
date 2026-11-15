# Open the Claudio desktop player (Electron native window) or Chrome fallback.
# PowerShell 5 compatible. Keep this file ASCII.
#
# Why --autoplay-policy=no-user-gesture-required:
# Chrome's default autoplay policy rejects autoplay with sound when there was no
# user gesture. play() throws NotAllowedError and the media element never starts
# loading (readyState stays 0), so the page just sits on the unlock overlay.
# With this switch Chrome behaves like Edge and plays on open.
#
# --disable-backgrounding-occluded-windows: Chrome throttles media loading in a
# window it thinks is occluded (behind another window, or off-screen). Without
# this, audio readyState stays 0 while the page is covered.
#
# Uses its own profile dir so the daily Chrome profile is left alone.

param(
  [string]$BaseUrl = 'http://127.0.0.1:8080',
  [string]$ProfileDir = (Join-Path $env:LOCALAPPDATA 'Claudio\chrome-profile'),
  [switch]$Tab,
  [switch]$Browser
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$electronExe = Join-Path $repoRoot 'node_modules\electron\dist\electron.exe'
$desktopMain = Join-Path $repoRoot 'desktop\main.cjs'

if (-not $Tab -and -not $Browser -and (Test-Path $electronExe) -and (Test-Path $desktopMain)) {
  # Only an explicit -BaseUrl should bypass the desktop supervisor's backend auto-start.
  # Set it on the child process only, so this PowerShell session stays clean.
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $electronExe
  $startInfo.Arguments = '"' + $desktopMain + '"'
  $startInfo.WorkingDirectory = $repoRoot
  $startInfo.UseShellExecute = $false
  if ($PSBoundParameters.ContainsKey('BaseUrl')) {
    $startInfo.EnvironmentVariables['CLAUDIO_SERVER_URL'] = $BaseUrl
  } else {
    # Inherited env must not silently bypass the supervisor either.
    $startInfo.EnvironmentVariables.Remove('CLAUDIO_SERVER_URL') | Out-Null
  }
  [System.Diagnostics.Process]::Start($startInfo) | Out-Null
  if ($PSBoundParameters.ContainsKey('BaseUrl')) {
    Write-Host "Claudio desktop opened: $BaseUrl"
  } else {
    Write-Host 'Claudio desktop opened (backend auto-start)'
  }
  exit 0
}

$roots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA) | Where-Object { $_ }
$chrome = $null
foreach ($root in $roots) {
  $candidate = Join-Path $root 'Google\Chrome\Application\chrome.exe'
  if (Test-Path $candidate) { $chrome = $candidate; break }
}

if (-not $chrome) {
  throw 'chrome.exe not found. Install Google Chrome first.'
}

New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null

$chromeArgs = @(
  '--autoplay-policy=no-user-gesture-required',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  "--user-data-dir=$ProfileDir",
  '--no-first-run',
  '--no-default-browser-check'
)
# App mode by default (no address bar). Use -Tab for a normal tab.
if ($Tab) { $chromeArgs += $BaseUrl } else { $chromeArgs += "--app=$BaseUrl" }

Start-Process -FilePath $chrome -ArgumentList $chromeArgs
Write-Host "Chrome opened: $BaseUrl"
Write-Host "profile: $ProfileDir"
