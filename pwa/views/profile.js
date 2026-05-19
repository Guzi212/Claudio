// Profile 视图 · 编辑 taste.md
import { showAlert, toast } from './ui.js';

let editor, btnSave;
let loaded = false;
let loading = false;

async function load(force = false) {
  if (loading) return;
  if (loaded && !force) return;
  loading = true;
  editor.disabled = true;
  try {
    const r = await fetch('/api/taste');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    editor.value = typeof data.taste === 'string' ? data.taste : '';
    loaded = true;
  } catch (err) {
    showAlert(`读取 taste.md 失败：${err.message}`);
  } finally {
    editor.disabled = false;
    loading = false;
  }
}

async function save() {
  btnSave.disabled = true;
  const original = btnSave.textContent;
  btnSave.textContent = '保存中…';
  try {
    const r = await fetch('/api/taste', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taste: editor.value }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    toast('已保存');
  } catch (err) {
    showAlert(`保存失败：${err.message}`);
  } finally {
    btnSave.textContent = original;
    btnSave.disabled = false;
  }
}

export function initProfile() {
  editor  = document.getElementById('taste-editor');
  btnSave = document.getElementById('profile-save');

  btnSave.addEventListener('click', save);

  // 第一次切到 Profile tab 时再加载，避免冷启动多打一次没用的请求
  window.addEventListener('claudio:view-shown', e => {
    if (e.detail === 'profile') load();
  });
}
