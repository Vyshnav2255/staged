// Little moments, kept smooth: only transform, opacity and clip-path move, on springs.
// Commit (subtle): the card closes into a dot, the dot glides to the banner and lands; the cards
// below slide up into the gap instead of jumping.
// Push: your commits lift off the button one by one, gather at the remote and pop.
import { sfxFold, sfxLand, sfxLift, sfxCatch, sfxBurst, sfxDiscard } from './sfx.js';
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const GLIDE = 'cubic-bezier(.22,1,.36,1)';

// Real spring curves where the browser has linear() easing, a close cubic otherwise.
function spring(zeta, n = 40) {
  const w = 4.6 / zeta, wd = w * Math.sqrt(1 - zeta * zeta);
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = i === n ? 1 : 1 - Math.exp(-zeta * w * t) * (Math.cos(wd * t) + (zeta * w / wd) * Math.sin(wd * t));
    pts.push(+x.toFixed(4));
  }
  return `linear(${pts.join(', ')})`;
}
const hasLinear = typeof CSS !== 'undefined' && CSS.supports?.('animation-timing-function', 'linear(0, 1)');
const POP = hasLinear ? spring(0.55) : 'cubic-bezier(.3,1.5,.5,1)';
const SOFT = hasLinear ? spring(0.8) : GLIDE;

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
export function commitFold(card) {
  if (!card) return () => {};
  if (calm()) return (t) => { if (t !== false) sfxLand(); };
  const r = card.getBoundingClientRect();
  const tops = new Map([...document.querySelectorAll('.cm-card[data-group]')].filter((c) => c !== card).map((c) => [c.dataset.group, c.getBoundingClientRect().top]));
  const ghost = card.cloneNode(true);
  ghost.classList.add('fx-ghost');
  ghost.removeAttribute('data-group');
  ghost.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
  ghost.setAttribute('aria-hidden', 'true');
  Object.assign(ghost.style, { position: 'fixed', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px', margin: 0, zIndex: 40, pointerEvents: 'none' });
  const tint = document.createElement('i');
  tint.className = 'fx-tint';
  ghost.appendChild(tint);
  document.body.appendChild(ghost);
  // While git works, the card sinks in a touch, like a key being pressed.
  ghost.animate([{ transform: 'none' }, { transform: 'scale(.99)' }], { duration: 260, easing: SOFT, fill: 'forwards' });

  return (target) => {
    // Nothing was committed (an error): the ghost just melts back into the card.
    if (target === false) { ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: 'forwards' }).finished.then(() => ghost.remove()); return; }
    slideIntoPlace(tops);
    sfxFold();
    setTimeout(sfxLand, 790);
    const from = center(r);
    const t = target?.isConnected ? center(target.getBoundingClientRect()) : { x: from.x, y: from.y - 28 };
    const dot = 10, ix = (r.width - dot) / 2, iy = (r.height - dot) / 2;
    // 1. Close: the card shrinks to a dot at its middle, taking on the commit colour.
    ghost.animate([
      { clipPath: 'inset(0px 0px 0px 0px round 12px)', transform: 'scale(.99)' },
      { clipPath: `inset(${iy * 0.7}px ${ix * 0.55}px ${iy * 0.7}px ${ix * 0.55}px round 14px)`, transform: 'scale(.99)', offset: 0.45 },
      { clipPath: `inset(${iy}px ${ix}px ${iy}px ${ix}px round ${dot}px)`, transform: 'scale(1)' },
    ], { duration: 420, easing: 'cubic-bezier(.65,0,.35,1)', fill: 'forwards' });
    tint.animate([{ opacity: 0 }, { opacity: 0, offset: 0.35 }, { opacity: 1 }], { duration: 420, easing: 'ease-in', fill: 'forwards' });
    // 2. Glide: the dot travels on a gentle arc to where the banner's dot lands.
    const dx = t.x - from.x, dy = t.y - from.y;
    const lift = Math.min(60, Math.abs(dy) * 0.35 + 18);
    const pts = path({ x: 0, y: 0 }, { x: dx * 0.1, y: -lift }, { x: dx * 0.75, y: dy - lift * 0.6 }, { x: dx, y: dy }, 18);
    const last = pts.length - 1;
    const glide = ghost.animate(pts.map((p, i) => ({
      translate: `${p.x.toFixed(1)}px ${p.y.toFixed(1)}px`,
      opacity: target ? (i === last ? 0 : 1) : 1 - i / last,
    })), { duration: 460, delay: 360, easing: 'linear', fill: 'forwards' });
    glide.finished.then(() => ghost.remove(), () => ghost.remove());
  };
}

