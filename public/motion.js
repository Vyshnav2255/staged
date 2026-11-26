// Small motion helpers used across the app. All of them step aside for reduced motion.
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// One motion language for the whole app, built on our own springs (no library).
//   quick: hovers, presses, small state changes        smooth: panels, menus, layout, lists
//   soft: the celebratory moments (a commit landing in the cart)
// The same springs drive JS animations (animate, below) and CSS: each one is also turned into a
// CSS duration + linear() easing, so a CSS transition and a JS animation side by side move as one.
export const SPRING = Object.freeze({
  // Tuned to the transitions.dev scale (2026-11-26): settle times of about 250 / 250 / 400 / 500ms.
  quick: Object.freeze({ type: 'spring', visualDuration: 0.09, bounce: 0 }),
  snap: Object.freeze({ type: 'spring', visualDuration: 0.115, bounce: 0.06 }),
  smooth: Object.freeze({ type: 'spring', visualDuration: 0.23, bounce: 0.08 }),
  soft: Object.freeze({ type: 'spring', visualDuration: 0.245, bounce: 0.18 }),
});
// A damped spring from 0 to 1, stepped until it settles. visualDuration is roughly when it first
// reaches the target; bounce 0 means no overshoot. Returns the settle time and a CSS linear() easing.
const springCache = new Map();
function springCurve({ visualDuration = 0.3, bounce = 0, velocity = 0 } = {}) {
  const key = visualDuration + '|' + bounce + '|' + velocity;
  if (springCache.has(key)) return springCache.get(key);
  const k = (2 * Math.PI / (visualDuration * 1.2)) ** 2;
  const c = 2 * Math.min(1, Math.max(0.05, 1 - bounce)) * Math.sqrt(k);
  const dt = 1 / 600; let x = 0, v = velocity, t = 0, rest = 0;
  const pts = [0];
  while (t < 4) {
    for (let i = 0; i < 10; i++) { const a = -k * (x - 1) - c * v; v += a * dt; x += v * dt; t += dt; }
    pts.push(x);
    if (Math.abs(1 - x) < 0.001 && Math.abs(v) < 0.01) { if (++rest > 3) break; } else rest = 0;
  }
  pts[pts.length - 1] = 1;
  const r = { ms: Math.round(t * 1000), ease: `linear(${pts.map((p) => +p.toFixed(4)).join(', ')})` };
  springCache.set(key, r); return r;
}
const CSSV = { quick: springCurve(SPRING.quick), snap: springCurve(SPRING.snap), smooth: springCurve(SPRING.smooth), soft: springCurve(SPRING.soft) };
// For element.animate(): the duration and easing of each spring.
export const MS = Object.freeze({ quick: CSSV.quick.ms, snap: CSSV.snap.ms, smooth: CSSV.smooth.ms, soft: CSSV.soft.ms, exit: 150, close: 350 });
export const EASE = Object.freeze({ quick: CSSV.quick.ease, snap: CSSV.snap.ease, smooth: CSSV.smooth.ease, soft: CSSV.soft.ease, exit: 'cubic-bezier(.4, 0, 1, 1)', close: 'cubic-bezier(.22, 1, .36, 1)' });

