import { icon } from './icons.js';
import { modal, confirmDialog, toast } from './ui.js';
const LEAD = /^\s*(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\uFE0F|\u200D)+\s*/u;
import { celebrate } from './release.js';

// Commit workspace: uncommitted files, grouped into suggested commits.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const compact = (n) => (n >= 10000 ? (n / 1000).toFixed(0) + 'k' : n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n));
const STATUS = { A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', U: 'Conflict' };
const GITMOJI = [
  ['✨', 'feat', 'New feature'], ['🎉', 'feat', 'Big milestone'], ['💄', 'style', 'UI and styles'], ['💫', 'style', 'Animations'],
  ['🎨', 'style', 'Structure and format'], ['🍱', 'chore', 'Assets'], ['🐛', 'fix', 'Bug fix'], ['🚑️', 'fix', 'Hotfix'],
  ['✏️', 'docs', 'Typos'], ['📝', 'docs', 'Docs and content'], ['⚡️', 'perf', 'Performance'], ['♻️', 'refactor', 'Refactor'],
  ['🔥', 'refactor', 'Remove code or files'], ['🚚', 'refactor', 'Move or rename'], ['🔧', 'chore', 'Config'], ['📦️', 'build', 'Packages'],
  ['⬆️', 'build', 'Upgrade dependencies'], ['🚸', 'feat', 'Usability'], ['♿️', 'feat', 'Accessibility'], ['📱', 'style', 'Responsive'],
  ['🔍️', 'feat', 'SEO'], ['🌐', 'feat', 'Translations'], ['💬', 'docs', 'Text and copy'], ['🙈', 'chore', '.gitignore'],
  ['👷', 'ci', 'CI'], ['✅', 'test', 'Tests'], ['🔒️', 'fix', 'Security'], ['⏪️', 'revert', 'Revert'],
  ['🔀', 'chore', 'Merge'], ['🧑‍💻', 'chore', 'Developer experience'], ['🥚', 'feat', 'Easter egg'], ['🚀', 'chore', 'Deploy'],
];
const TYPE_EMOJI = { feat: '✨', fix: '🐛', style: '💄', perf: '⚡️', refactor: '♻️', docs: '📝', chore: '🔧', build: '📦', ci: '👷', test: '✅' };

let store = {};
try { store = JSON.parse(localStorage.getItem('changes.commit') || '{}'); } catch {}
const save = () => { try { localStorage.setItem('changes.commit', JSON.stringify(store)); } catch {} };

const cs = {
  repo: null, data: null, groups: [], files: new Map(), off: new Set(), open: new Set(), bodyOpen: new Set(),
  busy: null, error: '', banner: null, format: store.format || 'gitmoji', loading: false, hunksOff: new Map(), hunkOpen: new Set(),
};
let host = null, ctx = null;

const api = async (path, body) => {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json', 'x-changes': '1' }, body: JSON.stringify(body) } : {});
  const data = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok || data.error) throw new Error(data.error || res.statusText);
  return data;
};

export function subjectFor(g, format = cs.format) {
  if (g.edited != null) return format === 'conventional' ? g.edited : `${g.emoji || '✨'} ${g.edited.replace(LEAD, '')}`;
  const scope = g.scope ? `(${g.scope})` : '';
  const emoji = g.emoji || TYPE_EMOJI[g.type] || '✨';
  if (format === 'conventional') return `${g.type}${scope}: ${g.conventional}`;
  if (format === 'both') return `${emoji} ${g.type}${scope}: ${g.conventional}`;
  return `${emoji} ${g.gitmoji}`;
}
const messageFor = (g) => {
  const subj = subjectFor(g).trim();
  const body = (g.body || '').trim();
  return body ? `${subj}\n\n${body}` : subj;
};

function adoptGroups(groups) {
  cs.groups = groups.map((g) => ({ ...g, body: g.source === 'claude' ? g.body : '', edited: null }));
}

