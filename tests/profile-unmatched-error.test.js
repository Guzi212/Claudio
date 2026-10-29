import { describe, expect, it } from 'vitest';

function element(tag) {
  const node = {
    tagName: tag.toUpperCase(),
    children: [],
    className: '',
    appendChild(child) { node.children.push(child); },
  };
  // 真实 DOM 里设 textContent 会清空子节点，这里照做，否则「先清空」断言没意义
  let text = '';
  Object.defineProperty(node, 'textContent', {
    get() { return text; },
    set(value) {
      text = String(value);
      node.children.length = 0;
    },
  });
  return node;
}

function installDom() {
  const previous = globalThis.document;
  globalThis.document = {
    createElement: element,
    createTextNode: text => ({ textContent: text }),
    getElementById: () => null,
  };
  return () => { globalThis.document = previous; };
}

function flatten(node) {
  const flat = [];
  const visit = n => {
    if (n.tagName) flat.push(n);
    for (const child of n.children || []) visit(child);
  };
  visit(node);
  return flat;
}

describe('未匹配列表报错按纯文本显示', () => {
  it('<img src=x onerror=alert(1)> 作为报错信息时不会产生 IMG 元素', async () => {
    const restore = installDom();
    try {
      const { renderUnmatchedError } = await import('../pwa/views/profile.js');
      const list = element('ul');

      renderUnmatchedError(list, '<img src=x onerror=alert(1)>');

      const nodes = flatten(list);
      expect(nodes.some(node => node.tagName === 'IMG')).toBe(false);
      expect(nodes.map(node => node.tagName)).toEqual(['UL', 'LI']);
      expect(nodes[1].textContent).toBe('加载失败：<img src=x onerror=alert(1)>');
      expect(nodes[1].className).toBe('muted');
    } finally {
      restore();
    }
  });

  it('重复报错时先清空旧内容', async () => {
    const restore = installDom();
    try {
      const { renderUnmatchedError } = await import('../pwa/views/profile.js');
      const list = element('ul');
      list.children.push(element('li'));

      renderUnmatchedError(list, 'HTTP 500');

      expect(list.children).toHaveLength(1);
      expect(list.children[0].textContent).toBe('加载失败：HTTP 500');
    } finally {
      restore();
    }
  });
});
