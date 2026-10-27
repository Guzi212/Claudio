import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const scriptUrl = new URL('../scripts/claudio-hotkey.ps1', import.meta.url);
const bytes = fs.readFileSync(scriptUrl);
const script = bytes.toString('utf8');
const listenerUrl = new URL('../scripts/claudio-hotkey-listener.ps1', import.meta.url);
const listenerBytes = fs.readFileSync(listenerUrl);
const listener = listenerBytes.toString('utf8');

describe('Windows 快捷键脚本', () => {
  it.each([['快捷方式', bytes], ['常驻监听器', listenerBytes]])('%s 是 ASCII，使用 PowerShell 5 语法', (_, content) => {
    const text = content.toString('utf8');
    expect([...content].every(byte => byte < 128)).toBe(true);
    expect(text).not.toMatch(/\?\?|\?\.| -Parallel|&&|\|\|/);
    expect(text).not.toContain('pwsh');
    expect(text.startsWith('param(') || text.includes('\nparam(')).toBe(true);
  });

  it('桌面快捷方式默认 Ctrl+Alt+K，并隐藏窗口调用 toggle', () => {
    expect(script).toContain("[string]$Hotkey = 'CTRL+ALT+K'");
    expect(script).toContain(".Hotkey = $hotkey");
    expect(script).toContain('.WindowStyle = 7');
    expect(script).toContain('-WindowStyle Hidden');
    expect(script).toContain('GetFolderPath(\'Desktop\')');
    expect(script).toContain('WScript.Shell');
    expect(script).toContain('-Action Toggle');
    expect(script).toContain('{"command":"toggle"}');
    expect(script).toContain('/api/control');
    expect(script).toContain('Authorization = "Bearer $Token"');
    expect(script).toContain('^CTRL\\+ALT\\+(F([1-9]|1[0-2])|[A-Z0-9])$');
  });

  it('快捷方式探测占用并跳过冲突绑定，Remove 只清除自有快捷方式热键', () => {
    expect(script).toContain('RegisterHotKey');
    expect(script).toContain('UnregisterHotKey');
    expect(script).toContain('GetLastWin32Error');
    expect(script).toContain('$errorCode -eq 1409');
    expect(script).toContain('Skipping the shortcut hotkey');
    expect(script).toContain("else { $shortcut.Hotkey = '' }");
    expect(script).toContain("[ValidateSet('Install', 'Toggle', 'Remove')]");
    expect(script).toContain('Assert-ClaudioShortcut $shortcut');
    expect(script).not.toContain('Remove-Item');
    expect(script).not.toContain('-Token `"');
  });
});

