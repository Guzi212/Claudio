# Resident global hotkey. Windows PowerShell 5 / .NET Framework, ASCII only.
# Check compiles and parses without registering keys, writing files, or sending HTTP.
param(
  [ValidateSet('Run', 'Start', 'Stop', 'Status', 'Check')]
  [string]$Action = 'Start',
  [string]$BaseUrl = 'http://127.0.0.1:8080',
  [string]$Hotkey = 'CTRL+ALT+K',
  [switch]$MediaKey
)

$ErrorActionPreference = 'Stop'
$mutexName = 'Local\ClaudioHotkeyListener'
$stopName = 'Local\ClaudioHotkeyListener.Stop'
$dataDir = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Claudio'
$statePath = Join-Path $dataDir 'hotkey-listener.json'
$logPath = Join-Path $dataDir 'hotkey-listener.log'

function ConvertTo-ListenerHotkey([string]$Value) {
  $parts = (($Value -replace '\s', '').ToUpperInvariant()).Split('+')
  if ($parts.Count -lt 2) { throw 'Hotkey must look like CTRL+ALT+K.' }
  $key = $parts[-1]
  if ($key -notmatch '^(F([1-9]|1[0-2])|[A-Z0-9])$') {
    throw 'Hotkey needs a letter, digit, or F1-F12.'
  }
  $mods = @{ ALT = 1; CTRL = 2; SHIFT = 4; WIN = 8 }
  $flags = 0
  foreach ($part in $parts[0..($parts.Count - 2)]) {
    if (-not $mods.ContainsKey($part)) { throw 'Use CTRL, ALT, SHIFT, or WIN modifiers.' }
    if (($flags -band $mods[$part]) -ne 0) { throw 'Duplicate hotkey modifier.' }
    $flags = $flags -bor $mods[$part]
  }
  $ordered = @(@('CTRL', 'ALT', 'SHIFT', 'WIN') | Where-Object { ($flags -band $mods[$_]) -ne 0 })
  $vk = [int][char]$key[0]
  if ($key.StartsWith('F') -and $key.Length -gt 1) { $vk = 111 + [int]$key.Substring(1) }
  return @{ Name = (($ordered + @($key)) -join '+'); Modifiers = $flags; Key = $vk }
}

function Read-ListenerState {
  try { return Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json } catch { return $null }
}

function Test-ListenerRunning {
  $probe = $null
  $owned = $false
  try {
    $probe = [Threading.Mutex]::OpenExisting($mutexName)
    try { $owned = $probe.WaitOne(0) } catch [Threading.AbandonedMutexException] { $owned = $true }
    return (-not $owned)
  } catch [Threading.WaitHandleCannotBeOpenedException] {
    return $false
  } finally {
    if ($owned) { $probe.ReleaseMutex() }
    if ($probe) { $probe.Dispose() }
  }
}

function Get-RunningDescription {
  $state = Read-ListenerState
  if ($state) {
    $keys = $state.Hotkey
    if ($state.MediaKey) { $keys += ' + MediaPlayPause' }
    return "$($state.Status): $keys (PID $($state.Pid))"
  }
  return 'starting (hotkey registration pending)'
}

function Write-ListenerState([string]$Status, [string]$Reason = '') {
  # Metadata only. Never include the URL, environment, headers, or token here.
  @{
    Pid = $PID; Hotkey = $binding.Name; MediaKey = [bool]$MediaKey
    Status = $Status; Reason = $Reason
  } | ConvertTo-Json -Compress | Set-Content -LiteralPath $statePath -Encoding ASCII
}

