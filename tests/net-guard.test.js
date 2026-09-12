        expect(address).toBe('8.8.8.8');
        resolve();
      });
    });
  });
});

describe('fake-IP 信任网段（PROXY_TRUST_FAKE_IP_CIDRS）', () => {
  const ENV_KEY = 'PROXY_TRUST_FAKE_IP_CIDRS';

  // 设置 env 并确保测试后还原（含异步回调期间保持生效）。
  async function withEnv(value, fn) {
    const old = process.env[ENV_KEY];
    if (value === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = value;
    try {
      return await fn();
    } finally {
      if (old === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = old;
    }
  }

  it('默认仍然拦截 198.18 / 198.19', async () => {
    await withEnv(undefined, () => {
      expect(isPrivateIp('198.18.0.231')).toBe(true);
      expect(isPrivateIp('198.19.1.1')).toBe(true);
    });
  });

  it('显式信任后放行，且不波及其他内网段', async () => {
    await withEnv(undefined, () => {
      const opts = { trustedCidrs: ['198.18.0.0/15'] };
      expect(isPrivateIp('198.18.0.231', opts)).toBe(false);
      expect(isPrivateIp('198.19.255.254', opts)).toBe(false);
      expect(isPrivateIp('10.0.0.1', opts)).toBe(true);
      expect(isPrivateIp('127.0.0.1', opts)).toBe(true);
      expect(isPrivateIp('192.168.1.1', opts)).toBe(true);
    });
  });

  it('可用 env 配置（与 PROXY_ALLOWED_HOSTS 同款约定）', async () => {
    await withEnv('198.18.0.0/15,10.9.0.0/16', () => {
      expect(isPrivateIp('198.18.0.231')).toBe(false);
      expect(isPrivateIp('10.9.1.5')).toBe(false);
      expect(isPrivateIp('10.1.2.3')).toBe(true);
    });
  });

  it('非法条目被忽略，不会误放行', async () => {
    await withEnv('banana,198.18.0.0/99,,', () => {
      expect(isPrivateIp('198.18.0.231')).toBe(true);
    });
  });

  it('支持裸地址写法（等价 /32）', async () => {
    await withEnv(undefined, () => {
      const opts = { trustedCidrs: ['198.18.0.231'] };
      expect(isPrivateIp('198.18.0.231', opts)).toBe(false);
      expect(isPrivateIp('198.18.0.232', opts)).toBe(true);
    });
  });

  it('isTrustedIp 只认 IPv4，IPv6 判定不受影响', async () => {
    await withEnv(undefined, () => {
      const opts = { trustedCidrs: ['198.18.0.0/15'] };
      expect(isTrustedIp('198.18.0.231', opts)).toBe(true);
      expect(isTrustedIp('8.8.8.8', opts)).toBe(false);
      expect(isTrustedIp('2001:4860:4860::8888', opts)).toBe(false);
      expect(isPrivateIp('fd00::1', opts)).toBe(true);
    });
  });

  it('assertProxyHost 信任后可放行 fake-IP 字面量', async () => {
    await withEnv(undefined, () => {
      expect(() => assertProxyHost('198.18.0.231', { allowAny: true })).toThrow(/内网/);
      expect(assertProxyHost('198.18.0.231', {
        allowAny: true,
        trustedCidrs: ['198.18.0.0/15'],
      })).toBe('198.18.0.231');
    });
  });

  it('safeLookup 按 env 放行 fake-IP（DNS 后置校验）', async () => {
    const blocked = await withEnv(undefined, () => new Promise(resolve => {
      safeLookup('198.18.0.231', {}, (err, address) => resolve({ err, address }));
    }));
    expect(blocked.err?.code).toBe('ESSRFBLOCKED');

    const allowed = await withEnv('198.18.0.0/15', () => new Promise(resolve => {
      safeLookup('198.18.0.231', {}, (err, address) => resolve({ err, address }));
    }));
    expect(allowed.err).toBeFalsy();
    expect(allowed.address).toBe('198.18.0.231');
  });
});