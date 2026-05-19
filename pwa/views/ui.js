// 全局 UI 帮手：错误条 / 状态栏 / toast。各视图共用。
const alertBar = document.getElementById('alert-bar');
const statusEl = document.getElementById('status');
const toastEl  = document.getElementById('toast');

export function showAlert(msg) {
  if (!alertBar) return;
  alertBar.textContent = msg;
  alertBar.classList.remove('hidden');
}

export function clearAlert() {
  if (!alertBar) return;
  alertBar.classList.add('hidden');
}

export function setStatus(text) {
  if (!statusEl) return;
  statusEl.textContent = text;
}

let toastTimer = null;
export function toast(msg, { duration = 1800 } = {}) {
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), duration);
}