function Write-ListenerLog([string]$Message) {
  if ((Test-Path -LiteralPath $logPath) -and (Get-Item -LiteralPath $logPath).Length -gt 262144) {
    [IO.File]::WriteAllText($logPath, '')
  }
  [IO.File]::AppendAllText($logPath, ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff') + ' ' + $Message + [Environment]::NewLine))
}

function Get-ClaudioToken {
  if (([string]$env:CLAUDIO_REQUIRE_TOKEN).Trim() -match '^(?i:1|true|yes|on)$') {
    $value = ([string]$env:CLAUDIO_API_TOKEN).Trim()
    if (-not $value) {
      [ClaudioHotkeyListener]::Failure = 'CLAUDIO_REQUIRE_TOKEN is enabled but CLAUDIO_API_TOKEN is empty.'
      throw [ClaudioHotkeyListener]::Failure
    }
    if ($value -match '\s') {
      [ClaudioHotkeyListener]::Failure = 'CLAUDIO_API_TOKEN must not contain whitespace.'
      throw [ClaudioHotkeyListener]::Failure
    }
    return $value
  }
  return ''
}

function Add-ListenerType {
  if ('ClaudioHotkeyListener' -as [type]) { return }
  Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

public static class ClaudioHotkeyListener
{
    public const uint MOD_NOREPEAT = 0x4000;
    const uint WM_HOTKEY = 0x0312;
    const uint WM_QUIT = 0x0012;
    const uint VK_MEDIA_PLAY_PAUSE = 0xB3;
    static readonly object logLock = new object();
    static string logPath;
    public static string Failure = "";

    [StructLayout(LayoutKind.Sequential)]
    struct POINT { public int x, y; }
    [StructLayout(LayoutKind.Sequential)]
    struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public UIntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public POINT pt;
        public uint lPrivate;
    }
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool RegisterHotKey(IntPtr window, int id, uint modifiers, uint key);
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool UnregisterHotKey(IntPtr window, int id);
    [DllImport("user32.dll", SetLastError = true)]
    static extern int GetMessage(out MSG message, IntPtr window, uint min, uint max);
    [DllImport("user32.dll")]
    static extern bool PeekMessage(out MSG message, IntPtr window, uint min, uint max, uint remove);
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool PostThreadMessage(uint thread, uint message, UIntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll")]
    static extern uint GetCurrentThreadId();

    sealed class Press
    {
        public DateTime Time = DateTime.Now;
        public long Tick = Stopwatch.GetTimestamp();
        public string Key;
    }

    static void Log(string message)
    {
        lock (logLock)
        {
            try
            {
                if (File.Exists(logPath))
                    if (new FileInfo(logPath).Length > 262144) File.WriteAllText(logPath, "");
                File.AppendAllText(logPath, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + " " + message + Environment.NewLine);
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }

    static bool Register(int id, uint modifiers, uint key, string name)
    {
        if (RegisterHotKey(IntPtr.Zero, id, modifiers | MOD_NOREPEAT, key))
        {
            Log("registered hotkey " + name);
            return true;
        }
        int error = Marshal.GetLastWin32Error();
        Failure = error == 1409
            ? name + " is already registered by another program (or by a desktop shortcut). Pick another with -Hotkey CTRL+ALT+F11. (Win32 1409)"
            : "RegisterHotKey failed for " + name + " (Win32 " + error + ").";
        Log("ERROR " + Failure);
        // Keep this on a separate thread so startup failure is reported immediately.
        Thread notice = new Thread(delegate()
        {
            try
            {
                using (NotifyIcon icon = new NotifyIcon())
                {
                    icon.Icon = System.Drawing.SystemIcons.Warning;
                    icon.Visible = true;
                    icon.ShowBalloonTip(4000, "Claudio hotkey", Failure, ToolTipIcon.Warning);
                    Thread.Sleep(4500);
                }
            }
            catch { }
        });
        notice.IsBackground = false;
        notice.SetApartmentState(ApartmentState.STA);
        notice.Start();
        return false;
    }

    static void Toggle(Uri endpoint, string token, Press press)
    {
        Log("press WM_HOTKEY at=" + press.Time.ToString("yyyy-MM-dd HH:mm:ss.fff") + " key=" + press.Key);
        try
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(endpoint);
            request.Method = "POST";
            request.ContentType = "application/json";
            request.KeepAlive = true;
            request.Timeout = 2000;
            request.ReadWriteTimeout = 2000;
            request.AllowAutoRedirect = false;
            request.ServicePoint.Expect100Continue = false;
            request.ServicePoint.UseNagleAlgorithm = false;
            if (endpoint.IsLoopback) request.Proxy = null;
            if (token.Length > 0) request.Headers[HttpRequestHeader.Authorization] = "Bearer " + token;
            byte[] body = Encoding.UTF8.GetBytes("{\"command\":\"toggle\"}");
            request.ContentLength = body.Length;
            using (Stream stream = request.GetRequestStream()) stream.Write(body, 0, body.Length);
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            using (StreamReader reader = new StreamReader(response.GetResponseStream()))
            {
                // The control response is small. Do not persist arbitrary server content.
                char[] buffer = new char[4096];
                int count = reader.ReadBlock(buffer, 0, buffer.Length);
                Match paused = Regex.Match(new string(buffer, 0, count), "\"paused\"\\s*:\\s*(true|false)");
                double elapsed = (Stopwatch.GetTimestamp() - press.Tick) * 1000.0 / Stopwatch.Frequency;
                Log("response press=" + press.Time.ToString("HH:mm:ss.fff") + " status=" + (int)response.StatusCode
                    + " paused=" + (paused.Success ? paused.Groups[1].Value : "unknown") + " elapsedMs=" + elapsed.ToString("F1"));
            }
        }
        catch (WebException error)
        {
            HttpWebResponse response = error.Response as HttpWebResponse;
            Log("ERROR response press=" + press.Time.ToString("HH:mm:ss.fff") + " status="
                + (response == null ? error.Status.ToString() : ((int)response.StatusCode).ToString()));
            if (response != null) response.Dispose();
        }
        catch (Exception error)
        {
            // Exception messages and response bodies can contain credentials: log types only.
            Log("ERROR HTTP " + error.GetType().Name);
        }
    }

    public static int Run(uint modifiers, uint key, string name, bool mediaKey, string baseUrl,
        string token, string path, EventWaitHandle stop, Action ready)
    {
        logPath = path;
        Failure = "";
        Uri endpoint = new Uri(baseUrl.TrimEnd('/') + "/api/control");
        bool primaryRegistered = false;
        bool mediaRegistered = false;
        RegisteredWaitHandle stopWait = null;
        CancellationTokenSource shutdown = new CancellationTokenSource();
        BlockingCollection<Press> presses = new BlockingCollection<Press>();
        Thread worker = new Thread(delegate()
        {
            foreach (Press press in presses.GetConsumingEnumerable())
            {
                if (shutdown.IsCancellationRequested) break;
                Toggle(endpoint, token, press);
            }
        });
        worker.IsBackground = true;
        try
        {
            // Force creation of this thread's message queue before registering the stop callback.
            MSG message;
            PeekMessage(out message, IntPtr.Zero, 0, 0, 0);
            uint threadId = GetCurrentThreadId();
            primaryRegistered = Register(1, modifiers, key, name);
            if (!primaryRegistered) return 1;
            if (mediaKey)
            {
                mediaRegistered = Register(2, 0, VK_MEDIA_PLAY_PAUSE, "MediaPlayPause");
                if (!mediaRegistered) return 1;
            }
            stopWait = ThreadPool.RegisterWaitForSingleObject(stop, delegate(object state, bool timedOut)
            {
                PostThreadMessage(threadId, WM_QUIT, UIntPtr.Zero, IntPtr.Zero);
            }, null, Timeout.Infinite, true);
            worker.Start();
            ready();
            int result;
            while ((result = GetMessage(out message, IntPtr.Zero, 0, 0)) > 0)
            {
                if (message.message == WM_HOTKEY)
                    presses.Add(new Press { Key = message.wParam.ToUInt64() == 1 ? name : "MediaPlayPause" });
            }
            if (result == -1)
            {
                Failure = "GetMessage failed (Win32 " + Marshal.GetLastWin32Error() + ").";
                Log("ERROR " + Failure);
                return 1;
            }
            return 0;
        }
        finally
        {
            if (primaryRegistered) UnregisterHotKey(IntPtr.Zero, 1);
            if (mediaRegistered) UnregisterHotKey(IntPtr.Zero, 2);
            if (stopWait != null) stopWait.Unregister(null);
            shutdown.Cancel();
            presses.CompleteAdding();
            if (worker.IsAlive) worker.Join(2500);
            Log("stopped; hotkeys released");
        }
    }
}
'@
}

try {
  if ($Action -eq 'Status') {
    if (Test-ListenerRunning) { Write-Output (Get-RunningDescription) } else { Write-Output 'not running' }
    exit 0
  }
  if ($Action -eq 'Stop') {
    if (-not (Test-ListenerRunning)) { Write-Output 'not running'; exit 0 }
    $stop = [Threading.EventWaitHandle]::OpenExisting($stopName)
    try { [void]$stop.Set() } finally { $stop.Dispose() }
    $deadline = [DateTime]::UtcNow.AddSeconds(4)
    while ((Test-ListenerRunning) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 50 }
    if (Test-ListenerRunning) { throw 'stop requested; listener has not exited yet.' }
    Write-Output 'stopped'
    exit 0
  }

  $binding = ConvertTo-ListenerHotkey $Hotkey
  $uri = $null
  if (-not [Uri]::TryCreate($BaseUrl, [UriKind]::Absolute, [ref]$uri)) { throw 'BaseUrl must be an absolute HTTP(S) URL.' }
  if ($uri.Scheme -notin @('http', 'https') -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $BaseUrl -match '["\r\n]') {
    throw 'BaseUrl must be HTTP(S), without credentials, query, fragment, quotes, or newlines.'
  }
  if ($Action -eq 'Check') {
    Add-ListenerType
    Write-Output "check OK: $($binding.Name), modifiers=$($binding.Modifiers), VK=$($binding.Key), MediaKey=$([bool]$MediaKey)"
    exit 0
  }
  if ($Action -eq 'Start') {
    if (Test-ListenerRunning) { Write-Output ('already running; ' + (Get-RunningDescription)); exit 0 }
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Action Run -Hotkey $($binding.Name) -BaseUrl `"$BaseUrl`""
    if ($MediaKey) { $arguments += ' -MediaKey' }
    $child = Start-Process -FilePath $powershell -ArgumentList $arguments -WindowStyle Hidden -PassThru
    # Bounded startup handshake; it never waits for the resident loop to finish.
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    do {
      $state = Read-ListenerState
      if ($state -and $state.Pid -eq $child.Id) {
        if ($state.Status -eq 'running') { Write-Output ("started; " + (Get-RunningDescription)); exit 0 }
        if ($state.Status -eq 'failed') { throw $state.Reason }
      }
      if ($child.HasExited) {
        if (Test-ListenerRunning) { Write-Output ('already running; ' + (Get-RunningDescription)); exit 0 }
        throw "listener exited before registration; see $logPath"
      }
      Start-Sleep -Milliseconds 50
    } while ([DateTime]::UtcNow -lt $deadline)
    # This is our own child, never the Node server or another listener.
    if (-not $child.HasExited) { $child.Kill() }
    throw "listener startup timed out after 5 s; see $logPath"
  }
} catch {
  Write-Output ("failed: " + $_.Exception.Message)
  exit 1
}

# Run owns the mutex on the message-loop thread until every registered key is released.
$mutex = New-Object Threading.Mutex($false, $mutexName)
$ownsMutex = $false
$stop = $null
$exitCode = 1
try {
  try { $ownsMutex = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
  if (-not $ownsMutex) { Write-Output 'already running; second Run ignored'; exit 0 }
  [void][IO.Directory]::CreateDirectory($dataDir)
  $stop = New-Object Threading.EventWaitHandle($false, [Threading.EventResetMode]::ManualReset, $stopName)
  Write-ListenerState 'starting'
  Write-ListenerLog "start PID=$PID hotkey=$($binding.Name) MediaKey=$([bool]$MediaKey)"
  Add-ListenerType
  $token = Get-ClaudioToken
  $ready = [Action]{ Write-ListenerState 'running' }
  $exitCode = [ClaudioHotkeyListener]::Run($binding.Modifiers, $binding.Key, $binding.Name,
    [bool]$MediaKey, $BaseUrl, $token, $logPath, $stop, $ready)
  if ($exitCode -ne 0) {
    Write-ListenerState 'failed' ([ClaudioHotkeyListener]::Failure)
    Write-Output ('failed: ' + [ClaudioHotkeyListener]::Failure)
  } else { Write-ListenerState 'stopped' }
} catch {
  # No exception message here: runtime errors must never echo credentials.
  $reason = 'listener failed (' + $_.Exception.GetBaseException().GetType().Name + '); run -Action Check to check compilation and arguments.'
  if ('ClaudioHotkeyListener' -as [type]) {
    if ([ClaudioHotkeyListener]::Failure) { $reason = [ClaudioHotkeyListener]::Failure }
  }
  if ($ownsMutex) {
    Write-ListenerLog ('ERROR ' + $reason)
    Write-ListenerState 'failed' $reason
  }
  Write-Output ('failed: ' + $reason)
} finally {
  $token = $null
  if ($stop) { $stop.Dispose() }
  if ($ownsMutex) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
exit $exitCode