// Keep the user's arrangement when files change underneath us.
function mergeFiles(newFiles) {
  const paths = new Set(newFiles.map((f) => f.path));
  for (const g of cs.groups) g.files = g.files.filter((p) => paths.has(p));
  cs.groups = cs.groups.filter((g) => g.files.length);
  const placed = new Set(cs.groups.flatMap((g) => g.files));
  const fresh = newFiles.map((f) => f.path).filter((p) => !placed.has(p));
  if (fresh.length) {
    let g = cs.groups.find((x) => x.id === 'new');
    if (!g) { g = { id: 'new', title: 'New changes', why: 'appeared since you opened this', type: 'chore', scope: '', emoji: '🔧', conventional: 'update files', gitmoji: 'Updated files', body: '', files: [], edited: null }; cs.groups.push(g); }
    g.files.push(...fresh);
  }
  for (const p of [...cs.off]) if (!paths.has(p)) cs.off.delete(p);
  // forget chunk picks whose chunks no longer exist
  for (const [p, set] of cs.hunksOff) {
    const f = newFiles.find((x) => x.path === p);
    const ids = new Set((f?.hunks || []).map((h) => h.id));
    for (const id of [...set]) if (!ids.has(id)) set.delete(id);
    if (!set.size) cs.hunksOff.delete(p);
  }
}

export async function loadChanges(repo, { keep } = {}) {
  const same = cs.repo === repo;
  cs.repo = repo;
  cs.loading = !same || !cs.data;
  if (!same) { cs.data = null; cs.groups = []; cs.off.clear(); cs.open.clear(); cs.bodyOpen.clear(); cs.hunksOff.clear(); cs.hunkOpen.clear(); cs.banner = null; cs.error = ''; }
  draw();
  try {
    const data = await api(`/api/changes?repo=${encodeURIComponent(repo)}`);
    if (cs.repo !== repo) return;
    cs.data = data;
    cs.files = new Map(data.files.map((f) => [f.path, f]));
    if (keep && cs.groups.length) mergeFiles(data.files);
    else adoptGroups(data.groups);
    cs.error = '';
  } catch (e) {
    cs.error = e.message;
  }
  cs.loading = false;
  draw();
}

export function mountCommit(el, context) {
  host = el; ctx = context;
  if (!host.dataset.bound) { host.addEventListener('click', onClick); host.addEventListener('input', onInput); host.addEventListener('change', onChange); host.dataset.bound = '1'; }
  if (ctx.repo === 'all') return drawAll();
  if (cs.repo !== ctx.repo || !cs.data) loadChanges(ctx.repo);
  else draw();
}
export function refreshCommit() {
  if (host && ctx && ctx.repo !== 'all' && cs.repo === ctx.repo && !cs.busy) loadChanges(ctx.repo, { keep: true });
}

// ---------- drawing ----------
function drawAll() {
  const dirty = ctx.repos.filter((r) => r.dirty).sort((a, b) => b.dirty - a.dirty);
  host.innerHTML = dirty.length
    ? `<div class="cm-repos">${dirty.map((r) => `<button class="cm-repo" data-pick="${esc(r.name)}">
        <span class="feat-name">${esc(r.name)}</span><span class="mono muted">${r.dirty} uncommitted file${r.dirty > 1 ? 's' : ''}</span>${icon('ArrowRight01', 14)}
      </button>`).join('')}</div>`
    : `<div class="empty"><h3>Everything is committed</h3><p>None of your repos has uncommitted changes.</p></div>`;
}

