// Small motion helpers used across the app. All of them step aside for reduced motion.
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// Shared Motion tiers for this dependency-free app. Durations and bounce mirror
// Fluid Functionalism; CSS consumes the matching custom properties below.
export const spring = Object.freeze({
  fast: Object.freeze({ type: 'spring', duration: 0.08, bounce: 0, exit: Object.freeze({ duration: 0.06 }) }),
  moderate: Object.freeze({ type: 'spring', duration: 0.16, bounce: 0, exit: Object.freeze({ duration: 0.12 }) }),
  slow: Object.freeze({ type: 'spring', duration: 0.24, bounce: 0.12, exit: Object.freeze({ duration: 0.16 }) }),
});

export function exitFallbackMs(tier) {
  const token = spring[tier];
  if (!token) throw new RangeError(`Unknown motion tier: ${tier}`);
  return Math.ceil(token.exit.duration * 1000 + 100);
}

function springEasing(bounce) {
  const damping = bounce ? 1 - bounce * 2.5 : 1;
  const omega = 8;
  const valueAt = (t) => {
    if (damping === 1) return 1 - (1 + omega * t) * Math.exp(-omega * t);
    const damped = omega * Math.sqrt(1 - damping * damping);
    return 1 - Math.exp(-damping * omega * t) * (
      Math.cos(damped * t) + damping / Math.sqrt(1 - damping * damping) * Math.sin(damped * t)
    );
  };
  const end = valueAt(1);
  const points = Array.from({ length: 21 }, (_, i) => `${(valueAt(i / 20) / end).toFixed(4)} ${i * 5}%`);
  return `linear(${points.join(', ')})`;
}

export function initMotionSystem() {
  const style = document.documentElement.style;
  for (const tier of Object.keys(spring)) {
    const token = spring[tier];
    style.setProperty(`--motion-${tier}-duration`, `${token.duration * 1000}ms`);
    style.setProperty(`--motion-${tier}-exit-duration`, `${token.exit.duration * 1000}ms`);
  }
  if (!globalThis.CSS?.supports?.('transition-timing-function', 'linear(0, 1)')) return;
  for (const tier of Object.keys(spring)) style.setProperty(`--ease-spring-${tier}`, springEasing(spring[tier].bounce));
}

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
