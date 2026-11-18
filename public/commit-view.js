import { icon } from './icons.js';
import { commitFold, pushLaunch, discardOut } from './fx.js';
import * as ai from './ai.js';
import { pickEmoji as emojiPicker } from './emoji.js';
import { sfxWrote } from './sfx.js';
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
const GL_TYPE = { feat: 'feature', style: 'ui', fix: 'fix', perf: 'perf', refactor: 'refactor', chore: 'refactor', build: 'refactor', docs: 'other', test: 'other', ci: 'other' };
const TYPE_EMOJI = { feat: '✨', fix: '🐛', style: '💄', perf: '⚡️', refactor: '♻️', docs: '📝', chore: '🔧', build: '📦', ci: '👷', test: '✅' };

let store = {};
try { store = JSON.parse(localStorage.getItem('changes.commit') || '{}'); } catch {}
const save = () => { try { localStorage.setItem('changes.commit', JSON.stringify(store)); } catch {} };

const cs = {
  repo: null, data: null, groups: [], files: new Map(), off: new Set(), open: new Set(), bodyOpen: new Set(),
  busy: null, error: '', banner: null, format: store.format || 'gitmoji', loading: false, hunksOff: new Map(), hunkOpen: new Set(),
  engine: 'rules', writing: new Set(), grouping: false,
};
let host = null, ctx = null;

const api = async (path, body) => {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json', 'x-changes': '1' }, body: JSON.stringify(body) } : {});
  const data = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok || data.error) throw new Error(data.error || res.statusText);
  return data;
};

export function subjectFor(g, format = cs.format) {
  if (g.edited != null) return format === 'conventional' || format === 'plain' ? g.edited : `${g.emoji || '✨'} ${g.edited.replace(LEAD, '')}`;
  const scope = g.scope ? `(${g.scope})` : '';
  const emoji = g.emoji || TYPE_EMOJI[g.type] || '✨';
  if (format === 'conventional') return `${g.type}${scope}: ${g.conventional}`;
  if (format === 'both') return `${emoji} ${g.type}${scope}: ${g.conventional}`;
  if (format === 'plain') return cs.data?.grouping?.style?.tense === 'imperative' ? g.conventional.replace(/^\w/, (c) => c.toUpperCase()) : g.gitmoji;
  return `${emoji} ${g.gitmoji}`;
}
const messageFor = (g) => {
  const subj = subjectFor(g).trim();
  const body = (g.body || '').trim();
  return body ? `${subj}\n\n${body}` : subj;
};

// Each repo's plan (groups, messages written by the AI, your edits, unticked files) is kept, so
// leaving the Commit tab or switching repos and coming back picks up where you left off. Files
// that were committed or reverted drop out; new ones land in a "New changes" card.
const PLANS = 'staged-commit-plans';
const plans = (() => { try { return JSON.parse(localStorage.getItem(PLANS) || '{}'); } catch { return {}; } })();
let planT;
// A file can be split across commits: g.hunks[path] lists the chunks this commit owns. A path missing
// from g.hunks means the commit takes the whole file.
const allHunks = (p) => cs.files.get(p)?.hunks || [];
const isSplit = (g, p) => !!g.hunks?.[p] && allHunks(p).length > 0;
const ownedHunks = (g, p) => (isSplit(g, p) ? allHunks(p).filter((h) => g.hunks[p].includes(h.id)) : allHunks(p));
const pickedHunks = (g, p) => { const off = cs.hunksOff.get(p); return ownedHunks(g, p).filter((h) => !off?.has(h.id)); };
const isOn = (g, p) => (isSplit(g, p) ? pickedHunks(g, p).length > 0 : !cs.off.has(p));
// What this commit changes in a file: its own chunks only, when the file is split.
function viewOf(g, p) {
  const f = cs.files.get(p);
  if (!f || !isSplit(g, p)) return f;
  const hs = pickedHunks(g, p).length ? pickedHunks(g, p) : ownedHunks(g, p);
  return { ...f, diff: hs.map((h) => h.head + '\n' + h.lines.join('\n')).join('\n'), add: hs.reduce((n, h) => n + h.add, 0), del: hs.reduce((n, h) => n + h.del, 0) };
}
// Hands a file (or the chunks of it a commit owns) from one commit to another.
function give(from, to, p) {
  const ids = isSplit(from, p) ? [...from.hunks[p]] : null;
  from.files = from.files.filter((x) => x !== p);
  if (from.hunks) delete from.hunks[p];
  if (!to.files.includes(p)) { to.files.push(p); if (ids) (to.hunks ||= {})[p] = ids; }
  else if (isSplit(to, p)) to.hunks[p] = ids ? [...new Set([...to.hunks[p], ...ids])] : allHunks(p).map((h) => h.id);
  if (isSplit(to, p) && to.hunks[p].length >= allHunks(p).length && !cs.groups.some((g) => g !== to && g.files.includes(p))) delete to.hunks[p];
}
function remember() {
  if (!cs.repo || !cs.data) return;
  clearTimeout(planT);
  const repo = cs.repo;
  planT = setTimeout(() => {
    plans[repo] = { at: Date.now(), groups: cs.groups.map(({ id, title, why, type, scope, emoji, emojiSuggestions, conventional, gitmoji, body, files, hunks, edited, editedFormat, source, aiDone, confidence, review }) => ({ id, title, why, type, scope, emoji, emojiSuggestions, conventional, gitmoji, body, files, hunks, edited, editedFormat, source, aiDone, confidence, review })), off: [...cs.off] };
    // Keep the 30 most recent repos.
    for (const k of Object.keys(plans).sort((a, b) => plans[b].at - plans[a].at).slice(30)) delete plans[k];
    try { localStorage.setItem(PLANS, JSON.stringify(plans)); } catch {}
  }, 300);
}
function restore(repo, files) {
  const p = plans[repo];
  if (!p?.groups?.length) return false;
  cs.groups = p.groups.map((g) => ({ ...g, files: [...g.files], hunks: g.hunks ? JSON.parse(JSON.stringify(g.hunks)) : undefined }));
  cs.off = new Set(p.off || []);
  mergeFiles(files);
  return cs.groups.length > 0;
}