function fileRow(p, g) {
  const f = cs.files.get(p);
  if (!f) return '';
  const dirn = p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '';
  const base = p.slice(dirn.length);
  const on = !cs.off.has(p);
  const open = cs.open.has(p);
  const hk = f.hunks || [];
  const offH = cs.hunksOff.get(p) || new Set();
  const hOpen = cs.hunkOpen.has(p);
  const warn = (f.warnings || []);
  const others = cs.groups.filter((x) => x !== g);
  return `<div class="cm-file ${on ? '' : 'is-off'}">
    <label class="cm-check" title="${on ? 'Leave out of this commit' : 'Include in this commit'}"><input type="checkbox" data-file="${esc(p)}" ${on ? 'checked' : ''}><span></span></label>
    <span class="cm-status s-${f.status}" title="${STATUS[f.status] || f.status}${f.untracked ? ' (new file)' : ''}">${f.status}</span>
    <button class="cm-path" data-diff="${esc(p)}" aria-expanded="${open}" title="${esc(f.from ? `${f.from} → ${p}` : p)}"><span class="dir">${esc(dirn)}</span>${esc(base)}</button>
    <span class="cm-extra">
      ${warn.map((w) => `<span class="chip ${w.level === 'high' ? 'is-bad' : w.level === 'mid' ? 'is-warn' : ''}" title="${esc(w.text)}">${icon('Alert02', 12)}${esc(w.text)}</span>`).join('')}
      ${hk.length ? `<button class="chip is-btn ${offH.size ? 'is-on' : ''}" data-chunks="${esc(p)}" aria-expanded="${hOpen}" title="Pick which chunks of this file go in">${offH.size ? `${hk.length - offH.size} of ${hk.length} chunks` : `${hk.length} chunks`}</button>` : ''}
      <span class="lines mono">${f.binary ? '<span class="muted">binary</span>' : `<span class="a">+${compact(f.add)}</span> <span class="d">−${compact(f.del)}</span>`}</span>
    </span>
    <span class="cm-move-wrap"><select class="cm-move" data-move="${esc(p)}" aria-label="Move to another commit">
      <option value="">Move to…</option>
      ${others.map((o) => `<option value="${esc(o.id)}">${esc(o.title)}</option>`).join('')}
      <option value="__new">New commit</option>
    </select></span>
  </div>
  ${hOpen && hk.length ? chunkView(f, offH) : ''}
  ${open && !hOpen ? diffView(f) : ''}`;
}

function chunkView(f, offH) {
  return `<div class="cm-chunks">${f.hunks.map((h, i) => {
    const on = !offH.has(h.id);
    const lines = h.lines.slice(0, 24).map((l) => `<span class="${l.startsWith('+') ? 'a' : l.startsWith('-') ? 'd' : ''}">${esc(l) || ' '}</span>`).join('\n');
    return `<div class="cm-chunk ${on ? '' : 'is-off'}">
      <label class="cm-chunk-head"><span class="cm-check"><input type="checkbox" data-hunk="${esc(f.path)}" data-hid="${h.id}" ${on ? 'checked' : ''}><span></span></span>
        <span class="mono">Chunk ${i + 1}</span><span class="mono muted">${esc(h.head.replace(/^@@[^@]*@@\s?/, '') || 'line ' + (h.head.match(/\+(\d+)/) || [])[1])}</span>
        <span class="lines mono"><span class="a">+${h.add}</span> <span class="d">−${h.del}</span></span></label>
      <pre class="cm-diff mono">${lines}${h.lines.length > 24 ? `\n<span class="muted">… ${h.lines.length - 24} more lines</span>` : ''}</pre>
    </div>`;
  }).join('')}</div>`;
}

function diffView(f) {
  if (f.binary) return `<div class="cm-diff muted">Binary file${f.bytes ? ` · ${compact(Math.round(f.bytes / 1024))} KB` : ''}</div>`;
  if (!f.diff) return `<div class="cm-diff muted">No text changes</div>`;
  const lines = f.diff.split('\n').slice(0, 400).map((l) => {
    const cls = l.startsWith('@@') ? 'h' : l.startsWith('+') ? 'a' : l.startsWith('-') ? 'd' : '';
    return `<span class="${cls}">${esc(l) || ' '}</span>`;
  }).join('\n');
  return `<pre class="cm-diff mono">${lines}</pre>`;
}

