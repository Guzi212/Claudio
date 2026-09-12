// Profile 视图 · taste.md + routines.md + 酷狗导入 + 未匹配列表
import { showAlert, toast } from './ui.js';

let tasteEditor, routinesEditor, btnSave;
let importUrl, importBucket, btnImport, importStatus;
let unmatchedSection, unmatchedCount, unmatchedList;
let loaded = false;
let loading = false;
let unmatchedLoaded = false;

async function load(force = false) {
  if (loading) return;
  if (loaded && !force) return;
  loading = true;
  tasteEditor.disabled = true;
  routinesEditor.disabled = true;
  try {
    const r = await fetch('/api/taste');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    tasteEditor.value    = typeof data.taste    === 'string' ? data.taste    : '';
    routinesEditor.value = typeof data.routines === 'string' ? data.routines : '';
    loaded = true;
  } catch (err) {
    showAlert(`读取 Profile 失败：${err.message}`);
  } finally {
    tasteEditor.disabled    = false;
    routinesEditor.disabled = false;
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
      body: JSON.stringify({ taste: tasteEditor.value, routines: routinesEditor.value }),
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

async function runImport() {
  const url = importUrl.value.trim();
  if (!url) { importStatus.textContent = '请先粘贴分享链接'; return; }

  btnImport.disabled = true;
  importStatus.textContent = '导入中，请稍等…';
  try {
    const r = await fetch('/api/kugou/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, bucket: importBucket.value }),
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || `HTTP ${r.status}`);
    const note = data.truncated ? `（仅拉到 ${data.fetchedCount}/${data.totalCount}，可能未拉全）` : '';
    importStatus.textContent = `已导入 ${data.tracksCount} 首 ${note}`;
    importUrl.value = '';
    // 刷新 taste 编辑器（distilled 区块已更新）
    load(true);
    unmatchedLoaded = false;
  } catch (err) {
    importStatus.textContent = `导入失败：${err.message}`;
  } finally {
    btnImport.disabled = false;
  }
}

async function loadUnmatched() {
  if (unmatchedLoaded) return;
  setUnmatchedHint('加载中…');
  try {
    const r = await fetch('/api/unmatched?limit=100');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { items } = await r.json();
    unmatchedCount.textContent = items.length ? `(${items.length})` : '';
    if (!items.length) {
      setUnmatchedHint('暂无未匹配歌曲');
    } else {
      unmatchedList.textContent = '';
      for (const i of items) {
        const li = document.createElement('li');
        const muted = document.createElement('span');
        li.textContent = `${i.title} `;
        muted.className = 'muted';
        muted.textContent = `— ${i.artist}`;
        li.appendChild(muted);
        unmatchedList.appendChild(li);
      }
    }
    unmatchedLoaded = true;
  } catch (err) {
    setUnmatchedHint(`加载失败：${err.message}`);
  }
}

function setUnmatchedHint(text) {
  const li = document.createElement('li');
  li.className = 'muted';
  li.textContent = text;
  unmatchedList.replaceChildren(li);
}

export function initProfile() {
  tasteEditor    = document.getElementById('taste-editor');
  routinesEditor = document.getElementById('routines-editor');
  btnSave        = document.getElementById('profile-save');
  importUrl      = document.getElementById('import-url');
  importBucket   = document.getElementById('import-bucket');
  btnImport      = document.getElementById('btn-import');
  importStatus   = document.getElementById('import-status');
  unmatchedSection = document.getElementById('unmatched-section');
  unmatchedCount   = document.getElementById('unmatched-count');
  unmatchedList    = document.getElementById('unmatched-list');

  btnSave.addEventListener('click', save);
  btnImport.addEventListener('click', runImport);
  unmatchedSection.addEventListener('toggle', () => {
    if (unmatchedSection.open) loadUnmatched();
  });

  window.addEventListener('claudio:view-shown', e => {
    if (e.detail === 'profile') load();
  });
}
