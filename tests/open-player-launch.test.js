import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ps1 = fs.readFileSync(path.resolve('scripts/open-player.ps1'), 'utf8');

describe('open-player.ps1 桌面启动环境注入', () => {
  it('只有显式传 -BaseUrl 才注入 CLAUDIO_SERVER_URL', () => {
    expect(ps1).toContain("$PSBoundParameters.ContainsKey('BaseUrl')");
    expect(ps1).not.toMatch(/^\s*\$env:CLAUDIO_SERVER_URL\s*=\s*\$BaseUrl/m);
  });

  it('通过子进程环境变量启动 Electron，不污染调用方会话', () => {
    expect(ps1).toContain('System.Diagnostics.ProcessStartInfo');
    expect(ps1).toContain("EnvironmentVariables['CLAUDIO_SERVER_URL']");
    expect(ps1).toContain('[System.Diagnostics.Process]::Start');
  });
});