function card(g, i) {
  const files = g.files.filter((p) => cs.files.has(p));
  const picked = files.filter((p) => !cs.off.has(p));
  const add = picked.reduce((s, p) => s + (cs.files.get(p)?.add || 0), 0);
  const del = picked.reduce((s, p) => s + (cs.files.get(p)?.del || 0), 0);
  const busy = cs.busy === g.id;
  const subj = subjectFor(g);
  const highs = picked.flatMap((p) => (cs.files.get(p)?.warnings || []).filter((w) => w.level === 'high').map((w) => `${p.split('/').pop()} ${w.text}`));
  const long = subj.length > 72;
  const bodyOpen = cs.bodyOpen.has(g.id) || (g.body || '').trim();
  return `<section class="cm-card" data-group="${esc(g.id)}">
    <header class="cm-head">
      <span class="cm-num mono">${i + 1}</span>
      <input class="cm-title" data-title="${esc(g.id)}" value="${esc(g.title)}" aria-label="Commit name" spellcheck="false">
      <span class="cm-meta mono">${picked.length}/${files.length} files · <span class="a">+${compact(add)}</span> <span class="d">−${compact(del)}</span></span>
      ${g.source === 'claude' ? '<span class="cm-badge mono">Claude</span>' : ''}
    </header>
    ${g.why ? `<p class="cm-why">${esc(g.why)}</p>` : ''}
    ${highs.length ? `<div class="cm-alert">${icon('Alert02', 14)}<span>Heads up: ${esc(highs.slice(0, 2).join('; '))}${highs.length > 2 ? ` and ${highs.length - 2} more` : ''}.</span></div>` : ''}
    <div class="cm-msg">
      <div class="cm-subject ${long ? 'is-long' : ''} ${cs.format === 'conventional' ? '' : 'has-emoji'}">
        ${cs.format === 'conventional' ? '' : `<button class="cm-emoji" data-emoji="${esc(g.id)}" title="Pick a gitmoji">${esc(g.emoji || '✨')}</button>`}
        <input data-subject="${esc(g.id)}" value="${esc(cs.format === 'conventional' ? subj : subj.replace(LEAD, ''))}" spellcheck="true" aria-label="Commit message">
        <span class="cm-count mono" title="Keep the first line under 72 characters">${subj.length}</span>
      </div>
      ${bodyOpen ? `<textarea data-body="${esc(g.id)}" rows="3" placeholder="Optional description: what changed and why">${esc(g.body || '')}</textarea>` : ''}
      <div class="cm-actions">
        ${bodyOpen ? '' : `<button class="text-btn" data-addbody="${esc(g.id)}">Add description</button>`}
        ${g.edited != null ? `<button class="text-btn" data-reset="${esc(g.id)}" title="Go back to the suggested message">Reset message</button>` : ''}
        ${cs.data?.claude ? `<button class="text-btn" data-rewrite="${esc(g.id)}" ${busy ? 'disabled' : ''}>${icon('Refresh', 14)}${busy ? 'Writing…' : 'Write with Claude'}</button>` : ''}
        <button class="btn-primary" data-commit="${esc(g.id)}" ${picked.length && !cs.busy ? '' : 'disabled'}>Commit ${picked.length === files.length ? '' : picked.length + ' of '}${files.length} file${files.length === 1 ? '' : 's'}${picked.some((p) => cs.hunksOff.has(p)) ? ' (partly)' : ''}</button>
      </div>
    </div>
    <div class="cm-files">${files.map((p) => fileRow(p, g)).join('')}</div>
  </section>`;
}