// animate(el, { opacity, x, y, scale, width, height }, opts): each value is a target or [from, to].
// opts is a SPRING tier or { duration (seconds), ease: 'easeIn' | 'easeOut' | css easing }.
// The end values are written to the element, a new call takes over from wherever the last one is,
// and it resolves when done. Under reduced motion it jumps to the end.
const NAMED = { easeIn: 'cubic-bezier(.4, 0, 1, 1)', easeOut: 'cubic-bezier(0, 0, .2, 1)', easeInOut: 'cubic-bezier(.4, 0, .2, 1)', linear: 'linear' };
const PX = new Set(['width', 'height']);
const TF = ['x', 'y', 'scale'];
function nowOf(el) {
  const cs = getComputedStyle(el); const m = new DOMMatrixReadOnly(cs.transform === 'none' ? undefined : cs.transform);
  return { x: m.e, y: m.f, scale: Math.hypot(m.a, m.b) || 1, opacity: +cs.opacity, width: parseFloat(cs.width), height: parseFloat(cs.height) };
}
const tf = (v) => `translate(${v.x}px, ${v.y}px) scale(${v.scale})`;
export function animate(el, values, opts = SPRING.smooth) {
  if (!el) return Promise.resolve();
  const now = nowOf(el);
  for (const a of el.getAnimations()) if (a.id === 'staged-motion') a.cancel();
  const from = { ...now }, to = { ...now };
  for (const [k, v] of Object.entries(values)) {
    const [a, b] = Array.isArray(v) ? v : [now[k], v];
    from[k] = parseFloat(a); to[k] = parseFloat(b);
  }
  const keys = Object.keys(values), hasTf = keys.some((k) => TF.includes(k));
  const frame = (v) => {
    const f = {};
    if (hasTf) f.transform = tf(v);
    for (const k of keys) if (!TF.includes(k)) f[k] = PX.has(k) ? v[k] + 'px' : v[k];
    return f;
  };
  // the end state lives on the element; identity transforms are removed so CSS keeps control of hover lifts
  const end = frame(to);
  for (const [k, v] of Object.entries(end)) el.style[k] = String(v);
  if (hasTf && !to.x && !to.y && to.scale === 1) el.style.removeProperty('transform');
  const instant = calm() || opts.duration === 0;
  if (instant) return Promise.resolve();
  const timing = opts.type === 'spring' ? springCurve(opts) : { ms: (opts.duration ?? 0.3) * 1000, ease: NAMED[opts.ease] || opts.ease || NAMED.easeOut };
  const anim = el.animate([frame(from), end], { duration: timing.ms, easing: timing.ease, id: 'staged-motion' });
  return anim.finished.then(() => {}, () => {});
}

// A popup (menu, popover) leaves the same way everywhere: a quick fade and a small shrink, then it's gone.
export function leave(el) {
  if (!el || !el.isConnected) return;
  el.style.pointerEvents = 'none';
  if (calm()) { el.remove(); return; }
  el.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-2px) scale(.99)' }], { duration: MS.exit, easing: EASE.exit, fill: 'forwards' })
    .finished.then(() => el.remove(), () => el.remove());
}

// Older tier names, still used for exit timings.
export const spring = Object.freeze({
  fast: Object.freeze({ type: 'spring', duration: MS.quick / 1000, bounce: 0, exit: Object.freeze({ duration: 0.1 }) }),
  moderate: Object.freeze({ type: 'spring', duration: MS.smooth / 1000, bounce: 0, exit: Object.freeze({ duration: 0.14 }) }),
  slow: Object.freeze({ type: 'spring', duration: MS.smooth / 1000, bounce: 0.08, exit: Object.freeze({ duration: 0.18 }) }),
});

export function exitFallbackMs(tier) {
  const token = spring[tier];
  if (!token) throw new RangeError(`Unknown motion tier: ${tier}`);
  return Math.ceil(token.exit.duration * 1000 + 100);
}

export function initMotionSystem() {
  const style = document.documentElement.style;
  for (const [k, v] of Object.entries(CSSV)) { style.setProperty(`--dur-${k}`, `${v.ms}ms`); style.setProperty(`--ease-${k}`, v.ease); }
  style.setProperty('--dur-exit', `${MS.exit}ms`); style.setProperty('--ease-exit', EASE.exit);
  style.setProperty('--dur-close', `${MS.close}ms`); style.setProperty('--ease-close', EASE.close);
  // The older tokens follow the same springs, so every existing transition joins in.
  const map = { fast: 'quick', moderate: 'smooth', slow: 'smooth' };
  for (const [old, now] of Object.entries(map)) {
    style.setProperty(`--motion-${old}-duration`, `${CSSV[now].ms}ms`);
    style.setProperty(`--motion-${old}-exit-duration`, `${spring[old].exit.duration * 1000}ms`);
    style.setProperty(`--ease-spring-${old}`, CSSV[now].ease);
  }
  style.setProperty('--ease-out', CSSV.smooth.ease);
  style.setProperty('--ease-drawer', CSSV.smooth.ease);
}

