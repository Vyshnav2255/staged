// Little moments, kept smooth: only transform, opacity and clip-path move, on springs.
// Commit (subtle): the card closes into a dot, the dot glides to the banner and lands; the cards
// below slide up into the gap instead of jumping.
import { sfxFold, sfxLand, sfxDiscard } from './sfx.js';
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const GLIDE = 'cubic-bezier(.22,1,.36,1)';


const center = (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
// Points along a cubic curve, with time eased so the flight speeds up and settles.
function path(p0, c1, c2, p3, steps = 16, ease = easeInOut) {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const t = ease(i / steps), u = 1 - t;
    out.push({
      x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p3.y,
    });
  }
  return out;
}

// Call before the view redraws. Returns land(target), to call right after the redraw.
// Commit. The card closes in place: its content fades, then it collapses to nothing so the cards
// below rise up naturally (the list waits for this before it redraws, so nothing jumps). As it
// closes, a dot appears at its middle and, once the commit is made, glides to the new row in the cart.
export function foldRepaint() {}
export function commitFold(card) {
  const none = () => {}; none.ready = Promise.resolve();
  if (!card) return none;
  if (calm()) { const f = (t) => { if (t !== false) sfxLand(); }; f.ready = Promise.resolve(); return f; }
  const r = card.getBoundingClientRect(), from = center(r);
  const h = card.offsetHeight, mb = getComputedStyle(card).marginBottom;
  card.style.pointerEvents = 'none';
  sfxFold();
  const EASE = 'cubic-bezier(.45,0,.25,1)';
  for (const k of card.children) k.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.97)' }], { duration: 260, easing: EASE, fill: 'forwards' });
  const collapse = card.animate([
    { height: h + 'px', marginBottom: mb, transform: 'none', opacity: 1 },
    { height: h + 'px', marginBottom: mb, transform: 'scale(.985)', opacity: 1, offset: 0.3 },
    { height: '0px', marginBottom: '0px', transform: 'scale(.97)', opacity: 0, borderWidth: '0px' },
  ], { duration: 640, easing: EASE, fill: 'forwards' });
  const dotEl = document.createElement('i');
  Object.assign(dotEl.style, { position: 'fixed', left: from.x - 5 + 'px', top: r.top + 18 + 'px', width: '10px', height: '10px', borderRadius: '50%', background: 'var(--logo-box)', zIndex: 41, pointerEvents: 'none', willChange: 'transform, translate, opacity' });
  document.body.appendChild(dotEl);
  dotEl.animate([{ transform: 'scale(0)', opacity: 0 }, { transform: 'scale(1.35)', opacity: 1, offset: 0.6 }, { transform: 'scale(1)', opacity: 1 }], { duration: 320, delay: 240, easing: 'cubic-bezier(.3,0,.3,1)', fill: 'both' });
  // 2. Glide: as soon as the card has closed, the dot sets off for the top of the cart, where the
  // new row is about to open (no waiting on the reload), on a gentle arc.
  let glide = null, failed = false;
  const fly = () => {
    if (failed || !dotEl.isConnected) return;
    const p0 = center(dotEl.getBoundingClientRect());
    const tgt = document.querySelector('.cmp:not(.is-sheet) .cmp-item .cmp-dot') || document.querySelector('.cmp .cmp-head h3');
    const t = tgt ? center(tgt.getBoundingClientRect()) : { x: p0.x, y: p0.y - 28 };
    const dx = t.x - p0.x, dy = t.y - p0.y;
    const lift = Math.min(70, Math.abs(dy) * 0.35 + 24);
    const pts = path({ x: 0, y: 0 }, { x: dx * 0.15, y: -lift }, { x: dx * 0.8, y: dy - lift * 0.5 }, { x: dx, y: dy }, 32);
    const last = pts.length - 1, GLIDE_MS = 780;
    setTimeout(() => { if (!failed) sfxLand(); }, GLIDE_MS - 40);
    glide = dotEl.animate(pts.map((p, i) => ({ translate: `${p.x.toFixed(1)}px ${p.y.toFixed(1)}px`, opacity: i === last ? 0 : 1 })), { duration: GLIDE_MS, easing: 'linear', fill: 'forwards' });
    glide.finished.then(() => dotEl.remove(), () => dotEl.remove());
  };
  collapse.finished.then(() => setTimeout(fly, 80), () => {});
  const land = (target) => {
    if (target !== false) return;
    failed = true; glide?.cancel();
    collapse.cancel(); for (const k of card.children) k.getAnimations().forEach((x) => x.cancel()); card.style.pointerEvents = '';
    dotEl.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: 'forwards' }).finished.then(() => dotEl.remove());
  };
  land.ready = collapse.finished.catch(() => {});
  return land;
}

// ⌘K and Settings preview: play the commit moment without committing anything.
export function previewCommit() {
  const main = document.querySelector('.main');
  const real = document.querySelector('.cm-card');
  const card = real || (() => {
    const c = document.createElement('section');
    c.className = 'cm-card fx-demo-card';
    c.innerHTML = '<header class="cm-head"><span class="cm-num mono">1</span><b>✨ Added a lovely new thing</b></header><p class="cm-why">preview, nothing is committed</p>';
    (main.querySelector('.controls') || main.firstElementChild).after(c);
    return c;
  })();
  card.scrollIntoView({ block: 'center', behavior: 'instant' });
  const land = commitFold(card);
  const banner = document.createElement('div');
  banner.className = 'cm-banner is-commit fx-demo';
  banner.innerHTML = '<i class="cm-dot" aria-hidden="true"></i><span>Committed <b>✨ Added a lovely new thing</b> <span class="mono muted">preview · nothing was committed</span></span>';
  card.classList.add('fx-hide');
  setTimeout(() => {
    (main.querySelector('.controls') || main.querySelector('.head')).after(banner);
    land(banner.querySelector('.cm-dot'));
  }, 280);
  setTimeout(() => {
    document.querySelectorAll('.fx-demo-card').forEach((x) => x.remove());
    if (real) { card.classList.remove('fx-hide'); card.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 420, easing: GLIDE }); }
  }, 1500);
  setTimeout(() => banner.animate([{ opacity: 1 }, { opacity: 0, transform: 'translateY(-4px)' }], { duration: 320, easing: 'ease-in', fill: 'forwards' }).finished.then(() => banner.remove()), 3600);
}

// Discard: the row slips away to the left and folds shut, then the list redraws.
export function discardOut(el) {
  sfxDiscard();
  if (!el || calm()) return Promise.resolve();
  const h = el.getBoundingClientRect().height;
  el.style.overflow = 'hidden';
  return el.animate([
    { transform: 'none', opacity: 1, height: h + 'px', filter: 'saturate(1)' },
    { transform: 'translateX(-14px)', opacity: 0.25, height: h + 'px', offset: 0.55, filter: 'saturate(0)' },
    { transform: 'translateX(-24px)', opacity: 0, height: '0px', paddingTop: '0px', paddingBottom: '0px', marginTop: '0px', marginBottom: '0px' },
  ], { duration: 340, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' }).finished.catch(() => {});
}