function draw() {
  if (!host || !ctx || ctx.view !== 'commit' || ctx.repo === 'all') return;
  if (cs.loading && !cs.data) { host.innerHTML = '<div class="loading mono">Reading changes…</div>'; return; }
  if (cs.error && !cs.data) { host.innerHTML = `<div class="empty"><h3>Couldn't read changes</h3><p>${esc(cs.error)}</p></div>`; return; }
  const d = cs.data;
  const total = d.files.length;
  const q = (ctx.q || '').toLowerCase();
  const groups = q ? cs.groups.filter((g) => g.title.toLowerCase().includes(q) || g.files.some((p) => p.toLowerCase().includes(q))) : cs.groups;
  const commitable = cs.groups.filter((g) => g.files.some((p) => !cs.off.has(p)));
  const add = d.files.reduce((s, f) => s + f.add, 0), del = d.files.reduce((s, f) => s + f.del, 0);

  const banner = cs.banner ? `<div class="cm-banner ${cs.banner.error ? 'is-error' : ''}">
      <span>${cs.banner.html}</span>
      ${cs.banner.undo && d.canUndo ? `<button class="text-btn" data-undo>Undo</button>` : ''}
      ${cs.banner.push && ctx.remote ? `<button class="text-btn bordered" data-pushnow ${cs.busy ? 'disabled' : ''}>${icon('ArrowUp02', 14)}${cs.busy === 'push' ? 'Pushing…' : 'Push'}</button>` : ''}
      <button class="text-btn" data-dismiss aria-label="Dismiss">${icon('Cancel01', 14)}</button>
    </div>` : '';

  if (!total) {
    host.innerHTML = banner + `<div class="empty"><h3>Nothing to commit</h3><p>${esc(ctx.repo)} is clean on ${esc(d.branch)}.</p></div>`;
    return;
  }

  host.innerHTML = `${banner}
    <div class="cm-bar">
      <div class="cm-summary"><b>${total} changed file${total > 1 ? 's' : ''}</b> <span class="mono muted">on ${esc(d.branch)} · <span class="a">+${compact(add)}</span> <span class="d">−${compact(del)}</span> · ${cs.groups.length} suggested commit${cs.groups.length > 1 ? 's' : ''}</span></div>
      <div class="cm-tools">
        <div class="seg" role="radiogroup" aria-label="Message style">
          <button data-format="gitmoji" aria-selected="${cs.format === 'gitmoji'}" title="✨ Added book notes for …">Gitmoji</button>
          <button data-format="conventional" aria-selected="${cs.format === 'conventional'}" title="feat(books): add notes for …">Conventional</button>
          <button data-format="both" aria-selected="${cs.format === 'both'}" title="✨ feat(books): add notes for …">Both</button>
        </div>
      </div>
    </div>
    <div class="cm-bar cm-bar-2">
      <div class="cm-tools">
        ${d.claude ? `<button class="text-btn bordered" data-regroup ${cs.busy ? 'disabled' : ''}>${icon('Layers01', 14)}${cs.busy === 'regroup' ? 'Claude is reading your changes…' : 'Regroup with Claude'}</button>` : `<span class="muted cm-hint">Install Claude Code for sharper grouping and messages.</span>`}
        <button class="text-btn bordered" data-guess ${cs.busy ? 'disabled' : ''} title="Back to the quick, local grouping">Reset grouping</button>
        <button class="text-btn bordered" data-merge ${cs.groups.length > 1 && !cs.busy ? '' : 'disabled'}>Make it one commit</button>
      </div>
      <button class="btn-primary" data-commitall ${commitable.length && !cs.busy ? '' : 'disabled'}>${commitable.length > 1 ? `Commit all ${commitable.length}` : 'Commit'}</button>
    </div>
    ${cs.error ? `<div class="cm-banner is-error"><span>${esc(cs.error)}</span></div>` : ''}
    ${groups.map((g) => card(g, cs.groups.indexOf(g))).join('')}`;
}

// ---------- actions ----------
const groupById = (id) => cs.groups.find((g) => g.id === id);

async function commitGroup(g) {
  const picked = g.files.filter((p) => !cs.off.has(p));
  const whole = [], partial = {};
  for (const p of picked) {
    const off = cs.hunksOff.get(p);
    const hk = cs.files.get(p)?.hunks || [];
    if (off && off.size && hk.length) partial[p] = hk.filter((h) => !off.has(h.id)).map((h) => h.id);
    else whole.push(p);
  }
  const message = messageFor(g);
  const res = await api(`/api/changes/commit?repo=${encodeURIComponent(cs.repo)}`, { files: whole, partial, message });
  // whole files leave the group; partly committed files stay with their remaining chunks
  g.files = g.files.filter((p) => cs.off.has(p) || partial[p]);
  for (const p of Object.keys(partial)) cs.hunksOff.delete(p);
  return { sha: res.sha, subject: message.split('\n')[0], n: picked.length };
}

async function warnOk(groups) {
  const highs = groups.flatMap((g) => g.files.filter((p) => !cs.off.has(p)).flatMap((p) => (cs.files.get(p)?.warnings || []).filter((w) => w.level === 'high').map((w) => `<li><b>${esc(p)}</b> ${esc(w.text)}</li>`)));
  if (!highs.length) return true;
  return confirmDialog({ title: 'Commit anyway?', text: `These look risky to commit:<ul class="warn-list">${highs.join('')}</ul>Untick them to leave them out.`, ok: 'Commit anyway', danger: true });
}