// The cards that stay glide to their new places instead of jumping.
function slideIntoPlace(tops) {
  let i = 0;
  for (const c of document.querySelectorAll('.cm-card[data-group]')) {
    const was = tops.get(c.dataset.group);
    if (was == null) continue;
    const dy = was - c.getBoundingClientRect().top;
    if (Math.abs(dy) < 1 || Math.abs(dy) > innerHeight * 1.5) continue;
    c.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 640, delay: 140 + i++ * 30, easing: SOFT, fill: 'backwards' });
  }
}

// Commits lift off the button, gather at the remote and pop.
export function pushLaunch(from, count = 1) {
  if (!from) return Promise.resolve();
  if (calm()) { sfxBurst(); return Promise.resolve(); }
  const r = from.getBoundingClientRect();
  const n = Math.max(1, Math.min(count, 6));
  const p0 = center(r);
  // The commits fly to the remote: the "open online" icon in the header when it's showing, else straight up.
  const gh = document.querySelector('#ghLink');
  const ghR = gh && !gh.hidden && gh.offsetParent ? gh.getBoundingClientRect() : null;
  const near = !!ghR;
  const rise = Math.min(150, p0.y - 30);
  const end = near ? center(ghR) : { x: p0.x, y: p0.y - Math.max(40, rise) };
  const climb = near ? Math.max(0, p0.y - end.y) : 0;
  const over = near ? Math.min(56, end.y - 10) : 0;

  const layer = document.createElement('div');
  layer.className = 'fx-layer';
  document.body.appendChild(layer);
  from.animate([{ transform: 'none' }, { transform: 'translateY(1px) scale(.97)', offset: 0.3 }, { transform: 'none' }], { duration: 420, easing: SOFT });

  const cols = ['var(--logo-1)', 'var(--logo-2)', 'var(--logo-box)'];
  const orb = document.createElement('i');
  orb.className = 'fx-orb';
  orb.style.left = end.x + 'px'; orb.style.top = end.y + 'px';
  layer.appendChild(orb);
  let caught = 0;
  const catchOne = () => {
    sfxCatch(caught);
    caught++;
    const s = 0.55 + caught * (0.45 / n);
    orb.animate([{ transform: `translate(-50%,-50%) scale(${s * 0.8})`, opacity: 1 }, { transform: `translate(-50%,-50%) scale(${s * 1.15})`, opacity: 1, offset: 0.4 }, { transform: `translate(-50%,-50%) scale(${s})`, opacity: 1 }], { duration: 320, easing: POP, fill: 'forwards' });
    if (near) gh.animate([{ transform: 'none' }, { transform: 'translateY(-1.5px) scale(1.06)', offset: 0.35 }, { transform: 'none' }], { duration: 360, easing: SOFT });
  };

  const flights = [];
  for (let i = 0; i < n; i++) {
    const side = (i % 2 ? 1 : -1) * (10 + (i >> 1) * 8);
    const c1 = near ? { x: p0.x + side * 0.8, y: p0.y - climb * 0.55 - over * 0.6 } : { x: p0.x + side, y: p0.y - rise * 0.35 };
    const c2 = near ? { x: end.x + side * 0.4, y: end.y - over } : { x: end.x - side * 0.6, y: end.y + rise * 0.3 };
    const pts = path(p0, c1, c2, end, 20);
    const frames = pts.map((p, k) => {
      const t = k / (pts.length - 1);
      const s = t < 0.12 ? 0.35 + (t / 0.12) * 0.75 : t < 0.25 ? 1.1 - ((t - 0.12) / 0.13) * 0.1 : 1 - Math.max(0, t - 0.8) * 2;
      return { transform: `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) translate(-50%,-50%) scale(${s.toFixed(3)})`, opacity: t < 0.08 ? t / 0.08 : 1 };
    });
    const timing = { duration: 720, delay: 120 + i * 95, easing: 'linear', fill: 'forwards' };
    setTimeout(() => sfxLift(i, n), timing.delay + 20);
    for (const [cls, extra] of [['fx-trail', 50], ['fx-dot', 0]]) {
      const d = document.createElement('i');
      d.className = cls;
      d.style.background = cols[i % 3];
      layer.appendChild(d);
      const a = d.animate(frames, { ...timing, delay: timing.delay + extra });
      if (cls === 'fx-dot') flights.push(a.finished.then(() => { d.remove(); catchOne(); }));
      else a.finished.then(() => d.remove(), () => d.remove());
    }
  }
  return Promise.all(flights).then(() => new Promise((done) => setTimeout(() => {
    burst(layer, orb, end.x, end.y, near ? 0.75 : 1);
    sfxBurst();
    done();
    setTimeout(() => layer.remove(), 1000);
  }, 120)), () => layer.remove());
}

