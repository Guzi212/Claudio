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
});