function pickEmoji(g, anchor) {
  document.querySelector('.emoji-pop')?.remove();
  const pop = document.createElement('div');
  pop.className = 'emoji-pop';
  pop.innerHTML = `<input class="emoji-q" placeholder="Search gitmoji" spellcheck="false"><div class="emoji-grid">${GITMOJI.map(([e, t, n]) => `<button data-e="${e}" data-t="${t}" title="${esc(n)}"><span>${e}</span><span class="emoji-name">${esc(n)}</span></button>`).join('')}</div>`;
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.min(innerWidth - 336, r.left) + 'px';
  pop.style.top = (r.bottom + 6 + scrollY) + 'px';
  const q = pop.querySelector('input');
  q.focus();
  q.addEventListener('input', () => { const v = q.value.toLowerCase(); for (const b of pop.querySelectorAll('[data-e]')) b.hidden = v && !b.title.toLowerCase().includes(v) && !b.dataset.t.includes(v); });
  const close = () => { pop.remove(); removeEventListener('mousedown', outside, true); };
  const outside = (e) => { if (!pop.contains(e.target)) close(); };
  setTimeout(() => addEventListener('mousedown', outside, true));
  q.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); if (e.key === 'Enter') pop.querySelector('[data-e]:not([hidden])')?.click(); });
  pop.addEventListener('click', (e) => {
    const b = e.target.closest('[data-e]');
    if (!b) return;
    g.emoji = b.dataset.e;
    if (b.dataset.t !== 'revert' && g.edited == null) g.type = b.dataset.t;
    close(); draw();
  });
}

function reviewAll() {
  const order = cs.groups.filter((x) => x.files.some((p) => !cs.off.has(p)));
  const m = modal({
    title: `Review ${order.length} commits`,
    wide: true,
    body: `<p class="note" style="margin:0 0 12px">They'll be made top to bottom. Drag to reorder, or merge one into the commit above it.</p><ol class="rv-list"></ol>`,
    actions: `<button class="text-btn bordered" data-cancel>Cancel</button><button class="btn-primary" data-go>Create commits</button>`,
  });
  const listEl = m.el.querySelector('.rv-list');
  const paint = () => {
    listEl.innerHTML = order.map((g, i) => {
      const n = g.files.filter((p) => !cs.off.has(p)).length;
      return `<li class="rv-item" draggable="true" data-i="${i}">
        <span class="rv-grip" aria-hidden="true">${icon('DragDropVertical', 16)}</span>
        <span class="cm-num mono">${i + 1}</span>
        <span class="rv-main"><span class="rv-subj">${esc(subjectFor(g))}</span><span class="mono muted">${esc(g.title)} · ${n} file${n > 1 ? 's' : ''}</span></span>
        <span class="rv-tools">
          <button class="icon-btn sm" data-up="${i}" ${i ? '' : 'disabled'} title="Move up">${icon('ArrowUp01', 14)}</button>
          <button class="icon-btn sm" data-down="${i}" ${i < order.length - 1 ? '' : 'disabled'} title="Move down">${icon('ArrowDown01', 14)}</button>
          <button class="text-btn" data-merge="${i}" ${i ? '' : 'disabled'} title="Fold into the commit above">Merge up</button>
        </span>
      </li>`;
    }).join('');
    m.el.querySelector('[data-go]').textContent = `Create ${order.length} commit${order.length > 1 ? 's' : ''}`;
  };
  paint();
  let dragI = null;
  listEl.addEventListener('dragstart', (e) => { const li = e.target.closest('.rv-item'); dragI = +li.dataset.i; li.classList.add('is-drag'); e.dataTransfer.effectAllowed = 'move'; });
  listEl.addEventListener('dragover', (e) => { e.preventDefault(); const li = e.target.closest('.rv-item'); for (const x of listEl.children) x.classList.toggle('is-over', x === li); });
  listEl.addEventListener('drop', (e) => {
    e.preventDefault(); const li = e.target.closest('.rv-item'); if (!li || dragI == null) return;
    const to = +li.dataset.i; const [g] = order.splice(dragI, 1); order.splice(to, 0, g); dragI = null; paint();
  });
  listEl.addEventListener('dragend', () => { dragI = null; for (const x of listEl.children) x.classList.remove('is-drag', 'is-over'); });
  m.el.addEventListener('click', async (e) => {
    let b;
    if ((b = e.target.closest('[data-up]'))) { const i = +b.dataset.up; [order[i - 1], order[i]] = [order[i], order[i - 1]]; paint(); }
    else if ((b = e.target.closest('[data-down]'))) { const i = +b.dataset.down; [order[i + 1], order[i]] = [order[i], order[i + 1]]; paint(); }
    else if ((b = e.target.closest('[data-merge]'))) {
      const i = +b.dataset.merge; const [g] = order.splice(i, 1);
      order[i - 1].files.push(...g.files); cs.groups = cs.groups.filter((x) => x !== g); paint(); draw();
    }
    else if (e.target.closest('[data-cancel]')) m.close();
    else if (e.target.closest('[data-go]')) {
      if (!(await warnOk(order))) return;
      m.close();
      // keep the main list in the reviewed order too
      cs.groups = [...order, ...cs.groups.filter((g) => !order.includes(g))];
      run('all', async () => {
        const done = [];
        for (const g of order) {
          done.push(await commitGroup(g));
          cs.banner = { html: `Committed ${done.length} of ${order.length}…` };
          draw();
        }
        cs.banner = { html: `Made ${done.length} commit${done.length > 1 ? 's' : ''}: ${done.map((r) => `<span class="mono muted">${r.sha.slice(0, 7)}</span> ${esc(r.subject)}`).join(' · ')}`, undo: done.length === 1, push: true };
        celebrate();
      });
    }
  });
}

