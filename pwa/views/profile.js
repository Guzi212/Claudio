// Profile 视图 · 动态情境画像 + 记忆条目 + taste.md/routines.md + 酷狗导入 + 未匹配列表
import { showAlert, toast } from './ui.js';

let tasteEditor, routinesEditor, btnSave, btnMemoryRefresh;
let memoryConfidence, contextPills, traitForm, traitInput, traitList;
let importUrl, importBucket, btnImport, importStatus;
let unmatchedSection, unmatchedCount, unmatchedList;
let loaded = false;
let loading = false;
let unmatchedLoaded = false;

const VOCAL_LABELS = {
  prefer_vocal: '偏好人声',
  prefer_instrumental: '偏好器乐/纯音',
  neutral: '人声不限',
};

const ENERGY_LABELS = {
  energetic: '高能量驱动',
  calm: '柔和舒缓',
  moderate: '中等松弛',
  neutral: '能量均衡',
};

function addPill(container, text) {
  if (!container || !text) return;
  const span = document.createElement('span');
  span.className = 'insight-pill';
  span.textContent = text;
  container.appendChild(span);
}

async function patchTrait(id, body, okToast) {
  try {
    const r = await fetch(`/api/memory/traits/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || `HTTP ${r.status}`);
    if (okToast) toast(okToast);
    await loadMemory();
  } catch (err) {
    showAlert(`更新记忆失败：${err.message}`);
  }
}

function renderTraits(traits) {
  if (!traitList) return;
  traitList.textContent = '';
  const visible = (Array.isArray(traits) ? traits : []).filter(t => t && t.status !== 'dismissed');
  if (!visible.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = '暂无习得或置顶记忆，继续听歌或直接在上方添加一条。';
    traitList.appendChild(li);
    return;
  }

  for (const trait of visible) {
    const li = document.createElement('li');
    li.className = 'trait-item';

    const main = document.createElement('div');
    main.className = 'trait-main';
    const summaryEl = document.createElement('div');
    summaryEl.className = 'trait-summary';
    summaryEl.textContent = trait.summary || '';
    const meta = document.createElement('div');
    meta.className = 'trait-meta';
    const parts = [];
    if (trait.status === 'pinned') parts.push('已置顶');
    parts.push(trait.source === 'user' ? '手动添加' : '行为习得');
    if (trait.evidence) parts.push(trait.evidence);
    meta.textContent = parts.join(' · ');
    main.append(summaryEl, meta);

    const actions = document.createElement('div');
    actions.className = 'trait-actions';

    const pinBtn = document.createElement('button');
    pinBtn.type = 'button';
    pinBtn.className = 'btn ghost';
    const isPinned = trait.status === 'pinned';
    pinBtn.textContent = isPinned ? '取消置顶' : '置顶';
    pinBtn.addEventListener('click', () => {
      patchTrait(trait.id, { status: isPinned ? 'active' : 'pinned' }, isPinned ? '已取消置顶' : '已置顶');
    });

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn ghost';
    editBtn.textContent = '编辑';
    editBtn.addEventListener('click', () => {
      if (main.querySelector('.trait-edit-row')) return;
      const editRow = document.createElement('div');
      editRow.className = 'search-row trait-edit-row';
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 240;
      input.value = trait.summary || '';
      input.setAttribute('aria-label', '编辑记忆内容');
      const saveEditBtn = document.createElement('button');
      saveEditBtn.type = 'button';
      saveEditBtn.className = 'btn primary';
      saveEditBtn.textContent = '保存';
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'btn ghost';
      cancelBtn.textContent = '取消';
      cancelBtn.addEventListener('click', () => editRow.remove());
      saveEditBtn.addEventListener('click', () => {
        const nextSummary = input.value.trim();
        if (!nextSummary) return;
        patchTrait(trait.id, { summary: nextSummary }, '已修改记忆');
      });
      editRow.append(input, saveEditBtn, cancelBtn);
      main.appendChild(editRow);
      input.focus();
    });

    const dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.className = 'btn ghost';
    dismissBtn.textContent = '否定';
    dismissBtn.addEventListener('click', () => {
      patchTrait(trait.id, { status: 'dismissed' }, '已移除该印象');
    });

    actions.append(pinBtn, editBtn, dismissBtn);
    li.append(main, actions);
    traitList.appendChild(li);
  }
}

async function loadMemory() {
  if (!memoryConfidence && !traitList) return;
  try {
    const [briefRes, traitsRes] = await Promise.allSettled([
      fetch('/api/memory/brief').then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))),
      fetch('/api/memory/traits').then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))),
    ]);
    if (briefRes.status === 'fulfilled' && briefRes.value?.ok) {
      const { context = {}, tasteSummary = {}, activeIntent = null, traits = [] } = briefRes.value;
      if (memoryConfidence) {
        const pct = Math.round((Number(context.confidence) || 0) * 100);
        memoryConfidence.textContent = context.coldStart
          ? '冷启动 · 积累播放后自动生成时段画像'
          : `置信度 ${pct}% · ${tasteSummary.sessionCount || 0} 次会话`;
      }
      if (contextPills) {
        contextPills.textContent = '';
        const volText = context.suggestedVolume != null ? `建议音量 ${context.suggestedVolume}%` : '建议音量 学习中';
        addPill(contextPills, volText);
        addPill(contextPills, VOCAL_LABELS[context.vocalPreference] || VOCAL_LABELS.neutral);
        addPill(contextPills, ENERGY_LABELS[context.energyTarget] || ENERGY_LABELS.neutral);
        if (activeIntent?.text) addPill(contextPills, `当前意图：${activeIntent.text}`);
      }
      if (traitsRes.status !== 'fulfilled') renderTraits(traits);
    }
    if (traitsRes.status === 'fulfilled' && traitsRes.value?.ok) {
      renderTraits(traitsRes.value.traits);
    }
  } catch (err) {
    showAlert(`读取动态记忆失败：${err.message}`);
  }
}

async function addUserTrait(summary) {
  const clean = String(summary || '').trim();
  if (!clean) return;
  try {
    const r = await fetch('/api/memory/traits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        summary: clean,
        kind: 'preference',
        scope: 'global',
        status: 'pinned',
      }),
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || `HTTP ${r.status}`);
    if (traitInput) traitInput.value = '';
    toast('已记住偏好');
    await loadMemory();
  } catch (err) {
    showAlert(`保存记忆失败：${err.message}`);
  }
}

async function load(force = false) {
  if (loading) return;
  if (loaded && !force) return;
  loading = true;
  tasteEditor.disabled = true;
  routinesEditor.disabled = true;
  try {
    const [, tasteResult] = await Promise.all([
      loadMemory(),
      fetch('/api/taste').then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }),
    ]);
    tasteEditor.value    = typeof tasteResult.taste    === 'string' ? tasteResult.taste    : '';
    routinesEditor.value = typeof tasteResult.routines === 'string' ? tasteResult.routines : '';
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

// 报错按纯文本渲染：err.message 可能带上游返回的内容，拼进 innerHTML 等于执行它。
export function renderUnmatchedError(list, message) {
  list.textContent = '';
  const li = document.createElement('li');
  li.className = 'muted';
  li.textContent = `加载失败：${message}`;
  list.appendChild(li);
}

async function loadUnmatched() {
  if (unmatchedLoaded) return;
  unmatchedList.innerHTML = '<li class="muted">加载中…</li>';
  try {
    const r = await fetch('/api/unmatched?limit=100');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { items } = await r.json();
    unmatchedCount.textContent = items.length ? `(${items.length})` : '';
    if (!items.length) {
      unmatchedList.innerHTML = '<li class="muted">暂无未匹配歌曲</li>';
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
    renderUnmatchedError(unmatchedList, err.message);
  }
}

export function initProfile() {
  tasteEditor      = document.getElementById('taste-editor');
  routinesEditor   = document.getElementById('routines-editor');
  btnSave          = document.getElementById('profile-save');
  btnMemoryRefresh = document.getElementById('memory-refresh');
  memoryConfidence = document.getElementById('memory-confidence');
  contextPills     = document.getElementById('context-pills');
  traitForm        = document.getElementById('trait-form');
  traitInput       = document.getElementById('trait-input');
  traitList        = document.getElementById('trait-list');
  importUrl        = document.getElementById('import-url');
  importBucket     = document.getElementById('import-bucket');
  btnImport        = document.getElementById('btn-import');
  importStatus     = document.getElementById('import-status');
  unmatchedSection = document.getElementById('unmatched-section');
  unmatchedCount   = document.getElementById('unmatched-count');
  unmatchedList    = document.getElementById('unmatched-list');

  btnSave.addEventListener('click', save);
  btnMemoryRefresh?.addEventListener('click', () => loadMemory());
  traitForm?.addEventListener('submit', e => {
    e.preventDefault();
    addUserTrait(traitInput?.value || '');
  });
  btnImport.addEventListener('click', runImport);
  unmatchedSection.addEventListener('toggle', () => {
    if (unmatchedSection.open) loadUnmatched();
  });

  window.addEventListener('claudio:view-shown', e => {
    if (e.detail === 'profile') load();
  });
}
