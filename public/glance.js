// Glance rail: one short line per week, feature, release or suggested commit, pinned to the right.
// Hover to see the names; click one to glide there.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let rail, list, targets = [], sig = '', active = -1, raf = 0, gliding = 0;

export function initGlance(main) {
  rail = document.createElement('nav');
  rail.className = 'glance'; rail.setAttribute('aria-label', 'Jump to');
  rail.innerHTML = `<div class="gl-panel"><div class="gl-list scroll-fade"></div></div>`;
  document.body.append(rail);
  list = rail.querySelector('.gl-list');
  rail.addEventListener('click', onClick);
  new MutationObserver(schedule).observe(main, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'data-gl'] });
  addEventListener('scroll', spy, { passive: true });
  addEventListener('resize', spy);
  // A wheel or a key press takes over from a glide in progress.
  for (const ev of ['wheel', 'touchstart', 'keydown']) addEventListener(ev, () => cancelAnimationFrame(gliding), { passive: true });
  schedule();
}

function schedule() { cancelAnimationFrame(raf); raf = requestAnimationFrame(build); }

function build() {
  targets = [...document.querySelectorAll('.main [data-gl]')].filter((el) => el.offsetParent);
  const next = targets.map((el) => el.dataset.gl + el.dataset.glN).join('|');
  const long = targets.length >= 3 && document.documentElement.scrollHeight > innerHeight * 1.6;
  rail.classList.toggle('is-on', long);
  rail.inert = !long;
  if (next === sig) return spy();
  sig = next;
  list.innerHTML = targets.map((el, i) => {
    const n = +el.dataset.glN || 0, unit = el.dataset.glUnit || 'commit';
    return `<button class="gl-i" data-gl-i="${i}" title="${esc(el.dataset.gl)} · ${n} ${unit}${n === 1 ? '' : 's'}"><span class="gl-l">${esc(el.dataset.gl)}</span><span class="gl-n mono">${n}</span><i class="gl-line"></i></button>`;
  }).join('');
  active = -1;
  spy();
}

function spy() {
  if (!targets.length || !rail.classList.contains('is-on')) return;
  const line = 120;
  let i = 0;
  for (let k = 0; k < targets.length; k++) { if (targets[k].getBoundingClientRect().top - line <= 0) i = k; else break; }
  if (innerHeight + scrollY >= document.documentElement.scrollHeight - 4) i = targets.length - 1;
  if (i === active) return;
  active = i;
  list.querySelectorAll('.gl-i').forEach((b, k) => b.toggleAttribute('aria-current', k === i));
  const b = list.children[i];
  if (b) list.scrollTo({ top: Math.max(0, b.offsetTop - list.clientHeight / 2), behavior: 'smooth' });
}

// Glides the page to a point: quick to start, soft to land, and longer only for longer trips.
function glide(to, done) {
  cancelAnimationFrame(gliding);
  const from = scrollY, dist = to - from;
  if (Math.abs(dist) < 2 || matchMedia('(prefers-reduced-motion: reduce)').matches) { scrollTo(0, to); return done?.(); }
  const ms = Math.min(900, 380 + Math.sqrt(Math.abs(dist)) * 9), t0 = performance.now();
  const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
  const step = (t) => {
    const k = Math.min(1, (t - t0) / ms);
    scrollTo(0, from + dist * ease(k));
    if (k < 1) gliding = requestAnimationFrame(step); else done?.();
  };
  gliding = requestAnimationFrame(step);
}

function onClick(e) {
  const b = e.target.closest('[data-gl-i]');
  if (!b) return;
  b.blur(); // so the rail closes as soon as the mouse leaves
  const el = targets[+b.dataset.glI];
  if (!el) return;
  const margin = parseFloat(getComputedStyle(el).scrollMarginTop) || 0;
  const max = document.documentElement.scrollHeight - innerHeight;
  glide(Math.min(max, Math.max(0, el.getBoundingClientRect().top + scrollY - margin)), () => {
    el.classList.remove('gl-flash'); void el.offsetWidth; el.classList.add('gl-flash');
    el.addEventListener('animationend', () => el.classList.remove('gl-flash'), { once: true });
  });
}