describe('常驻全局热键', () => {
  it('使用独占 mutex、停止事件、隐藏子进程和有界启动确认', () => {
    expect(listener).toContain("[string]$Action = 'Start'");
    expect(listener).toContain("'Run', 'Start', 'Stop', 'Status', 'Check'");
    expect(listener).toContain('Local\\ClaudioHotkeyListener');
    expect(listener).toContain('$mutex.ReleaseMutex()');
    expect(listener).toContain('EventWaitHandle');
    expect(listener).toContain('-WindowStyle Hidden');
    expect(listener).toContain('-Action Run');
    expect(listener).toContain("$state.Status -eq 'failed'");
    expect(listener).toContain('already running; second Run ignored');
    expect(listener).not.toContain('Stop-Process');
  });

  it('Win32 消息循环直接排入后台 HTTP 队列，保留连接且不自动重试 toggle', () => {
    expect(listener).toContain('RegisterHotKey');
    expect(listener).toContain('MOD_NOREPEAT = 0x4000');
    expect(listener).toContain('GetMessage(out message');
    expect(listener).toContain('WM_HOTKEY');
    expect(listener).toContain('presses.Add(new Press');
    expect(listener).toContain('GetConsumingEnumerable');
    expect(listener).toContain('HttpWebRequest');
    expect(listener).toContain('request.KeepAlive = true');
    expect(listener).toContain('request.Timeout = 2000');
    expect(listener).toContain('request.AllowAutoRedirect = false');
    expect(listener).toContain('request.ServicePoint.Expect100Continue = false');
    expect(listener).toContain('/api/control');
    expect(listener).toContain(String.raw`{\"command\":\"toggle\"}`);
    expect(listener).toContain('application/json');
    expect(listener).toContain('catch (WebException error)');
  });

  it('两个入口都按服务端开关读取环境令牌，文件和子进程参数不包含令牌', () => {
    for (const text of [script, listener]) {
      expect(text).toMatch(/CLAUDIO_REQUIRE_TOKEN\)\.Trim\(\) -match '\^\(\?i:1\|true\|yes\|on\)\$'/);
      expect(text).toContain('$env:CLAUDIO_API_TOKEN');
      const argumentsLine = text.split('\n').filter(line => line.includes('$arguments =')).join('\n');
      expect(argumentsLine).not.toMatch(/Token|CLAUDIO_API_TOKEN/);
    }
    const stateWriter = listener.slice(listener.indexOf('function Write-ListenerState'), listener.indexOf('function Write-ListenerLog'));
    expect(stateWriter).not.toMatch(/\$token|\$env:|BaseUrl/i);
    expect(listener).toContain('HttpRequestHeader.Authorization] = "Bearer " + token');
    expect(listener).not.toMatch(/(?:Log|WriteAllText|AppendAllText)\([^\n]*\btoken\b/i);
    expect(listener).not.toContain('Log(error.Message)');
  });

  it('处理 1409，默认不抢媒体键，并提供有上限且精确到毫秒的日志', () => {
    expect(listener).toContain('Marshal.GetLastWin32Error()');
    expect(listener).toContain('error == 1409');
    expect(listener).toContain('already registered by another program (or by a desktop shortcut)');
    expect(listener).toContain('ShowBalloonTip');
    expect(listener).toMatch(/\[switch\]\$MediaKey\r?\n/);
    expect(listener).toContain('if (mediaKey)');
    expect(listener).toContain('VK_MEDIA_PLAY_PAUSE = 0xB3');
    expect(listener).toContain("'LocalApplicationData'");
    expect(listener).toContain("'hotkey-listener.log'");
    expect(listener).toContain('262144');
    expect(listener).toContain('yyyy-MM-dd HH:mm:ss.fff');
    expect(listener).toContain('elapsedMs=');
    expect(listener).toContain('paused=');
  });
});

// No listener, shortcut, network request, or live player is used by these checks.
describe.skipIf(process.platform !== 'win32')('PowerShell 5 编译与参数检查', () => {
  const powershell = `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  function check(...args) {
    return spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(listenerUrl), '-Action', 'Check', '-BaseUrl', 'http://127.0.0.1:9', ...args], { encoding: 'utf8', timeout: 15000 });
  }

  it.each([
    ['CTRL+ALT+F11', 'CTRL+ALT+F11, modifiers=3, VK=122'],
    ['shift+ctrl+9', 'CTRL+SHIFT+9, modifiers=6, VK=57'],
    ['WIN+K', 'WIN+K, modifiers=8, VK=75'],
    ['CTRL+ALT+F1', 'CTRL+ALT+F1, modifiers=3, VK=112'],
    ['CTRL+ALT+F12', 'CTRL+ALT+F12, modifiers=3, VK=123'],
  ])('编译 C# 并解析 %s，不注册热键', (hotkey, result) => {
    const child = check('-Hotkey', hotkey);
    expect(child.error).toBeUndefined();
    expect(child.status, child.stdout + child.stderr).toBe(0);
    expect(child.stdout).toContain(result);
    expect(child.stdout).toContain('MediaKey=False');
  });

  it.each(['CTRL+CTRL+K', 'CTRL+ALT+F13', 'K', 'META+K', 'CTRL++K'])('拒绝无效组合 %s', hotkey => {
    const child = check('-Hotkey', hotkey);
    expect(child.status).toBe(1);
    expect(child.stdout).toContain('failed:');
  });

  it('只在显式指定时开启媒体键', () => {
    const child = check('-MediaKey');
    expect(child.status, child.stdout + child.stderr).toBe(0);
    expect(child.stdout).toContain('CTRL+ALT+K, modifiers=3, VK=75, MediaKey=True');
  });

  it('旧脚本也可由 PowerShell 5 解析，Add-Type 可以编译', () => {
    // Extract only the C# probe; never execute Install, Remove, or Toggle.
    const probe = script.match(/Add-Type -TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/)[1];
    const code = `\n$errors = $null\n[void][System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(), [ref]$null, [ref]$errors)\nif ($errors.Count) { exit 1 }\nAdd-Type -TypeDefinition @'\n${probe}\n'@\n`;
    const child = spawnSync(powershell, ['-NoProfile', '-Command', code], { input: script, encoding: 'utf8', timeout: 15000 });
    expect(child.status, child.stdout + child.stderr).toBe(0);
  });
});
