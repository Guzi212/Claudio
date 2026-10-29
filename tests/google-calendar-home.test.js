import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('services/google-calendar credential paths', () => {
  beforeEach(() => {
    vi.stubEnv('HOME', undefined);
    vi.stubEnv('GOOGLE_OAUTH_CREDENTIALS', undefined);
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('loads without HOME', async () => {
    expect(process.env.HOME).toBeUndefined();
    await expect(import('../server/services/google-calendar.js')).resolves.toHaveProperty('getTodayEvents', expect.any(Function));
  });

  it('uses the OS home directory for the default credential path', async () => {
    const { getTodayEvents } = await import('../server/services/google-calendar.js');
    const credsPath = path.join(os.homedir(), '.config/google-calendar-mcp/gcp-oauth.keys.json');
    const readFile = vi.spyOn(fs, 'readFileSync')
      .mockReturnValueOnce('{}')
      .mockImplementation(() => { throw new Error('fixture credentials unavailable'); });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(getTodayEvents()).resolves.toBeNull();
    expect(readFile).toHaveBeenCalledTimes(2);
    expect(readFile).toHaveBeenNthCalledWith(1, path.join(path.dirname(credsPath), 'tokens.json'), 'utf8');
    expect(readFile).toHaveBeenNthCalledWith(2, credsPath, 'utf8');
  });

  it('keeps GOOGLE_OAUTH_CREDENTIALS precedence without HOME', async () => {
    const credsPath = path.join(os.tmpdir(), 'claudio-calendar-home-test', 'custom-oauth.json');
    vi.stubEnv('GOOGLE_OAUTH_CREDENTIALS', credsPath);
    const { getTodayEvents } = await import('../server/services/google-calendar.js');
    const readFile = vi.spyOn(fs, 'readFileSync')
      .mockReturnValueOnce('{}')
      .mockImplementation(() => { throw new Error('fixture credentials unavailable'); });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(getTodayEvents()).resolves.toBeNull();
    expect(readFile).toHaveBeenCalledTimes(2);
    expect(readFile).toHaveBeenNthCalledWith(1, path.join(path.dirname(credsPath), 'tokens.json'), 'utf8');
    expect(readFile).toHaveBeenNthCalledWith(2, credsPath, 'utf8');
  });
});