function adoptGroups(groups) {
  cs.groups = groups.map((g) => ({ ...g, files: [...new Set(g.files)], hunks: g.hunks ? JSON.parse(JSON.stringify(g.hunks)) : undefined, edited: null }));
}

// Keep the user's arrangement when files change underneath us.
function mergeFiles(newFiles) {
  const paths = new Set(newFiles.map((f) => f.path));
  for (const g of cs.groups) g.files = g.files.filter((p) => paths.has(p));
  const byPath = new Map(newFiles.map((f) => [f.path, f]));
  const split = new Set(), lost = new Map();
  for (const g of cs.groups) for (const p of Object.keys(g.hunks || {})) {
    const ids = new Set((byPath.get(p)?.hunks || []).map((h) => h.id));
    g.hunks[p] = g.hunks[p].filter((id) => ids.has(id));
    if (!g.hunks[p].length) { delete g.hunks[p]; g.files = g.files.filter((x) => x !== p); if (!lost.has(p)) lost.set(p, g); } else split.add(p);
  }
  // A file whose chunks all changed stays in the commit it was in, rather than dropping to "New changes".
  for (const [p, g] of lost) if (!cs.groups.some((x) => x.files.includes(p))) g.files.push(p);
  for (const p of split) {
    const holders = cs.groups.filter((g) => g.files.includes(p));
    if (holders.some((g) => !g.hunks?.[p])) continue; // someone takes the whole file already
    const owned = new Set(holders.flatMap((g) => g.hunks[p]));
    const extra = (byPath.get(p)?.hunks || []).map((h) => h.id).filter((id) => !owned.has(id));
    if (extra.length) holders[0].hunks[p].push(...extra);
    if (holders.length === 1) delete holders[0].hunks[p];
  }
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
    if (!store.format) {
      const learnedFormat = data.grouping?.style?.format;
      cs.format = learnedFormat === 'conventional' || learnedFormat === 'plain' ? learnedFormat : 'gitmoji';
    }
    cs.files = new Map(data.files.map((f) => [f.path, f]));
    let restored = false;
    if (keep && cs.groups.length) mergeFiles(data.files);
    else if (!(restored = restore(repo, data.files))) adoptGroups(data.groups);
    cs.error = '';
    pickEngine().then(draw);
  } catch (e) {
    cs.error = e.message;
  }
  cs.loading = false;
  if (!same || !keep) intro();
  draw();
}
// Cards rise in one after another only when a repo's changes first show up, not on every redraw.
let introT;
function intro() { host?.classList.add('is-intro'); clearTimeout(introT); introT = setTimeout(() => host?.classList.remove('is-intro'), 900); }

