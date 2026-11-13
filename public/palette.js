// ⌘K: jump to a repo, a view, an action or a commit.
import { esc } from './ui.js';
import { icon } from './icons.js';

let wrap = null, items = [], sel = 0, getItems = null;

export function initPalette(itemsFn) {
  getItems = itemsFn;
  addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); wrap ? close() : open(); }
  });
}

export function open() {
  if (wrap) return;
  wrap = document.createElement('div');
  wrap.className = 'pal-wrap';
  wrap.innerHTML = `<div class="pal" role="dialog" aria-label="Command bar">
    <input class="pal-input" placeholder="Jump to a repo, view or commit…" autocomplete="off" spellcheck="false">
    <div class="pal-list" role="listbox"></div>
    <div class="pal-foot mono muted"><span>${icon('ArrowUp01', 12)}${icon('ArrowDown01', 12)} move</span><span>${icon('ArrowMoveDownLeft', 12)} open</span><span>esc close</span></div>
  </div>`;
  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('is-open'));
  const input = wrap.querySelector('input');
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
}

function close() {
  if (!wrap) return;
  const w = wrap; wrap = null;
  w.classList.remove('is-open');
  setTimeout(() => w.remove(), 150);
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
    return `${head}<div class="pal-item ${i === sel ? 'is-sel' : ''}" data-i="${i}" role="option" aria-selected="${i === sel}">
      <span class="pal-label">${esc(it.label)}</span>${it.hint ? `<span class="pal-hint mono">${esc(it.hint)}</span>` : ''}</div>`;
  }).join('') : '<div class="pal-empty muted">Nothing matches</div>';
  list.querySelector('.is-sel')?.scrollIntoView({ block: 'nearest' });
}

function run(it) {
  if (!it) return;
  close();
  it.run();
}
