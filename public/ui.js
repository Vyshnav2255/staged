import { icon } from './icons.js';
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
export function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => (t.hidden = true), 2200);
}

export function copy(text, msg = 'Copied') {
  return navigator.clipboard.writeText(text).then(() => toast(msg), () => toast("Couldn't copy"));
}

// Modal: returns { el, close }. `wide` for drawers with more content.
export function modal({ title, body, actions = '', wide = false, side = false, onClose }) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap' + (side ? ' is-side' : '');
  wrap.innerHTML = `<div class="modal ${wide ? 'is-wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <header class="modal-head"><h3>${esc(title)}</h3><button class="icon-btn modal-x" aria-label="Close">${icon('Cancel01', 16)}</button></header>
    <div class="modal-body">${body}</div>
    ${actions ? `<footer class="modal-foot">${actions}</footer>` : ''}
  </div>`;
  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('is-open'));
  const prev = document.activeElement;
  const close = () => {
    wrap.classList.remove('is-open');
    document.removeEventListener('keydown', onKey, true);
    setTimeout(() => wrap.remove(), 180);
    prev && prev.focus && prev.focus();
    onClose && onClose();
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
  wrap.querySelector('.modal-x').addEventListener('click', close);
  setTimeout(() => (wrap.querySelector('[autofocus]') || wrap.querySelector('input, textarea, button.btn-primary'))?.focus(), 30);
  return { el: wrap, close };
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
export const HOSTS = {
  github: { name: 'GitHub', icon: 'Github', commit: '/commit/' },
  gitlab: { name: 'GitLab', icon: 'Gitlab', commit: '/-/commit/' },
  bitbucket: { name: 'Bitbucket', icon: 'Link01', commit: '/commits/' },
  git: { name: 'your remote', icon: 'Link01', commit: '/commit/' },
};
export const hostOf = (r) => HOSTS[r?.provider] || HOSTS.git;
export const commitUrl = (r, sha) => (r?.remote ? r.remote + hostOf(r).commit + sha : '');
