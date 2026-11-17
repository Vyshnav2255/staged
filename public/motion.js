// Small motion helpers used across the app. All of them step aside for reduced motion.
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// Segmented controls get a sliding thumb behind the selected button.
function placeThumb(seg, animate) {
  const on = seg.querySelector('button[aria-selected="true"]');
  let th = seg.querySelector(':scope > .seg-thumb');
  if (!on) { if (th) th.style.opacity = '0'; return; }
  if (!th) { th = document.createElement('i'); th.className = 'seg-thumb'; th.setAttribute('aria-hidden', 'true'); seg.prepend(th); animate = false; }
  const x = on.offsetLeft, w = on.offsetWidth, h = on.offsetHeight, y = on.offsetTop;
  if (!animate || calm()) th.style.transition = 'none';
  th.style.transform = `translate(${x}px, ${y}px)`;
  th.style.width = w + 'px'; th.style.height = h + 'px'; th.style.opacity = '1';
  if (!animate || calm()) { th.offsetWidth; th.style.transition = ''; }
  seg.classList.add('has-thumb');
}
export function initSegs() {
  let raf = 0;
  const all = (animate) => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => document.querySelectorAll('.seg').forEach((s) => placeThumb(s, animate))); };
  new MutationObserver((list) => {
    // aria-selected changes slide; new markup just places
    const moved = list.some((m) => m.type === 'attributes');
    all(moved);
  }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['aria-selected'], childList: true });
  addEventListener('resize', () => all(false));
  document.fonts?.ready.then(() => all(false));
  all(false);
}

// Numbers glide to their new value.
const last = new Map();
export function countUp(el, to, key, fmt = (n) => String(Math.round(n))) {
  const from = last.get(key);
  last.set(key, to);
  if (from == null || from === to || calm()) { el.textContent = fmt(to); return; }
  const t0 = performance.now(), d = 520;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / d), e = 1 - Math.pow(1 - k, 3);
    el.textContent = fmt(from + (to - from) * e);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// A section that just changed fades up into place.
export function enter(el) {
  if (!el || calm()) return;
  el.classList.remove('is-entering');
  void el.offsetWidth;
  el.classList.add('is-entering');
  el.addEventListener('animationend', () => el.classList.remove('is-entering'), { once: true });
}
