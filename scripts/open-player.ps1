# Open the Claudio player in Chrome.
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
  [switch]$Tab
)

$ErrorActionPreference = 'Stop'

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
