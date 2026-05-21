// Player 顶部的电台棚粒子动画。无依赖，自动挂到 #particle-field。
function initParticleField() {
  const canvas = document.getElementById('particle-field');
  const stage = canvas?.closest('.studio-stage');
  if (!canvas || !stage) return;

  const ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
  if (!ctx) return;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let width = 0;
  let height = 0;
  let dpr = 1;
  let raf = 0;
  let particles = [];

  function resize() {
    const rect = stage.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = Math.max(1, Math.floor(rect.width));
    height = Math.max(1, Math.floor(rect.height));
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const count = Math.min(88, Math.max(34, Math.floor(width * height / 10000)));
    particles = Array.from({ length: count }, (_, i) => ({
      x: Math.random() * width,
      y: Math.random() * height,
      vx: (Math.random() - 0.5) * 0.28,
      vy: (Math.random() - 0.5) * 0.24,
      r: i % 7 === 0 ? 1.8 : 1.1,
      phase: Math.random() * Math.PI * 2,
    }));
  }

  function draw() {
    cancelAnimationFrame(raf);
    ctx.clearRect(0, 0, width, height);
    const time = performance.now() * 0.001;

    const gradient = ctx.createRadialGradient(width * 0.72, height * 0.3, 0, width * 0.72, height * 0.3, width * 0.72);
    gradient.addColorStop(0, 'rgba(57, 213, 255, 0.18)');
    gradient.addColorStop(0.45, 'rgba(111, 181, 110, 0.08)');
    gradient.addColorStop(1, 'rgba(12, 12, 16, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    for (const p of particles) {
      if (!reducedMotion) {
        p.x += p.vx;
        p.y += p.vy + Math.sin(time + p.phase) * 0.025;
        if (p.x < -8) p.x = width + 8;
        if (p.x > width + 8) p.x = -8;
        if (p.y < -8) p.y = height + 8;
        if (p.y > height + 8) p.y = -8;
      }

      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = p.r > 1.5 ? 'rgba(255, 181, 137, 0.9)' : 'rgba(124, 226, 255, 0.78)';
      ctx.fill();
    }

    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const a = particles[i];
        const b = particles[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dist = Math.hypot(dx, dy);
        if (dist > 92) continue;
        ctx.strokeStyle = `rgba(124, 226, 255, ${0.16 * (1 - dist / 92)})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }

    raf = requestAnimationFrame(draw);
  }

  resize();
  draw();
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 150);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) cancelAnimationFrame(raf);
    else draw();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initParticleField);
} else {
  initParticleField();
}

function initStudioClock() {
  const clock = document.getElementById('studio-clock');
  const weekday = document.getElementById('studio-weekday');
  const date = document.getElementById('studio-date');
  if (!clock || !weekday || !date) return;

  const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function updateClock() {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    clock.textContent = `${hh}:${mm}`;
    weekday.textContent = weekdays[now.getDay()];
    date.textContent = `${String(now.getDate()).padStart(2, '0')} · ${months[now.getMonth()]} · ${now.getFullYear()}`;
  }

  updateClock();
  setInterval(updateClock, 30000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initStudioClock);
} else {
  initStudioClock();
}