async function run(id, fn) {
  cs.busy = id; cs.error = ''; draw();
  try { await fn(); }
  catch (e) { cs.banner = { html: esc(e.message), error: true }; }
  finally { cs.busy = null; }
  await loadChanges(cs.repo, { keep: true });
  ctx.onChange && ctx.onChange();
}

function onClick(e) {
  const t = (s) => e.target.closest(s);
  let b;
  if ((b = t('[data-pick]'))) return ctx.pickRepo(b.dataset.pick);
  if ((b = t('[data-format]'))) {
    const f = b.dataset.format;
    for (const g of cs.groups) if (g.edited != null && (g.editedFormat === 'conventional') !== (f === 'conventional')) g.edited = null;
    cs.format = f; store.format = f; save(); return draw();
  }
  if ((b = t('[data-emoji]'))) return pickEmoji(groupById(b.dataset.emoji), b);
  if ((b = t('[data-chunks]'))) { const p = b.dataset.chunks; cs.hunkOpen.has(p) ? cs.hunkOpen.delete(p) : cs.hunkOpen.add(p); return draw(); }
  if ((b = t('[data-diff]'))) { const p = b.dataset.diff; cs.open.has(p) ? cs.open.delete(p) : cs.open.add(p); return draw(); }
  if ((b = t('[data-addbody]'))) { cs.bodyOpen.add(b.dataset.addbody); draw(); return host.querySelector(`[data-body="${CSS.escape(b.dataset.addbody)}"]`)?.focus(); }
  if ((b = t('[data-reset]'))) { groupById(b.dataset.reset).edited = null; return draw(); }
  if ((b = t('[data-dismiss]'))) { cs.banner = null; return draw(); }
  if ((b = t('[data-guess]'))) { adoptGroups(cs.data.groups); cs.off.clear(); return draw(); }
  if ((b = t('[data-merge]'))) {
    const all = cs.groups.flatMap((g) => g.files);
    cs.groups = [{ id: 'one', title: 'Everything', why: 'all changes as a single commit', type: 'feat', scope: '', emoji: '✨', conventional: 'update site', gitmoji: 'Updated site', body: '', files: all, edited: null }];
    return draw();
  }
  if ((b = t('[data-rewrite]'))) {
    const g = groupById(b.dataset.rewrite);
    return run(g.id, async () => {
      const files = g.files.filter((p) => !cs.off.has(p));
      const m = await api(`/api/changes/message?repo=${encodeURIComponent(cs.repo)}`, { files: files.length ? files : g.files });
      Object.assign(g, { type: m.type, scope: m.scope, emoji: m.emoji, conventional: m.conventional, gitmoji: m.gitmoji, body: m.body, source: 'claude', edited: null });
      if (g.title === 'New changes' || g.title === 'Everything' || g.title === 'New commit') g.title = m.title;
    });
  }
  if ((b = t('[data-regroup]'))) {
    return run('regroup', async () => {
      const res = await api(`/api/changes/suggest?repo=${encodeURIComponent(cs.repo)}`, {});
      adoptGroups(res.groups);
      cs.off.clear();
    });
  }
  if ((b = t('[data-commit]'))) {
    const g = groupById(b.dataset.commit);
    return warnOk([g]).then((go) => go && run(g.id, async () => {
      const r = await commitGroup(g);
      cs.banner = { html: `Committed <b>${esc(r.subject)}</b> <span class="mono muted">${r.sha.slice(0, 7)} · ${r.n} file${r.n > 1 ? 's' : ''}</span>`, undo: true, push: true };
    }));
  }
  if ((b = t('[data-commitall]'))) {
    const order = cs.groups.filter((x) => x.files.some((p) => !cs.off.has(p)));
    if (order.length > 1) return reviewAll();
    const g = order[0];
    return warnOk([g]).then((go) => go && run(g.id, async () => {
      const r = await commitGroup(g);
      cs.banner = { html: `Committed <b>${esc(r.subject)}</b> <span class="mono muted">${r.sha.slice(0, 7)}</span>`, undo: true, push: true };
    }));
  }
  if ((b = t('[data-pushnow]'))) {
    return run('push', async () => {
      await api(`/api/x/push?repo=${encodeURIComponent(cs.repo)}`, {});
      cs.banner = { html: `Pushed to ${ctx.host?.name || 'your remote'}.` };
    });
  }
  if ((b = t('[data-undo]'))) {
    return run('undo', async () => {
      await api(`/api/changes/undo?repo=${encodeURIComponent(cs.repo)}`, {});
      cs.banner = { html: 'Undid the last commit. Its files are back in your changes.' };
    });
  }
}