// Segmented controls get a sliding thumb behind the selected button.
function placeThumb(seg, move) {
  const on = seg.querySelector('button[aria-selected="true"]');
  let th = seg.querySelector(':scope > .seg-thumb');
  if (!on) { if (th) th.style.opacity = '0'; return; }
  if (!th) { th = document.createElement('i'); th.className = 'seg-thumb'; th.setAttribute('aria-hidden', 'true'); seg.prepend(th); move = false; }
  const to = { x: on.offsetLeft, y: on.offsetTop, width: on.offsetWidth, height: on.offsetHeight };
  th.style.opacity = '1';
  // A spring that can be caught mid-way: click two tabs fast and the thumb bends toward the second.
  animate(th, { x: to.x, y: to.y, width: to.width, height: to.height }, move ? SPRING.smooth : { duration: 0 });
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

// One shared highlight glides between repository rows. The list is rendered
// repeatedly, so events are delegated from the stable #repos host.
export function initFluidHover(root) {
  if (!root || root.dataset.fluidHoverBound) return;
  root.dataset.fluidHoverBound = 'true';

  let active = null;
  let focused = null;
  const getItem = (node) => node instanceof Element ? node.closest('.repo-list .repo[data-repo]') : null;
  const setActive = (item) => {
    const list = item?.closest('.repo-list') || root.querySelector('.repo-list');
    const highlight = list?.querySelector('.repo-hover');
    if (!list || !highlight) return;
    if (!item || item.hidden || !list.contains(item)) {
      active?.removeAttribute('data-fluid-hover-active');
      active = null;
      list.classList.remove('has-fluid-hover');
      delete list.dataset.fluidHoverActiveIndex;
      return;
    }
    if (active !== item) {
      active?.removeAttribute('data-fluid-hover-active');
      active = item;
      active.setAttribute('data-fluid-hover-active', '');
    }
    const box = item.getBoundingClientRect();
    const frame = list.getBoundingClientRect();
    const x = box.left - frame.left + list.scrollLeft;
    const y = box.top - frame.top + list.scrollTop;
    highlight.style.width = `${box.width}px`;
    highlight.style.height = `${box.height}px`;
    highlight.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    list.dataset.fluidHoverActiveIndex = String([...list.querySelectorAll('.repo[data-repo]:not([hidden])')].indexOf(item));
    list.classList.add('has-fluid-hover');
  };

  root.addEventListener('pointerover', (event) => {
    if (event.pointerType !== 'mouse') return;
    const item = getItem(event.target);
    if (item && item !== getItem(event.relatedTarget)) setActive(item);
  });
  root.addEventListener('pointerout', (event) => {
    if (event.pointerType !== 'mouse') return;
    const from = getItem(event.target);
    if (!from || getItem(event.relatedTarget)) return;
    setActive(focused && root.contains(focused) ? focused : null);
  });
  root.addEventListener('focusin', (event) => {
    const item = getItem(event.target);
    if (item) { focused = item; setActive(item); }
  });
  root.addEventListener('focusout', (event) => {
    const item = getItem(event.target);
    if (!item || getItem(event.relatedTarget)) return;
    focused = null;
    if (!root.querySelector('.repo-list:hover')) setActive(null);
  });
  addEventListener('resize', () => { if (active && root.contains(active)) setActive(active); });
  root.addEventListener('scroll', () => { if (active && root.contains(active)) setActive(active); }, true);
  new MutationObserver(() => {
    if (active && (!root.contains(active) || active.hidden)) setActive(null);
    else if (active) setActive(active);
  }).observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
}

// A section that just changed fades up into place.
export function enter(el) {
  if (!el || calm()) return;
  el.classList.remove('is-entering');
  void el.offsetWidth;
  el.classList.add('is-entering');
  el.addEventListener('animationend', () => el.classList.remove('is-entering'), { once: true });
}