function burst(layer, orb, x, y, size = 1) {
  orb.animate([{ transform: 'translate(-50%,-50%) scale(1)', opacity: 1 }, { transform: 'translate(-50%,-50%) scale(1.5)', opacity: 0 }], { duration: 380, easing: GLIDE, fill: 'forwards' });
  const glow = document.createElement('i');
  glow.className = 'fx-glow';
  glow.style.left = x + 'px'; glow.style.top = y + 'px';
  layer.appendChild(glow);
  glow.animate([{ transform: 'translate(-50%,-50%) scale(.3)', opacity: 0.55 }, { transform: `translate(-50%,-50%) scale(${1.4 * size})`, opacity: 0 }], { duration: 700, easing: GLIDE, fill: 'forwards' });
  const ring = document.createElement('i');
  ring.className = 'fx-ring';
  ring.style.left = x + 'px'; ring.style.top = y + 'px';
  layer.appendChild(ring);
  ring.animate([{ transform: 'translate(-50%,-50%) scale(.3)', opacity: 0.9 }, { transform: `translate(-50%,-50%) scale(${1.7 * size})`, opacity: 0 }], { duration: 640, easing: GLIDE, fill: 'forwards' });
  const cols = ['var(--logo-1)', 'var(--logo-2)', 'var(--logo-box)'];
  const N = 14;
  for (let i = 0; i < N; i++) {
    const p = document.createElement('i');
    p.className = 'fx-spark';
    p.style.left = x + 'px'; p.style.top = y + 'px';
    p.style.background = cols[i % 3];
    layer.appendChild(p);
    const a = (i / N) * Math.PI * 2 + (i % 2) * 0.22;
    const dist = (22 + (i % 3) * 9) * size;
    // Out fast, then a little gravity as they fade.
    const frames = [0, 0.15, 0.35, 0.6, 1].map((t, k, all) => {
      const out = 1 - Math.pow(1 - t, 3);
      const fx = Math.cos(a) * dist * out, fy = Math.sin(a) * dist * out + 14 * t * t * size;
      return { transform: `translate(-50%,-50%) translate(${fx.toFixed(1)}px, ${fy.toFixed(1)}px) scale(${(1 - t * 0.7).toFixed(2)})`, opacity: k === all.length - 1 ? 0 : 1 - t * 0.4 };
    });
    p.animate(frames, { duration: 760 + (i % 4) * 40, delay: (i % 3) * 18, easing: 'linear', fill: 'forwards' });
  }
}

// The push button: arrow keeps lifting while it works, then turns into a tick.
export function pushButtonDone(btn, html, ms = 1400) {
  if (!btn) return;
  btn.classList.remove('is-pushing');
  btn.classList.add('is-pushed');
  btn.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.04)', offset: 0.35 }, { transform: 'scale(1)' }], { duration: 420, easing: POP });
  setTimeout(() => {
    btn.classList.remove('is-pushed');
    if (html != null) { btn.innerHTML = html; btn.animate([{ opacity: 0.4 }, { opacity: 1 }], { duration: 220, easing: 'ease-out' }); }
  }, ms);
}

// ⌘K previews: play the moments without committing or pushing anything.
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

export function previewPush() {
  const btn = [...document.querySelectorAll('#pushBtn, [data-pushnow]')].find((b) => b.offsetParent);
  if (btn) {
    btn.classList.add('is-pushing');
    setTimeout(() => pushLaunch(btn, 4).then(() => pushButtonDone(btn)), 400);
    return;
  }
  // No push button on this screen: launch from the middle of the page so the dots have room to rise.
  const spot = document.createElement('i');
  const m = document.querySelector('.main').getBoundingClientRect();
  Object.assign(spot.style, { position: 'fixed', left: m.left + m.width / 2 - 1 + 'px', top: innerHeight * 0.55 + 'px', width: '2px', height: '2px' });
  document.body.appendChild(spot);
  pushLaunch(spot, 4).then(() => spot.remove(), () => spot.remove());
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

