import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const scriptUrl = new URL('../scripts/claudio-hotkey.ps1', import.meta.url);
const bytes = fs.readFileSync(scriptUrl);
const script = bytes.toString('utf8');

describe('Windows 快捷键脚本', () => {
  it('是 ASCII，PowerShell 5 能直接解析', () => {
    expect([...bytes].every(byte => byte < 128)).toBe(true);
    expect(script).not.toMatch(/\?\?|\?\.| -Parallel|&&|\|\|/);
    expect(script).not.toContain('pwsh');
    expect(script.startsWith('param(') || script.includes('\nparam(')).toBe(true);
  });

  it('桌面快捷方式绑定 Ctrl+Alt+P，并隐藏窗口调用 toggle', () => {
    expect(script).toContain("[string]$Hotkey = 'CTRL+ALT+P'");
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
});
