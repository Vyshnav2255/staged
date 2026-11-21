// ⌘K: jump to a repo, a view, an action or a commit.
import { esc } from './ui.js';
import { exitFallbackMs } from './motion.js';

let wrap = null, items = [], sel = 0, getItems = null, returnFocus = null, shellWasInert = false;

export function initPalette(itemsFn) {
  getItems = itemsFn;
  addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); wrap ? close() : open(); }
  });
}

export function open() {
  if (wrap) return;
  returnFocus = document.activeElement;
  const shell = document.querySelector('.shell');
  shellWasInert = !!shell?.inert;
  wrap = document.createElement('div');
  wrap.className = 'pal-wrap';
  wrap.innerHTML = `<div class="pal" role="dialog" aria-modal="true" aria-label="Command bar">
    <input class="pal-input" type="search" role="combobox" aria-label="Search commands" aria-autocomplete="list" aria-expanded="true" aria-controls="palette-options" placeholder="Jump to a repo, view or commit…" autocomplete="off" spellcheck="false">
    <div class="pal-list scroll-fade" id="palette-options" role="listbox" aria-label="Command results"></div>
  </div>`;
  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('is-open'));
  const input = wrap.querySelector('input');
  wrap.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    // The search field is the palette's only tab stop; keep focus inside the modal.
    e.preventDefault();
    input.focus();
  });
  input.addEventListener('input', () => { sel = 0; render(input.value); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); paint(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); paint(); }
    else if (e.key === 'Enter') { e.preventDefault(); run(items[sel]); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
  wrap.querySelector('.pal-list').addEventListener('click', (e) => { const r = e.target.closest('[data-i]'); if (r) run(items[+r.dataset.i]); });
  wrap.querySelector('.pal-list').addEventListener('mousemove', (e) => { const r = e.target.closest('[data-i]'); if (r && +r.dataset.i !== sel) { sel = +r.dataset.i; paint(); } });
  render('');
  input.focus();
  if (shell) shell.inert = true;
}

function close() {
  if (!wrap) return;
  const w = wrap; wrap = null;
  const shell = document.querySelector('.shell');
  if (shell) shell.inert = shellWasInert;
  w.classList.remove('is-open');
  setTimeout(() => w.remove(), exitFallbackMs('moderate'));
  if (returnFocus?.isConnected && !returnFocus.closest('[inert]')) returnFocus.focus();
  returnFocus = null;
}

function score(text, q) {
  if (!q) return 1;
  const t = text.toLowerCase();
  const i = t.indexOf(q);
  if (i >= 0) return 100 - i;
  // loose: all chars in order
  let k = 0;
  for (const ch of t) if (ch === q[k]) k++;
  return k === q.length ? 10 : 0;
}

function render(q) {
  q = q.trim().toLowerCase();
  const all = getItems(q);
  const RANK = { 'Go to': 0, Repos: 1, Views: 2, Actions: 3, Commits: 4 };
  items = all.map((it, i) => ({ it, i, s: score(it.label + ' ' + (it.hint || ''), q) })).filter((x) => x.s > 0)
    .sort((a, b) => (b.it.boost || 0) - (a.it.boost || 0) || (RANK[a.it.group] ?? 9) - (RANK[b.it.group] ?? 9) || (a.it.group === 'Commits' ? a.i - b.i : b.s - a.s))
    .slice(0, 50).map((x) => x.it);
  paint();
}

function paint() {
  const list = wrap.querySelector('.pal-list');
  let lastGroup = '';
  list.innerHTML = items.length ? items.map((it, i) => {
    const head = it.group !== lastGroup ? `<div class="pal-group mono">${esc(it.group)}</div>` : '';
    lastGroup = it.group;
    return `${head}<div id="palette-option-${i}" class="pal-item ${i === sel ? 'is-sel' : ''}" data-i="${i}" role="option" aria-selected="${i === sel}">
      <span class="pal-label">${esc(it.label)}</span>${it.hint ? `<span class="pal-hint mono">${esc(it.hint)}</span>` : ''}</div>`;
  }).join('') : '<div class="pal-empty muted">Nothing matches</div>';
  const input = wrap.querySelector('.pal-input');
  if (items.length) input.setAttribute('aria-activedescendant', `palette-option-${sel}`);
  else input.removeAttribute('aria-activedescendant');
  list.querySelector('.is-sel')?.scrollIntoView({ block: 'nearest' });
}

function run(it) {
  if (!it) return;
  close();
  it.run();
}
