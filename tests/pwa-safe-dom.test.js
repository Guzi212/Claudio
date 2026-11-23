import { describe, expect, it } from 'vitest';

function element(tag) {
  return {
    tagName: tag.toUpperCase(),
    children: [],
    dataset: {},
    attributes: {},
    className: '',
    textContent: '',
    setAttribute(name, value) { this.attributes[name] = String(value); },
    appendChild(child) { this.children.push(child); },
    append(...children) { this.children.push(...children); },
  };
}

function dom() {
  const previous = globalThis.document;
  globalThis.document = { createElement: element, createTextNode: text => ({ textContent: text }), getElementById: () => null };
  return () => { globalThis.document = previous; };
}

describe('safe dynamic UI', () => {
  it('健康检查消息按纯文本展示', async () => {
    const restore = dom();
    const { renderHealthItems } = await import('../pwa/views/settings.js');
    const list = element('ul');
    renderHealthItems(list, [{ label: 'KuGou', ok: true, message: '<img src=x onerror=alert(1)>' }]);
    expect(list.children[0].children.map(child => child.textContent)).toEqual(['✓', 'KuGou', '<img src=x onerror=alert(1)>']);
    restore();
  });

  it('二维码弹窗拒绝脚本链接，链接文本不当作 HTML', async () => {
    const restore = dom();
    const { createReloginModal } = await import('../pwa/views/settings.js');
    const modal = createReloginModal({ qrUrl: 'javascript:alert(1)', qrImg: 'javascript:alert(1)' });
    const flat = [];
    const visit = node => { if (node.tagName) flat.push(node); for (const child of node.children || []) visit(child); };
    visit(modal);
    expect(flat.some(node => node.tagName === 'IMG')).toBe(false);
    expect(flat.some(node => node.tagName === 'A')).toBe(false);
    restore();
  });

  it('支持网易云与 QQ（含手机 QQ / 微信切换）扫码弹窗与登录态渲染', async () => {
    const restore = dom();
    const { createReloginModal, renderProviderLoginState } = await import('../pwa/views/settings.js');
    const qqModal = createReloginModal({
      provider: 'qq',
      qqType: 'wx',
      qrImg: 'data:image/png;base64,AAAA',
    });
    const flat = [];
    const visit = node => { if (node.tagName) flat.push(node); for (const child of node.children || []) visit(child); };
    visit(qqModal);
    expect(flat.some(node => node.tagName === 'IMG')).toBe(true);
    expect(flat.filter(node => node.dataset?.qqType)).toHaveLength(2);

    const statusEl = element('div');
    const btnEl = element('button');
    renderProviderLoginState(statusEl, btnEl, { ok: true, loggedIn: false, detail: 'anonymous cookie ready' });
    expect(statusEl.textContent).toContain('未登录');
    expect(btnEl.textContent).toBe('扫码登录');

    renderProviderLoginState(statusEl, btnEl, { ok: true, loggedIn: true, detail: 'logged in (Loic)' });
    expect(statusEl.textContent).toContain('已登录');
    expect(btnEl.textContent).toBe('重扫码');
    restore();
  });
});
