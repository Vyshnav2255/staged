import { icon } from './icons.js';
import { exitFallbackMs, MS } from './motion.js';
// Small shared helpers: escaping, numbers, dates, modal, toast, API calls.
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const compact = (n) => (n >= 10000 ? (n / 1000).toFixed(0) + 'k' : n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n));
export const bytes = (b) => (b >= 1048576 ? (b / 1048576).toFixed(b >= 10485760 ? 0 : 1) + ' MB' : b >= 1024 ? Math.round(b / 1024) + ' KB' : b + ' B');
export const DAY = 86400000;
export function ago(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 86400 * 30) return Math.floor(s / 86400) + 'd ago';
  if (s < 86400 * 365) return Math.floor(s / 86400 / 30) + 'mo ago';
  return (s / 86400 / 365).toFixed(1).replace(/\.0$/, '') + 'y ago';
}
export const dShort = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
export const dLong = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
export const dMonth = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' });

export async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json', 'x-changes': '1' }, body: JSON.stringify(body) } : {});
  const data = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok || data.error) throw new Error(data.error || res.statusText);
  return data;
}

let toastT;
// A short note at the bottom. With an action (like Undo) it stays a little longer and has a button.
export function toast(msg, { action, onAction, ms } = {}) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.toggle('has-action', !!action);
  if (action) {
    const b = document.createElement('button');
    b.className = 'toast-btn'; b.type = 'button'; b.textContent = action;
    b.addEventListener('click', () => { hide(); onAction?.(); }, { once: true });
    t.append(b);
  }
  t.hidden = false;
  t.classList.remove('is-out');
  clearTimeout(toastT);
  const hide = () => { clearTimeout(toastT); t.classList.add('is-out'); toastT = setTimeout(() => (t.hidden = true), MS.close + 50); };
  toastT = setTimeout(hide, ms || (action ? 6000 : 2200));
}

export function copy(text, msg = 'Copied') {
  return navigator.clipboard.writeText(text).then(() => toast(msg), () => toast("Couldn't copy"));
}

// Modal: returns { el, close }. `wide` for drawers with more content.
// A side panel is part of the app, never a popup: it docks on the right like the cart, slides in,
// pushes the page over instead of covering it, and leaves the page usable (no backdrop). Only one
// docks at a time; opening another replaces it. Esc or its close button puts it away.
let docked = null;
export const closeDock = () => docked?.close();
// A docked panel can belong to a repo. When you pick another repo it either follows you
// (follow(repo) reopens it for the new one) or puts itself away.
export function syncDock(repo) {
  const d = docked;
  if (!d || !d.repo || d.repo === repo) return;
  if (d.follow && repo && repo !== 'all') d.follow(repo); else d.close();
}
export function modal({ title, body, actions = '', wide = false, side = false, onClose, repo = null, follow = null }) {
  if (side) docked?.close(true);
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap' + (side ? ' is-side is-dock' : '');
  wrap.innerHTML = `<div class="modal ${wide ? 'is-wide' : ''}" role="dialog" ${side ? '' : 'aria-modal="true"'} aria-label="${esc(title)}">
    <header class="modal-head"><h3>${esc(title)}</h3><button class="icon-btn modal-x" aria-label="Close">${icon('Cancel01', 16)}</button></header>
    <div class="modal-body scroll-fade">${body}</div>
    ${actions ? `<footer class="modal-foot">${actions}</footer>` : ''}
  </div>`;
  document.body.appendChild(wrap);
  if (side) {
    requestAnimationFrame(() => {
      document.body.style.setProperty('--dock-w', wrap.querySelector('.modal').offsetWidth + 'px');
      document.body.classList.add('has-dock');
    });
  }
  requestAnimationFrame(() => wrap.classList.add('is-open'));
  const prev = document.activeElement;
  let gone = false;
  // swap: another panel is taking this one's place, so the page stays pushed over
  const close = (swap = false) => {
    if (gone) return; gone = true;
    wrap.classList.add('is-closing');
    wrap.classList.remove('is-open');
    document.removeEventListener('keydown', onKey, true);
    setTimeout(() => wrap.remove(), side ? MS.close + 80 : exitFallbackMs('slow'));
    if (side) { if (docked === handle) docked = null; if (!swap) document.body.classList.remove('has-dock'); }
    if (!swap && prev && prev.focus && prev.isConnected) prev.focus();
    onClose && onClose();
  };
  const handle = { el: wrap, repo, follow, close: (swap) => close(swap === true) };
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    // a docked panel only takes Esc when you're in it or nothing else is focused
    if (side && document.activeElement && document.activeElement !== document.body && !wrap.contains(document.activeElement)) return;
    e.stopPropagation(); close();
  };
  document.addEventListener('keydown', onKey, true);
  if (!side) wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
  wrap.querySelector('.modal-x').addEventListener('click', () => close());
  setTimeout(() => (wrap.querySelector('[autofocus]') || wrap.querySelector('input, textarea, button.btn-primary'))?.focus(), 30);
  if (side) docked = handle;
  return handle;
}

export function confirmDialog({ title, text, ok = 'Continue', danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({
      title,
      body: `<p class="modal-text">${text}</p>`,
      actions: `<button class="text-btn bordered" data-no>Cancel</button><button class="btn-primary ${danger ? 'is-danger' : ''}" data-yes>${esc(ok)}</button>`,
      onClose: () => { if (!done) resolve(false); },
    });
    m.el.querySelector('[data-no]').onclick = () => m.close();
    m.el.querySelector('[data-yes]').onclick = () => { done = true; resolve(true); m.close(); };
  });
}

export const TYPES = ['feature', 'ui', 'fix', 'perf', 'refactor', 'other'];
export const TYPE_LABEL = { feature: 'Feature', ui: 'Design', fix: 'Fix', perf: 'Perf', refactor: 'Chore', other: 'Other' };
export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// Where a repo lives: GitHub, GitLab, Bitbucket or another git host.
const HOSTS = {
  github: { name: 'GitHub', icon: 'Github', commit: '/commit/' },
  gitlab: { name: 'GitLab', icon: 'Gitlab', commit: '/-/commit/' },
  bitbucket: { name: 'Bitbucket', icon: 'Link01', commit: '/commits/' },
  git: { name: 'your remote', icon: 'Link01', commit: '/commit/' },
};
export const hostOf = (r) => HOSTS[r?.provider] || HOSTS.git;
export const commitUrl = (r, sha) => (r?.remote ? r.remote + hostOf(r).commit + sha : '');