// Settings can change the engines and the message style while this tab is closed.
async function pickEngine() {
  cs.engine = await ai.pick();
}
// Hold to discard a suggested commit: 1.5s of holding, let go to cancel. Keyboard users get the dialog.
const HOLD_MS = 1500;
function discardWhat(g) {
  const files = [], partial = {};
  for (const p of g.files.filter((x) => cs.files.has(x))) isSplit(g, p) ? (partial[p] = g.hunks[p]) : files.push(p);
  return Object.keys(partial).length ? { files, partial } : { files };
}
function onHold(e) {
  const b = e.target.closest('[data-discardgroup]');
  if (!b || b.disabled || e.button > 0) return;
  b.classList.add('is-holding');
  const done = setTimeout(() => {
    stop();
    const g = groupById(b.dataset.discardgroup);
    if (g) discard(discardWhat(g), host.querySelector(`[data-group="${CSS.escape(g.id)}"]`));
  }, HOLD_MS);
  const t0 = Date.now();
  const stop = () => { clearTimeout(done); b.classList.remove('is-holding'); for (const k of ['pointerup', 'pointerleave', 'pointercancel']) b.removeEventListener(k, early); };
  const early = () => { if (Date.now() - t0 < HOLD_MS) { stop(); if (Date.now() - t0 < 300) toast('Hold the button to discard'); } };
  for (const k of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(k, early);
}

export function mountCommit(el, context) {
  host = el; ctx = context;
  if (!host.dataset.holdBound) { host.addEventListener('pointerdown', onHold); host.dataset.holdBound = '1'; }
  try { store = JSON.parse(localStorage.getItem('changes.commit') || '{}'); } catch {}
  cs.format = store.format || 'gitmoji';
  if (cs.data) pickEngine().then(draw);
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
  const on = isOn(g, p);
  const open = cs.open.has(p);
  const all = f.hunks || [];
  const hk = ownedHunks(g, p);
  const split = isSplit(g, p);
  const offH = cs.hunksOff.get(p) || new Set();
  const offN = hk.filter((h) => offH.has(h.id)).length;
  const v = viewOf(g, p);
  const hOpen = cs.hunkOpen.has(p);
  const warn = (f.warnings || []);
  const others = cs.groups.filter((x) => x !== g);
  return `<div class="cm-file ${on ? '' : 'is-off'}">
    <label class="cm-check" title="${on ? 'Leave out of this commit' : 'Include in this commit'}"><input type="checkbox" data-file="${esc(p)}" data-g="${esc(g.id)}" ${on ? 'checked' : ''}><span></span></label>
    <span class="cm-status s-${f.status}" title="${STATUS[f.status] || f.status}${f.untracked ? ' (new file)' : ''}">${f.status}</span>
    <button class="cm-path" data-diff="${esc(p)}" aria-expanded="${open}" title="${esc(f.from ? `${f.from} → ${p}` : p)}"><span class="dir">${esc(dirn)}</span>${esc(base)}</button>
    <span class="cm-extra">
      ${warn.map((w) => `<span class="chip ${w.level === 'high' ? 'is-bad' : w.level === 'mid' ? 'is-warn' : ''}" title="${esc(w.text)}">${icon('Alert02', 12)}${esc(w.text)}</span>`).join('')}
      ${hk.length && (all.length > 1 || split) ? `<button class="chip is-btn ${offN || split ? 'is-on' : ''}" data-chunks="${esc(p)}" aria-expanded="${hOpen}" title="${split ? `This commit takes ${hk.length} of the file's ${all.length} chunks; the rest are in other commits. Click to pick.` : 'Pick which chunks of this file go in'}">${split || offN ? `${hk.length - offN} of ${all.length} chunks` : `${all.length} chunks`}</button>` : ''}
      <span class="lines mono">${f.binary ? '<span class="muted">binary</span>' : `<span class="a">+${compact(v.add)}</span> <span class="d">−${compact(v.del)}</span>`}</span>
    </span>
    <button class="cm-discard" data-discard="${esc(p)}" data-g="${esc(g.id)}" title="Discard ${split ? 'these chunks of' : 'changes to'} to ${esc(base)}" aria-label="Discard changes to ${esc(base)}">${icon('Delete02', 14)}</button>
    <span class="cm-move-wrap"><select class="cm-move" data-move="${esc(p)}" data-g="${esc(g.id)}" aria-label="Move to another commit">
      <option value="">Move to…</option>
      ${others.map((o) => `<option value="${esc(o.id)}">${esc(clip(subjectFor(o), 48))}</option>`).join('')}
      <option value="__new">New commit</option>
    </select></span>
  </div>
  ${hOpen && hk.length ? fresh(chunkView(f, offH, g), p) : ''}
  ${open && !hOpen ? fresh(diffView(v), p) : ''}`;
}

// Diffs and chunk pickers open and close with their real height, so the cards below glide instead of jumping.
const EASE = 'cubic-bezier(0.23, 1, 0.32, 1)';
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
function boxFrames(el, open) {
  const cs2 = getComputedStyle(el);
  const full = { height: el.offsetHeight - parseFloat(cs2.paddingTop) - parseFloat(cs2.paddingBottom) - parseFloat(cs2.borderTopWidth) - parseFloat(cs2.borderBottomWidth) + 'px', paddingTop: cs2.paddingTop, paddingBottom: cs2.paddingBottom, marginTop: cs2.marginTop, marginBottom: cs2.marginBottom, opacity: 1, transform: 'none' };
  const none = { height: '0px', paddingTop: '0px', paddingBottom: '0px', marginTop: '0px', marginBottom: '0px', opacity: 0, transform: 'translateY(-4px)' };
  return { frames: open ? [none, full] : [full, none], ms: Math.round(Math.min(open ? 420 : 300, (open ? 240 : 170) + el.offsetHeight * 0.12)) };
}
function unfold(el) {
  if (!el || calm()) return;
  const { frames, ms } = boxFrames(el, true);
  el.style.overflow = 'hidden';
  el.animate(frames, { duration: ms, easing: EASE }).finished.then(() => { el.style.overflow = ''; }, () => {});
}
async function fold(el) {
  if (!el || calm()) return;
  const { frames, ms } = boxFrames(el, false);
  el.style.overflow = 'hidden';
  await el.animate(frames, { duration: ms, easing: EASE, fill: 'forwards' }).finished.catch(() => {});
}
async function togglePanel(set, p, btn) {
  const next = btn.closest('.cm-file')?.nextElementSibling;
  if (set.has(p)) {
    await fold(next?.matches('.cm-diff, .cm-chunks') ? next : null);
    set.delete(p); draw(); return;
  }
  set.add(p); cs.justOpened = p; draw(); cs.justOpened = null;
  unfold(host.querySelector('.cm-diff.is-new, .cm-chunks.is-new'));
}

// The panel you just opened slides in; the ones already open stay still on redraws.
const fresh = (html, p) => (cs.justOpened === p ? html.replace(/class="(cm-chunks|cm-diff)/, 'class="$1 is-new') : html);

function chunkView(f, offH, g) {
  const own = new Set(ownedHunks(g, f.path).map((h) => h.id));
  return `<div class="cm-chunks">${f.hunks.map((h, i) => {
    if (!own.has(h.id)) return '';
    const on = !offH.has(h.id);
    const lines = h.lines.slice(0, 24).map((l) => `<span class="${l.startsWith('+') ? 'a' : l.startsWith('-') ? 'd' : ''}">${esc(l) || ' '}</span>`).join('\n');
    return `<div class="cm-chunk ${on ? '' : 'is-off'}">
      <label class="cm-chunk-head"><span class="cm-check"><input type="checkbox" data-hunk="${esc(f.path)}" data-g="${esc(g.id)}" data-hid="${h.id}" ${on ? 'checked' : ''}><span></span></span>
        <span class="mono">Chunk ${i + 1}</span><span class="mono muted">${esc(h.head.replace(/^@@[^@]*@@\s?/, '') || 'line ' + (h.head.match(/\+(\d+)/) || [])[1])}</span>
        <span class="lines mono"><span class="a">+${h.add}</span> <span class="d">−${h.del}</span></span>
        <button class="cm-discard" data-discardhunk="${esc(f.path)}" data-hid="${h.id}" title="Discard this chunk" aria-label="Discard chunk ${i + 1}">${icon('Delete02', 13)}</button></label>
      <pre class="cm-diff mono scroll-fade">${lines}${h.lines.length > 24 ? `\n<span class="muted">… ${h.lines.length - 24} more lines</span>` : ''}</pre>
    </div>`;
  }).join('')}</div>`;
}

function diffView(f) {
  if (f.binary) return `<div class="cm-diff muted scroll-fade">Binary file${f.bytes ? ` · ${compact(Math.round(f.bytes / 1024))} KB` : ''}</div>`;
  if (!f.diff) return `<div class="cm-diff muted scroll-fade">No text changes</div>`;
  const lines = f.diff.split('\n').slice(0, 400).map((l) => {
    const cls = l.startsWith('@@') ? 'h' : l.startsWith('+') ? 'a' : l.startsWith('-') ? 'd' : '';
    return `<span class="${cls}">${esc(l) || ' '}</span>`;
  }).join('\n');
  return `<pre class="cm-diff mono scroll-fade">${lines}</pre>`;
}

function card(g, i) {
  const files = g.files.filter((p) => cs.files.has(p));
  const picked = files.filter((p) => isOn(g, p));
  const add = picked.reduce((s, p) => s + (viewOf(g, p)?.add || 0), 0);
  const del = picked.reduce((s, p) => s + (viewOf(g, p)?.del || 0), 0);
  const busy = cs.busy === g.id;
  const subj = subjectFor(g);
  const highs = picked.flatMap((p) => (cs.files.get(p)?.warnings || []).filter((w) => w.level === 'high').map((w) => `${p.split('/').pop()} ${w.text}`));
  const long = subj.length > 72;
  // The description is optional, so it stays tucked away until asked for, even when the AI wrote one.
  const bodyOpen = cs.bodyOpen.has(g.id), hasBody = !!(g.body || '').trim();
  const writing = cs.writing.has(g.id);
  return `<section class="cm-card ${writing ? 'is-writing' : ''}" data-group="${esc(g.id)}" data-gl="${esc(subj)}" data-gl-n="${picked.length}" data-gl-unit="file" data-gl-mix="${GL_TYPE[g.type] || 'other'}:1">
    <header class="cm-head">
      <span class="cm-num mono">${i + 1}</span>
      <div class="cm-subject ${long ? 'is-long' : ''} ${cs.format === 'gitmoji' || cs.format === 'both' ? 'has-emoji' : ''}">
        ${cs.format === 'gitmoji' || cs.format === 'both' ? `<button class="cm-emoji" data-emoji="${esc(g.id)}" title="Pick a gitmoji">${esc(g.emoji || '✨')}</button>` : ''}
        <input data-subject="${esc(g.id)}" value="${esc(cs.format === 'conventional' ? subj : subj.replace(LEAD, ''))}" spellcheck="true" aria-label="Commit message" placeholder="Write your own message" ${writing ? 'readonly' : ''}>
        <span class="cm-subj-tools">
          <span class="cm-count mono" title="Keep the first line under 72 characters">${subj.length}</span>
          <button class="cm-tool" data-clear="${esc(g.id)}" title="Clear the message and write your own" aria-label="Clear message">${icon('Eraser', 14)}</button>
          <button class="cm-tool is-ai" data-write="${esc(g.id)}" ${writing ? 'disabled' : ''} title="Rewrite this message with ${esc(ai.ENGINES[cs.engine].short)}" aria-label="Rewrite message">${icon('MagicWand01', 14)}</button>
        </span>
      </div>
      <span class="cm-meta mono">${picked.length}/${files.length} files · <span class="a">+${compact(add)}</span> <span class="d">−${compact(del)}</span></span>
      ${g.edited == null && g.source && g.source !== 'rules' && ai.ENGINES[g.source] ? `<span class="cm-badge mono" title="Written by ${esc(ai.ENGINES[g.source].label)}">${icon('Sparkles', 11)}${esc(ai.ENGINES[g.source].short)}</span>` : ''}
      ${g.review ? `<span class="cm-badge is-review mono" title="Below the 90% confidence target; review this grouping before committing">Check grouping</span>` : g.confidence != null && files.length > 1 ? `<span class="cm-badge mono" title="Grouping confidence">${Math.round(g.confidence * 100)}% confidence</span>` : ''}
    </header>
    ${g.why && !/^grouped by/i.test(g.why) ? `<p class="cm-why">${esc(g.why)}</p>` : ''}
    ${highs.length ? `<div class="cm-alert">${icon('Alert02', 14)}<span>Heads up: ${esc(highs.slice(0, 2).join('; '))}${highs.length > 2 ? ` and ${highs.length - 2} more` : ''}.</span></div>` : ''}
    <div class="cm-msg">
      ${bodyOpen ? `<textarea data-body="${esc(g.id)}" rows="${Math.min(8, Math.max(2, (g.body || '').split('\n').length))}" placeholder="Optional description: what changed and why">${esc(g.body || '')}</textarea>` : ''}
      <div class="cm-actions">
        <button class="text-btn cm-desc-btn" data-addbody="${esc(g.id)}" aria-expanded="${bodyOpen}">${bodyOpen ? 'Hide description' : hasBody ? 'Description' : 'Add description'}${!bodyOpen && hasBody ? '<i class="cm-desc-dot" title="Has a description"></i>' : ''}</button>
        ${g.edited != null ? `<button class="text-btn" data-reset="${esc(g.id)}" title="Go back to the suggested message">Reset message</button>` : ''}
        <button class="text-btn is-danger-soft hold-btn" data-discardgroup="${esc(g.id)}" ${cs.busy ? 'disabled' : ''} title="Hold to throw away these changes. You can bring them back right after.">${icon('Delete02', 14)}Hold to discard</button>
        <button class="btn-primary" data-commit="${esc(g.id)}" ${picked.length && !cs.busy ? '' : 'disabled'}>Commit ${picked.length === files.length ? '' : picked.length + ' of '}${files.length} file${files.length === 1 ? '' : 's'}${picked.some((p) => pickedHunks(g, p).length < allHunks(p).length) ? ' (partly)' : ''}</button>
      </div>
    </div>
    <div class="cm-files">${files.map((p) => fileRow(p, g)).join('')}</div>
  </section>`;
}

const clip = (t, n) => (t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t);

function draw() {
  remember();
  if (!host || !ctx || ctx.view !== 'commit' || ctx.repo === 'all') return;
  if (cs.loading && !cs.data) { host.innerHTML = '<div class="loading mono">Reading changes…</div>'; return; }
  if (cs.error && !cs.data) { host.innerHTML = `<div class="empty"><h3>Couldn't read changes</h3><p>${esc(cs.error)}</p></div>`; return; }
  const d = cs.data;
  const total = d.files.length;
  const q = (ctx.q || '').toLowerCase();
  const groups = q ? cs.groups.filter((g) => subjectFor(g).toLowerCase().includes(q) || g.files.some((p) => p.toLowerCase().includes(q))) : cs.groups;
  const commitable = cs.groups.filter((g) => g.files.some((p) => isOn(g, p)));
  const add = d.files.reduce((s, f) => s + f.add, 0), del = d.files.reduce((s, f) => s + f.del, 0);
  if (cs.banner && !cs.banner.t) cs.banner.t = Date.now();
  const settled = cs.banner && Date.now() - cs.banner.t > 1700 ? 'is-settled' : '';
  const banner = cs.banner ? `<div class="cm-banner ${cs.banner.error ? 'is-error' : ''} ${cs.banner.kind ? 'is-' + cs.banner.kind : ''} ${settled}">
      ${cs.banner.kind === 'commit' ? '<i class="cm-dot" aria-hidden="true"></i>' : cs.banner.kind === 'pushed' ? `<i class="cm-dot is-up" aria-hidden="true">${icon('Tick02', 12)}</i>` : ''}
      <span>${cs.banner.html}</span>
      ${cs.banner.undo && d.canUndo ? `<button class="text-btn" data-undo>Undo</button>` : ''}
      ${cs.banner.undoDiscard && d.canUndoDiscard ? `<button class="text-btn bordered" data-undodiscard>${icon('Undo02', 14)}Bring back</button>` : ''}
      ${cs.banner.push && ctx.remote ? `<button class="text-btn bordered ${cs.busy === 'push' ? 'is-pushing' : ''}" data-pushnow ${cs.busy ? 'disabled' : ''}>${icon('ArrowUp02', 14)}${cs.busy === 'push' ? 'Pushing…' : 'Push'}</button>` : ''}
      <button class="text-btn" data-dismiss aria-label="Dismiss">${icon('Cancel01', 14)}</button>
    </div>` : '';

  if (!total) {
    paintHost(banner + `<div class="empty"><h3>Nothing to commit</h3><p>${esc(ctx.repo)} is clean on ${esc(d.branch)}.</p></div>`);
    return;
  }

  paintHost(`${banner}
    <div class="cm-bar">
      <div class="cm-summary"><b>${total} changed file${total > 1 ? 's' : ''}</b> <span class="mono muted">on ${esc(d.branch)} · <span class="a">+${compact(add)}</span> <span class="d">−${compact(del)}</span> · ${cs.groups.length} suggested commit${cs.groups.length > 1 ? 's' : ''}</span></div>
      <div class="cm-tools">
        <button class="text-btn bordered" data-regroup ${cs.busy || cs.grouping ? 'disabled' : ''}>${icon('Refresh', 14)}${cs.grouping ? 'Regrouping…' : 'Regroup'}</button>
        <button class="btn-primary" data-commitall ${commitable.length && !cs.busy && !cs.grouping ? '' : 'disabled'}>${commitable.length > 1 ? `Commit all ${commitable.length}` : 'Commit'}</button>
      </div>
    </div>
    ${cs.error ? `<div class="cm-banner is-error"><span>${esc(cs.error)}</span></div>` : ''}
    ${groups.map((g) => card(g, cs.groups.indexOf(g))).join('')}`);
}

// Redraws that would change nothing leave the page alone, so animations in flight keep going.
// The banner's animations pick up from where they were if it does get redrawn.
let painted = '', paintedNode = null;
function paintHost(html) {
  if (html !== painted || !paintedNode || host.firstElementChild !== paintedNode) { host.innerHTML = html; painted = html; paintedNode = host.firstElementChild; }
  const b = host.querySelector('.cm-banner');
  if (b && cs.banner?.t) b.style.setProperty('--fx-t', `${-(Date.now() - cs.banner.t)}ms`);
}

// ---------- actions ----------
// Writing messages: one group, or many in a row. Leaves messages you typed alone unless you ask.
async function rewrite(g, asked = false) {
  if (!g || cs.writing.has(g.id)) return;
  const files = g.files.filter((p) => isOn(g, p)).map((p) => viewOf(g, p)).filter(Boolean);
  if (!files.length) return;
  cs.writing.add(g.id); draw();
  try {
    const again = asked && g.source && g.source !== 'rules';
    // staged's own message is kept as a draft for the model to improve on.
    if (!g.draft && (!g.source || g.source === 'guess' || g.source === 'rules')) g.draft = g.gitmoji;
    const m = await ai.write({ repo: cs.repo, files, engine: cs.engine, again, draft: g.draft || '', ties: g.ties || [] });
    if (!cs.groups.includes(g)) return;
    Object.assign(g, { type: m.type || g.type, scope: m.scope ?? g.scope, emoji: m.emoji || g.emoji, conventional: m.conventional || g.conventional, gitmoji: m.gitmoji || g.gitmoji, body: m.body ?? g.body, source: m.source, edited: null, aiDone: true });
    if (m.title && /^(New changes|Everything|New commit)$/.test(g.title)) g.title = m.title;
    if (asked || m.source !== 'rules') sfxWrote();
  } catch (e) {
    if (asked) toast(`Couldn't write it: ${e.message}`);
  } finally {
    cs.writing.delete(g.id); draw();
    host?.querySelector(`[data-group="${CSS.escape(g.id)}"] .cm-subject`)?.classList.add('is-fresh');
  }
}
async function writeMany(groups, asked) {
  for (const g of groups) { if (asked || (g.edited == null && !g.aiDone)) await rewrite(g, asked); }
}
// Re-run Commit Compass against the current working tree and replace the proposed groups.
async function regroup() {
  if (cs.grouping || cs.busy || !cs.repo) return;
  cs.grouping = true; draw();
  try {
    const data = await api(`/api/changes?repo=${encodeURIComponent(cs.repo)}`);
    if (cs.repo !== data.repo) return;
    cs.data = data;
    cs.files = new Map(data.files.map((file) => [file.path, file]));
    adoptGroups(data.groups);
    cs.off.clear(); cs.hunksOff.clear();
    toast(`Regrouped into ${data.groups.length} suggested commit${data.groups.length === 1 ? '' : 's'}`);
  } catch (error) {
    toast(`Couldn't regroup: ${error.message}`);
  } finally {
    cs.grouping = false; draw();
  }
}

async function discard(what, el) {
  await discardOut(el);
  return run('discard', async () => {
    const r = await api(`/api/changes/discard?repo=${encodeURIComponent(cs.repo)}`, what);
    const names = [...(what.files || []), ...Object.keys(what.partial || {})].map((p) => p.split('/').pop());
    const label = what.partial && !what.files?.length && names.length === 1 ? `${Object.values(what.partial)[0].length > 1 ? 'chunks' : 'a chunk'} of ${names[0]}` : names.length === 1 ? names[0] : `${r.discarded} files`;
    if (cs.banner?.kind !== 'commit' && cs.banner?.kind !== 'pushed') cs.banner = null;
    toast(`Discarded ${label}`, { action: 'Undo', onAction: undoDiscard });
  });
}
// Brings back the last discard, from the toast's Undo.
function undoDiscard() {
  return run('undo', async () => {
    const r = await api(`/api/changes/discard-undo?repo=${encodeURIComponent(cs.repo)}`, {});
    toast(`Brought back ${r.restored} file${r.restored > 1 ? 's' : ''}`);
  });
}

const groupById = (id) => cs.groups.find((g) => g.id === id);

async function commitGroup(g) {
  const picked = g.files.filter((p) => isOn(g, p));
  const whole = [], partial = {};
  for (const p of picked) {
    const ids = pickedHunks(g, p).map((h) => h.id);
    if (allHunks(p).length && ids.length < allHunks(p).length) partial[p] = ids;
    else whole.push(p);
  }
  const message = messageFor(g);
  const res = await api(`/api/changes/commit?repo=${encodeURIComponent(cs.repo)}`, { files: whole, partial, message });
  // whole files leave the group; partly committed files stay with their remaining chunks
  // chunks you left unticked stay here; the file's other chunks stay with their own commits
  for (const p of Object.keys(partial)) {
    const left = ownedHunks(g, p).filter((h) => !partial[p].includes(h.id)).map((h) => h.id);
    const elsewhere = cs.groups.some((x) => x !== g && x.files.includes(p));
    if (!left.length) { partial[p] = null; if (g.hunks) delete g.hunks[p]; }
    else if (elsewhere) (g.hunks ||= {})[p] = left;
    const off = cs.hunksOff.get(p);
    if (off) { for (const id of ownedHunks(g, p).map((h) => h.id)) if (!left.includes(id)) off.delete(id); if (!off.size) cs.hunksOff.delete(p); }
  }
  g.files = g.files.filter((p) => (cs.off.has(p) && !isSplit(g, p)) || partial[p]);
  return { sha: res.sha, subject: message.split('\n')[0], n: picked.length };
}

async function warnOk(groups) {
  const highs = groups.flatMap((g) => g.files.filter((p) => isOn(g, p)).flatMap((p) => (cs.files.get(p)?.warnings || []).filter((w) => w.level === 'high').map((w) => `<li><b>${esc(p)}</b> ${esc(w.text)}</li>`)));
  if (!highs.length) return true;
  return confirmDialog({ title: 'Commit anyway?', text: `These look risky to commit:<ul class="warn-list">${highs.join('')}</ul>Untick them to leave them out.`, ok: 'Commit anyway', danger: true });
}

function reviewAll() {
  const order = cs.groups.filter((x) => x.files.some((p) => isOn(x, p)));
  const m = modal({
    title: `Review ${order.length} commits`,
    wide: true,
    body: `<p class="note" style="margin:0 0 12px">They'll be made top to bottom. Drag to reorder, or merge one into the commit above it.</p><ol class="rv-list"></ol>`,
    actions: `<button class="text-btn bordered" data-cancel>Cancel</button><button class="btn-primary" data-go>Create commits</button>`,
  });
  const listEl = m.el.querySelector('.rv-list');
  const paint = () => {
    listEl.innerHTML = order.map((g, i) => {
      const n = g.files.filter((p) => isOn(g, p)).length;
      return `<li class="rv-item" draggable="true" data-i="${i}">
        <span class="rv-grip" aria-hidden="true">${icon('DragDropVertical', 16)}</span>
        <span class="cm-num mono">${i + 1}</span>
        <span class="rv-main"><span class="rv-subj">${esc(subjectFor(g))}</span><span class="mono muted">${n} file${n > 1 ? 's' : ''}</span></span>
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
        cs.banner = { kind: 'commit', html: `Made ${done.length} commit${done.length > 1 ? 's' : ''}: ${done.map((r) => `<span class="mono muted">${r.sha.slice(0, 7)}</span> ${esc(r.subject)}`).join(' · ')}`, undo: done.length === 1, push: true };
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
    for (const g of cs.groups) if (g.edited != null && g.editedFormat !== f) g.edited = null;
    cs.format = f; store.format = f; save(); return draw();
  }
  if ((b = t('[data-emoji]'))) { const g = groupById(b.dataset.emoji); return emojiPicker(b, { current: g.emoji, type: g.type, suggested: g.emojiSuggestions, onPick: (e, type) => { g.emoji = e; if (type !== 'revert' && g.edited == null) { g.type = type; fetch(`/api/changes/learn-style?repo=${encodeURIComponent(cs.repo)}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-changes': '1' }, body: JSON.stringify({ type, emoji: e }) }).catch(() => {}); } draw(); } }); }
  if ((b = t('[data-chunks]'))) return togglePanel(cs.hunkOpen, b.dataset.chunks, b);
  if ((b = t('[data-diff]'))) return togglePanel(cs.open, b.dataset.diff, b);
  if ((b = t('[data-addbody]'))) {
    const id = b.dataset.addbody;
    if (cs.bodyOpen.has(id)) { cs.bodyOpen.delete(id); return draw(); }
    cs.bodyOpen.add(id); draw(); return host.querySelector(`[data-body="${CSS.escape(id)}"]`)?.focus();
  }
  if ((b = t('[data-reset]'))) { groupById(b.dataset.reset).edited = null; return draw(); }
  if ((b = t('[data-dismiss]'))) { cs.banner = null; return draw(); }
  if ((b = t('[data-write]'))) return rewrite(groupById(b.dataset.write), true);
  if ((b = t('[data-regroup]'))) return regroup();
  if ((b = t('[data-clear]'))) {
    const g = groupById(b.dataset.clear);
    g.edited = ''; g.editedFormat = cs.format; g.body = ''; draw();
    const inp = host.querySelector(`[data-subject="${CSS.escape(g.id)}"]`);
    inp?.focus();
    return;
  }
  if ((b = t('[data-discard]'))) {
    const g = groupById(b.dataset.g), p = b.dataset.discard;
    return discard(g && isSplit(g, p) ? { partial: { [p]: g.hunks[p] } } : { files: [p] }, b.closest('.cm-file'));
  }
  if ((b = t('[data-discardhunk]'))) { e.preventDefault(); return discard({ partial: { [b.dataset.discardhunk]: [b.dataset.hid] } }, b.closest('.cm-chunk')); }
  if ((b = t('[data-discardgroup]'))) {
    if (e.detail !== 0) return; // a mouse or finger holds instead; see onHold
    const g = groupById(b.dataset.discardgroup);
    const files = g.files.filter((p) => cs.files.has(p));
    return confirmDialog({ title: `Discard ${files.length} file${files.length > 1 ? 's' : ''}?`, text: `Your changes to ${files.length > 1 ? 'these files' : esc(files[0])} go away. You can undo it right after, from the note at the bottom.`, ok: 'Discard', danger: true })
      .then((go) => go && discard(discardWhat(g), host.querySelector(`[data-group="${CSS.escape(g.id)}"]`)));
  }
  if ((b = t('[data-undodiscard]'))) return undoDiscard();
  if ((b = t('[data-commit]'))) {
    const g = groupById(b.dataset.commit);
    return warnOk([g]).then((go) => {
      if (!go) return;
      const land = commitFold(host.querySelector(`[data-group="${CSS.escape(g.id)}"]`));
      return run(g.id, async () => {
        const r = await commitGroup(g);
        cs.banner = { html: `Committed <b>${esc(r.subject)}</b> <span class="mono muted">${r.sha.slice(0, 7)} · ${r.n} file${r.n > 1 ? 's' : ''}</span>`, undo: true, push: true, kind: 'commit' };
      }).then(() => land(cs.banner?.kind === 'commit' ? host.querySelector('.cm-banner .cm-dot') : false));
    });
  }
  if ((b = t('[data-commitall]'))) {
    const order = cs.groups.filter((x) => x.files.some((p) => isOn(x, p)));
    if (order.length > 1) return reviewAll();
    const g = order[0];
    return warnOk([g]).then((go) => {
      if (!go) return;
      const land = commitFold(host.querySelector(`[data-group="${CSS.escape(g.id)}"]`));
      return run(g.id, async () => {
        const r = await commitGroup(g);
        cs.banner = { html: `Committed <b>${esc(r.subject)}</b> <span class="mono muted">${r.sha.slice(0, 7)}</span>`, undo: true, push: true, kind: 'commit' };
      }).then(() => land(cs.banner?.kind === 'commit' ? host.querySelector('.cm-banner .cm-dot') : false));
    });
  }
  if ((b = t('[data-pushnow]'))) {
    const n = (cs.banner?.html.match(/Made (\d+) commit/) || [])[1] || 1;
    b.classList.add('is-pushing');
    return run('push', async () => {
      await Promise.all([api(`/api/x/push?repo=${encodeURIComponent(cs.repo)}`, {}), pushLaunch(host.querySelector('[data-pushnow]') || b, +n)]);
      cs.banner = { html: `Pushed to ${esc(ctx.host?.name || 'your remote')}. You're all caught up.`, kind: 'pushed' };
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
  remember();
}

function onChange(e) {
  const el = e.target;
  if (el.dataset.file) {
    const g = groupById(el.dataset.g), p = el.dataset.file;
    if (g && isSplit(g, p)) {
      const set = cs.hunksOff.get(p) || new Set();
      for (const h of ownedHunks(g, p)) el.checked ? set.delete(h.id) : set.add(h.id);
      set.size ? cs.hunksOff.set(p, set) : cs.hunksOff.delete(p);
    } else el.checked ? cs.off.delete(p) : cs.off.add(p);
    return draw();
  }
  if (el.dataset.hunk) {
    const p = el.dataset.hunk;
    const set = cs.hunksOff.get(p) || new Set();
    el.checked ? set.delete(el.dataset.hid) : set.add(el.dataset.hid);
    const g = groupById(el.dataset.g);
    if (!g || !isSplit(g, p)) {
      const total = allHunks(p).length;
      if (set.size >= total) { set.clear(); cs.off.add(p); } // nothing picked: leave the file out
      else cs.off.delete(p);
    }
    set.size ? cs.hunksOff.set(p, set) : cs.hunksOff.delete(p);
    return draw();
  }
  if (el.dataset.move) {
    const p = el.dataset.move, to = el.value;
    if (!to) return;
    const from = groupById(el.dataset.g) || cs.groups.find((g) => g.files.includes(p));
    let dest = groupById(to);
    if (to === '__new') {
      const f = cs.files.get(p);
      dest = { id: 'n' + Date.now(), title: 'New commit', why: '', type: 'chore', scope: '', emoji: '🔧', conventional: `update ${p.split('/').pop()}`, gitmoji: `Updated ${p.split('/').pop()}`, body: '', files: [], edited: null };
      if (f?.status === 'A') Object.assign(dest, { type: 'feat', emoji: '✨', conventional: `add ${p.split('/').pop()}`, gitmoji: `Added ${p.split('/').pop()}` });
      cs.groups.push(dest);
    }
    const learnTo = dest.files.filter((x) => x !== p);
    give(from, dest, p);
    cs.groups = cs.groups.filter((g) => g.files.length);
    draw();
    // remember this correction for next time
    fetch(`/api/changes/learn?repo=${encodeURIComponent(cs.repo)}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-changes': '1' }, body: JSON.stringify({ file: p, from: from.files, to: learnTo }) }).catch(() => {});
    toast('Moved. It will remember this next time.');
  }
}
