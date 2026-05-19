// 环境信息条 · 客户端能算的最小子集
//
// 当前只渲染 "⏰ 周X 时段 · Claudio"。
// 等后端有 /api/env 提供天气/日程等，可在此扩展（fetch 失败时优雅降级）。

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const PERIODS = [
  { until: 5,  label: '凌晨' },
  { until: 9,  label: '清晨' },
  { until: 12, label: '上午' },
  { until: 14, label: '中午' },
  { until: 18, label: '下午' },
  { until: 22, label: '晚上' },
  { until: 24, label: '深夜' },
];

export function getTimePeriod(hour) {
  for (const p of PERIODS) if (hour < p.until) return p.label;
  return '深夜';
}

export function formatNow(d = new Date()) {
  const wd = WEEKDAYS[d.getDay()] ?? '';
  const period = getTimePeriod(d.getHours());
  return `⏰ ${wd} ${period} · Claudio`;
}

let initialized = false;
let timerId = null;

export function init({ container } = {}) {
  if (!container) return null;
  initialized = true;

  const render = () => {
    container.textContent = formatNow();
    container.classList.remove('hidden');
  };
  render();

  if (timerId) clearInterval(timerId);
  timerId = setInterval(render, 60_000);

  return {
    refresh: render,
    stop() {
      if (timerId) clearInterval(timerId);
      timerId = null;
    },
  };
}

// ──── 兜底：DOMContentLoaded 自动 attach ────
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const tryAuto = () => {
    if (initialized) return;
    const registry = window.__claudioInit;
    if (registry && registry.envStrip) return;
    const el = document.getElementById('env-strip');
    if (!el) return;
    init({ container: el });
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryAuto);
  } else {
    tryAuto();
  }
}