function onInput(e) {
  const el = e.target;
  if (el.dataset.subject) {
    const g = groupById(el.dataset.subject);
    g.edited = el.value;
    g.editedFormat = cs.format;
    const full = subjectFor(g);
    const wrap = el.closest('.cm-subject');
    wrap.querySelector('.cm-count').textContent = full.length;
    wrap.classList.toggle('is-long', full.length > 72);
  } else if (el.dataset.body) {
    groupById(el.dataset.body).body = el.value;
  } else if (el.dataset.title) {
    groupById(el.dataset.title).title = el.value;
  }
}

function onChange(e) {
  const el = e.target;
  if (el.dataset.file) {
    el.checked ? cs.off.delete(el.dataset.file) : cs.off.add(el.dataset.file);
    return draw();
  }
  if (el.dataset.hunk) {
    const p = el.dataset.hunk;
    const set = cs.hunksOff.get(p) || new Set();
    el.checked ? set.delete(el.dataset.hid) : set.add(el.dataset.hid);
    const total = (cs.files.get(p)?.hunks || []).length;
    if (set.size >= total) { set.clear(); cs.off.add(p); } // nothing picked: leave the file out
    else cs.off.delete(p);
    set.size ? cs.hunksOff.set(p, set) : cs.hunksOff.delete(p);
    return draw();
  }
  if (el.dataset.move) {
    const p = el.dataset.move, to = el.value;
    if (!to) return;
    const from = cs.groups.find((g) => g.files.includes(p));
    from.files = from.files.filter((x) => x !== p);
    let dest = groupById(to);
    if (to === '__new') {
      const f = cs.files.get(p);
      dest = { id: 'n' + Date.now(), title: 'New commit', why: '', type: 'chore', scope: '', emoji: '🔧', conventional: `update ${p.split('/').pop()}`, gitmoji: `Updated ${p.split('/').pop()}`, body: '', files: [], edited: null };
      if (f?.status === 'A') Object.assign(dest, { type: 'feat', emoji: '✨', conventional: `add ${p.split('/').pop()}`, gitmoji: `Added ${p.split('/').pop()}` });
      cs.groups.push(dest);
    }
    const learnTo = dest.files.slice();
    dest.files.push(p);
    cs.groups = cs.groups.filter((g) => g.files.length);
    draw();
    // remember this correction for next time
    fetch(`/api/changes/learn?repo=${encodeURIComponent(cs.repo)}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-changes': '1' }, body: JSON.stringify({ file: p, from: from.files, to: learnTo }) }).catch(() => {});
    toast('Moved. It will remember this next time.');
  }
}
