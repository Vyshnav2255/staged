import { icon } from './icons.js';
import { commitFold, discardOut } from './fx.js';
import { pickEmoji as emojiPicker } from './emoji.js';
import { sfxTick, sfxLand, sfxDrain, sfxApproved, sfxLaser, sfxStamp, sfxTear, sfxBeeps } from './sfx.js';
import { confirmDialog, toast, ago, api } from './ui.js';
import { shareSpec } from './receipt-image.js';
import { MARK, specHtml, receiptSpec, statementSpec, compareUrl, logPush, weekOf } from './receipt.js';
const LEAD = /^\s*(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\uFE0F|\u200D)+\s*/u;

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
// Message style is per project: your pick for this repo, else the style its history already uses
// (conventional or plain), else your default from Settings.
export function learnedStyle(repo) { return cs.repo === repo ? cs.data?.grouping?.style?.format : undefined; }
// Project settings changed this repo's style: re-read it and redraw the cards.
export function applyStyle(repo) {
  try { store = JSON.parse(localStorage.getItem('changes.commit') || '{}'); } catch {}
  if (cs.repo !== repo) return;
  cs.format = formatFor(repo, learnedStyle(repo));
  for (const g of cs.groups) if (g.edited != null && g.editedFormat !== cs.format) g.edited = null;
  if (host && !host.hidden) draw();
}
function formatFor(repo, learned) {
  const own = store.formats?.[repo];
  if (own) return own;
  if (learned === 'conventional' || learned === 'plain') return learned;
  return store.format || 'gitmoji';
}

const cs = {
  repo: null, data: null, groups: [], files: new Map(), off: new Set(), open: new Set(), bodyOpen: new Set(),
  busy: null, error: '', banner: null, format: store.format || 'gitmoji', loading: false, hunksOff: new Map(), hunkOpen: new Set(),
  grouping: false,
  // The side panel: reviewing a batch before it's made, making it, then everything waiting to be pushed.
  panel: { mode: null, order: [], state: new Map(), pushed: null, fresh: null },
};
let host = null, ctx = null;


function subjectFor(g, format = cs.format) {
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

// Each repo's plan (groups, messages, your edits, unticked files) is kept, so
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

async function loadChanges(repo, { keep } = {}) {
  const same = cs.repo === repo;
  cs.repo = repo;
  cs.loading = !same || !cs.data;
  if (!same) { cs.data = null; cs.groups = []; cs.off.clear(); cs.open.clear(); cs.bodyOpen.clear(); cs.hunksOff.clear(); cs.hunkOpen.clear(); cs.panel = { mode: null, order: [], state: new Map(), pushed: null, fresh: null }; cs.banner = null; cs.error = ''; }
  draw();
  try {
    const data = await api(`/api/changes?repo=${encodeURIComponent(repo)}`);
    if (cs.repo !== repo) return;
    cs.data = data;
    if (pd.repo === repo) Object.assign(pd, { branch: data.branch, canUndo: data.canUndo, outgoing: data.outgoing, at: Date.now() });
    cs.format = formatFor(repo, data.grouping?.style?.format);
    cs.files = new Map(data.files.map((f) => [f.path, f]));
    let restored = false;
    if (keep && cs.groups.length) mergeFiles(data.files);
    else if (!(restored = restore(repo, data.files))) adoptGroups(data.groups);
    cs.error = '';
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
  if (!host.dataset.holdBound) { host.addEventListener('pointerdown', onHold); host.addEventListener('pointerdown', dragStart); host.dataset.holdBound = '1'; }
  try { store = JSON.parse(localStorage.getItem('changes.commit') || '{}'); } catch {}
  cs.format = formatFor(ctx.repo, cs.repo === ctx.repo ? cs.data?.grouping?.style?.format : undefined);
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
  paintPanel();
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
  const key = g.id + '|' + p; // a file split across commits opens per card, not everywhere it appears
  const open = cs.open.has(key);
  const all = f.hunks || [];
  const hk = ownedHunks(g, p);
  const split = isSplit(g, p);
  const offH = cs.hunksOff.get(p) || new Set();
  const offN = hk.filter((h) => offH.has(h.id)).length;
  const v = viewOf(g, p);
  const hOpen = cs.hunkOpen.has(key);
  const warn = (f.warnings || []);
  const moved = cs.justMoved === p + '|' + g.id;
  return `<div class="cm-file ${on ? '' : 'is-off'} ${moved ? 'is-moved' : ''}" data-row="${esc(p)}" data-g="${esc(g.id)}">
    <button class="cm-grip" data-moveopen="${esc(p)}" data-g="${esc(g.id)}" aria-haspopup="menu" title="Drag to another commit, or click to pick one" aria-label="Move ${esc(base)} to another commit"><i></i></button>
    <label class="cm-check" title="${on ? 'Leave out of this commit' : 'Include in this commit'}"><input type="checkbox" data-file="${esc(p)}" data-g="${esc(g.id)}" ${on ? 'checked' : ''}><span></span></label>
    <span class="cm-status s-${f.status}" title="${STATUS[f.status] || f.status}${f.untracked ? ' (new file)' : ''}">${f.status}</span>
    <button class="cm-path" data-diff="${esc(p)}" data-g="${esc(g.id)}" aria-expanded="${open}" title="${esc(f.from ? `${f.from} → ${p}` : p)}"><span class="dir">${esc(dirn)}</span>${esc(base)}</button>
    <span class="cm-extra">
      ${warn.map((w) => `<span class="chip ${w.level === 'high' ? 'is-bad' : w.level === 'mid' ? 'is-warn' : ''}" title="${esc(w.text)}">${icon('Alert02', 12)}${esc(w.text)}</span>`).join('')}
      ${hk.length && (all.length > 1 || split) ? `<button class="chip is-btn ${offN || split ? 'is-on' : ''}" data-chunks="${esc(p)}" data-g="${esc(g.id)}" aria-expanded="${hOpen}" title="${split ? `This commit takes ${hk.length} of the file's ${all.length} chunks; the rest are in other commits. Click to pick.` : 'Pick which chunks of this file go in'}">${split || offN ? `${hk.length - offN} of ${all.length} chunks` : `${all.length} chunks`}</button>` : ''}
      <span class="lines mono">${f.binary ? '<span class="muted">binary</span>' : `<span class="a">+${compact(v.add)}</span> <span class="d">−${compact(v.del)}</span>`}</span>
    </span>
    <button class="cm-discard" data-discard="${esc(p)}" data-g="${esc(g.id)}" title="Discard ${split ? 'these chunks of' : 'changes to'} ${esc(base)}" aria-label="Discard changes to ${esc(base)}">${icon('Delete02', 14)}</button>
  </div>
  ${hOpen && hk.length ? fresh(chunkView(f, offH, g), key) : ''}
  ${open && !hOpen ? fresh(diffView(v), key) : ''}`;
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
    return `<div class="cm-chunk ${on ? '' : 'is-off'}">
      <label class="cm-chunk-head"><span class="cm-check"><input type="checkbox" data-hunk="${esc(f.path)}" data-g="${esc(g.id)}" data-hid="${h.id}" ${on ? 'checked' : ''}><span></span></span>
        <span class="mono">Chunk ${i + 1}</span><span class="mono muted">${esc(h.head.replace(/^@@[^@]*@@\s?/, '') || 'line ' + (h.head.match(/\+(\d+)/) || [])[1])}</span>
        <span class="lines mono"><span class="a">+${h.add}</span> <span class="d">−${h.del}</span></span>
        <button class="cm-discard" data-discardhunk="${esc(f.path)}" data-hid="${h.id}" title="Discard this chunk" aria-label="Discard chunk ${i + 1}">${icon('Delete02', 13)}</button></label>
      <div class="cm-dv mono">${diffRows([h.head, ...h.lines], { heads: false, max: 40 })}</div>
    </div>`;
  }).join('')}</div>`;
}

// A diff as rows: old and new line numbers, the sign, then the code. Long lines wrap instead of scrolling sideways.
function diffRows(lines, { heads = true, max = 400 } = {}) {
  let o = 0, n = 0, out = '', shown = 0;
  for (const l of lines) {
    if (l.startsWith('@@')) {
      const m = l.match(/-(\d+)(?:,\d+)?\s+\+(\d+)/); if (m) { o = +m[1]; n = +m[2]; }
      if (heads) out += `<div class="dl h"><span>From line ${n}</span></div>`;
      continue;
    }
    if (l.startsWith('\\') || (shown >= max)) continue;
    const k = l[0] === '+' ? 'a' : l[0] === '-' ? 'd' : '';
    const on = k === 'a' ? '' : o++, nn = k === 'd' ? '' : n++;
    out += `<div class="dl ${k}"><i>${on}</i><i>${nn}</i><b>${k === 'a' ? '+' : k === 'd' ? '−' : ''}</b><code>${esc(l.slice(1)) || ' '}</code></div>`;
    shown++;
  }
  const more = lines.filter((l) => !l.startsWith('@@')).length - shown;
  return out + (more > 0 ? `<div class="dl h"><span>${more} more line${more > 1 ? 's' : ''}</span></div>` : '');
}
function diffView(f) {
  if (f.binary) return `<div class="cm-diff cm-dv is-note">Binary file${f.bytes ? ` · ${compact(Math.round(f.bytes / 1024))} KB` : ''}</div>`;
  if (!f.diff) return `<div class="cm-diff cm-dv is-note">No text changes</div>`;
  return `<div class="cm-diff cm-dv mono">${diffRows(f.diff.replace(/\n$/, '').split('\n'))}</div>`;
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
  // The description is optional, so it stays tucked away until asked for.
  const bodyOpen = cs.bodyOpen.has(g.id), hasBody = !!(g.body || '').trim();
  return `<section class="cm-card" data-drop="${esc(g.id)}" data-group="${esc(g.id)}">
    <header class="cm-head">
      <div class="cm-subject ${long ? 'is-long' : ''} ${cs.format === 'gitmoji' || cs.format === 'both' ? 'has-emoji' : ''}">
        ${cs.format === 'gitmoji' || cs.format === 'both' ? `<button class="cm-emoji" data-emoji="${esc(g.id)}" title="Pick a gitmoji">${esc(g.emoji || '✨')}</button>` : ''}
        <input data-subject="${esc(g.id)}" value="${esc(cs.format === 'conventional' ? subj : subj.replace(LEAD, ''))}" spellcheck="true" aria-label="Commit message" placeholder="Write your own message" title="Click to edit the message">
        <span class="cm-subj-tools"><span class="cm-count mono" title="Keep the first line under 72 characters">${subj.length >= 60 ? subj.length : ''}</span></span>
      </div>
      <span class="cm-head-tools">
        ${g.review ? `<span class="cm-badge is-review" title="staged isn't sure these files belong together">Check grouping</span>` : ''}
        ${g.edited != null ? `<button class="text-btn" data-reset="${esc(g.id)}" title="Go back to the suggested message">Reset</button>` : ''}
        <button class="icon-btn sm cm-more" data-more="${esc(g.id)}" aria-haspopup="menu" title="More" aria-label="More for this commit">${icon('MoreHorizontal', 15)}</button>
        <button class="${cs.groups.length > 1 ? 'btn-secondary' : 'btn-primary'} cm-add" data-commit="${esc(g.id)}" ${picked.length && !cs.busy ? '' : 'disabled'} title="Commit this and put it in the cart">${icon('ShoppingCartAdd01', 15)}<span>Add to cart</span></button>
      </span>
    </header>
    ${files.length > 1 ? `<p class="cm-sub mono">${picked.length < files.length ? `${picked.length} of ${files.length} files` : `${files.length} file${files.length > 1 ? 's' : ''}`} · <span class="a">+${compact(add)}</span> <span class="d">−${compact(del)}</span></p>` : ''}
    ${g.review && g.why && !/^grouped by/i.test(g.why) ? `<p class="cm-why">${esc(g.why)}</p>` : ''}
    ${highs.length ? `<div class="cm-alert">${icon('Alert02', 14)}<span>Heads up: ${esc(highs.slice(0, 2).join('; '))}${highs.length > 2 ? ` and ${highs.length - 2} more` : ''}.</span></div>` : ''}
    ${bodyOpen ? `<div class="cm-msg"><textarea data-body="${esc(g.id)}" rows="${Math.min(8, Math.max(2, (g.body || '').split('\n').length))}" placeholder="Optional description: what changed and why">${esc(g.body || '')}</textarea></div>` : ''}
    <div class="cm-files">${files.map((p) => fileRow(p, g)).join('')}</div>
  </section>`;
}

const clip = (t, n) => (t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t);

function draw() {
  remember();
  if (!host || !ctx || ctx.view !== 'commit' || ctx.repo === 'all') return paintPanel();
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
      <span>${cs.banner.html}</span>
      ${cs.banner.undoDiscard && d.canUndoDiscard ? `<button class="text-btn bordered" data-undodiscard>${icon('Undo02', 14)}Bring back</button>` : ''}
      <button class="text-btn" data-dismiss aria-label="Dismiss">${icon('Cancel01', 14)}</button>
    </div>` : '';

  paintPanel();
  // The Commit tab's badge: how many commits are ready, once they are sorted.
  { const dc = document.getElementById('dirtyCount'); if (dc && ctx.repo) { dc.dataset.repo = ctx.repo; dc.classList.toggle('is-dot', false); dc.textContent = total ? String(cs.groups.length) : ''; } }
  if (!total) {
    paintHost(banner + (outgoing().length ? `<div class="empty cm-done">${icon('ShoppingCartCheck01', 18)}<h3>Everything is in the cart</h3><p>Hold to push when you're ready.</p></div>` : `<div class="empty"><h3>Nothing to commit</h3><p>${esc(ctx.repo)} is clean on ${esc(d.branch)}.</p></div>`));
    return;
  }

  paintHost(`${banner}
    <div class="cm-bar">
      <div class="cm-summary">
        <h2>${cs.groups.length} commit${cs.groups.length > 1 ? 's' : ''} ready</h2>
        <p class="mono">${total} changed file${total > 1 ? 's' : ''} · <span class="a">+${compact(add)}</span> <span class="d">−${compact(del)}</span>${cs.grouping ? ' · sorting…' : ''}</p>
      </div>
      <div class="cm-tools">
        <button class="text-btn bordered cm-regroup" data-regroup ${cs.busy || cs.grouping ? 'disabled' : ''} title="Sort the changes into commits again">${icon('MagicWand01', 14)}<span>Sort again</span></button>
        ${cs.groups.length > 1 ? `<button class="btn-primary cm-addall" data-commitall ${commitable.length && !cs.busy && !cs.grouping ? '' : 'disabled'}>${icon('ShoppingCartAdd01', 15)}<span>Add all ${commitable.length} to cart</span></button>` : ''}
      </div>
    </div>
    ${cs.error ? `<div class="cm-banner is-error"><span>${esc(cs.error)}</span></div>` : ''}
    <div class="cm-list">${groups.map((g) => card(g, cs.groups.indexOf(g))).join('')}<div class="cm-newdrop" data-drop="__new">${icon('Add01', 14)}Drop here for a new commit</div></div>`);
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
// Re-run the engine against the current working tree and replace the proposed groups.
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
    cs.banner = null;
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
  const P = cs.panel;
  P.mode = 'review'; P.order = cs.groups.filter((x) => x.files.some((p) => isOn(x, p))); P.state = new Map(); closedRepos.delete(cs.repo); P.pushed = null;
  paintPanel(true);
}
async function makeAll() {
  const P = cs.panel, order = P.order;
  if (!(await warnOk(order))) return;
  // keep the main list in the reviewed order too
  cs.groups = [...order, ...cs.groups.filter((g) => !order.includes(g))];
  P.mode = 'run'; P.shaOf = new Map();
  // committing empties g.files, so keep the counts the rows show
  P.count = new Map(order.map((g) => [g.id, g.files.filter((p) => isOn(g, p)).length]));
  paintPanel();
  await run('all', async () => {
    for (const [i, g] of order.entries()) {
      P.state.set(g.id, 'busy'); paintPanel();
      const r = await commitGroup(g);
      // each one ticks with a note a step higher than the last, so a batch plays a little run
      P.state.set(g.id, 'done'); P.tick = g.id; P.shaOf.set(g.id, r.sha); paintPanel(); P.tick = null;
      if (!calm()) sfxTick(i);
      if (!calm()) await new Promise((ok) => setTimeout(ok, 180));
    }
    if (!calm()) await new Promise((ok) => setTimeout(ok, 380));
  });
  // The rows you just made turn into the commits waiting to push, gliding to their new places.
  P.mode = null; P.order = []; P.state = new Map();
  paintPanel();
  if (!calm()) setTimeout(sfxLand, 120);
}

// ---------- side panel ----------
// Docked on the right, not a dialog: the commits you're about to make, then every commit that is
// waiting to be pushed (not just the last one), and once they're pushed it empties and goes away.
// It isn't tied to the Commit tab: while a repo has commits to push, the panel stays docked on every
// view of that repo, and swaps to the next repo's commits when you switch. Closing it hides it for
// that repo until you open it again from the "N to push" button in the header.
let panelEl = null;
const pd = { repo: null, branch: '', canUndo: false, outgoing: null, at: 0 };
const closedRepos = new Set();
let route = { repo: null, view: null }, onPushed = null;
const NO_PANEL = ['readme', 'settings'];
const onRepoView = () => !!route.repo && route.repo !== 'all' && !NO_PANEL.includes(route.view) && pd.repo === route.repo;
// Practice cart: sample commits you can hold-to-push for real feel, with nothing committed or pushed.
let demo = null;
const cartKey = () => (demo ? '__practice' : route.repo);
const outgoing = () => (demo ? demo.items : onRepoView() ? pd.outgoing?.commits || [] : []);
export function practiceCart() {
  const now = Date.now(), sha = () => [...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, '0')).join('');
  demo = { items: [
    { subject: '🐛 Fixed the sidebar moving with scroll', files: 1, add: 4, del: 2, at: now - 60000 },
    { subject: '💄 Gave the cart a printed receipt', files: 2, add: 86, del: 3, at: now - 240000 },
    { subject: '✨ Added hold to push', files: 3, add: 112, del: 18, at: now - 600000 },
  ].map((c) => ({ ...c, sha: sha() })) };
  cs.panel.pushed = null; cs.panel.lastN = 3;
  paintPanel(true);
}
const onCommitView = () => onRepoView() && route.view === 'commit' && !!host?.isConnected && ctx?.view === 'commit' && cs.repo === route.repo;
// A printed sheet: this repo's push receipt, or the weekly statement (which can show anywhere).
let stmt = null;
const curSheet = () => stmt || (cs.panel.pushed?.repo === cartKey() ? cs.panel.pushed : null);
export async function openStatement() {
  let pushes = null;
  try { pushes = (await api(`/api/changes/pushes?since=${weekOf().start}`)).pushes; } catch {}
  const fresh = !panelEl;
  stmt = { id: 's' + Date.now(), spec: statementSpec(pushes), printed: false };
  paintPanel(fresh);
}
const panelOpen = () => !!(stmt || demo || ((cs.panel.mode && onCommitView()) || (cs.panel.pushed && cs.panel.pushed.repo === route.repo)) || (outgoing().length && !closedRepos.has(route.repo)));
export function setPanelRoute(r, pushed) {
  onPushed = pushed;
  const was = route.repo;
  route = { repo: r.repo, view: r.view, remote: r.remote || '', provider: r.provider || '' };
  if (was !== r.repo && !cs.panel.pushed && cs.panel.mode !== 'run') { cs.panel.mode = null; cs.panel.order = []; }
  if (r.repo && r.repo !== 'all' && !NO_PANEL.includes(r.view)) {
    if (pd.repo !== r.repo) Object.assign(pd, { repo: r.repo, branch: '', canUndo: false, outgoing: null, at: 0 });
    if (Date.now() - pd.at > 4000) refreshOutgoing();
  }
  paintPanel();
}
export function openPanel() { closedRepos.delete(route.repo); paintPanel(true); if (onCommitView()) draw(); }
async function refreshOutgoing() {
  const repo = pd.repo; pd.at = Date.now();
  try {
    const d = await api(`/api/changes/outgoing?repo=${encodeURIComponent(repo)}`);
    if (pd.repo !== repo) return;
    Object.assign(pd, { branch: d.branch, canUndo: d.canUndo, outgoing: d.outgoing, at: Date.now() });
  } catch {}
  paintPanel();
}
// The panel and the page move together on one curve: it slides in from the edge while the page
// makes room, and slides back out while the page settles. Rows keep their place across redraws
// (FLIP), so a new commit pushes the others down instead of the list blinking.
const SLIDE = 'cubic-bezier(0.32, 0.72, 0, 1)';
let lastMode = '';
function landTarget() {
  const dot = panelEl?.querySelector('.cmp-item .cmp-dot');
  if (!dot) return null;
  // While the panel is still sliding in, aim for where the dot will be, not where it is now.
  return { isConnected: true, getBoundingClientRect() {
    const r = dot.getBoundingClientRect();
    const dx = panelEl ? document.documentElement.clientWidth - panelEl.offsetWidth - panelEl.getBoundingClientRect().left : 0;
    return new DOMRect(r.left + dx, r.top, r.width, r.height);
  } };
}
function paintPanel(animate = false) {
  const show = stmt || demo || (onRepoView() && pd.outgoing && panelOpen());
  document.body.classList.toggle('has-cmp', !!show);
  if (!show) {
    lastMode = '';
    if (panelEl && !panelEl.classList.contains('is-leaving')) {
      const el = panelEl; panelEl = null;
      if (calm()) el.remove();
      else { el.classList.add('is-leaving'); setTimeout(() => el.remove(), 440); }
    }
    return;
  }
  if (!panelEl) {
    panelEl = document.createElement('aside');
    panelEl.className = 'cmp';
    panelEl.setAttribute('aria-label', 'Commits');
    panelEl.addEventListener('click', onPanelClick);
    panelEl.addEventListener('dragstart', onPanelDrag);
    panelEl.addEventListener('dragover', onPanelDrag);
    panelEl.addEventListener('drop', onPanelDrag);
    panelEl.addEventListener('dragend', onPanelDrag);
    panelEl.addEventListener('pointerdown', (e) => { const b = e.target.closest('[data-cmp-push]'); if (b && e.button === 0) { e.preventDefault(); b.focus(); startCharge(b); } });
    panelEl.addEventListener('keydown', (e) => { const b = e.target.closest('[data-cmp-push]'); if (b && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); if (!e.repeat) startCharge(b); } });
    // Reorder from the keyboard: Alt + up or down on a focused row.
    panelEl.addEventListener('keydown', (e) => {
      const li = e.target.closest?.('.cmp-item[draggable="true"]'); if (!li || !e.altKey || !/^Arrow(Up|Down)$/.test(e.key)) return;
      const i = +li.dataset.i, j = i + (e.key === 'ArrowUp' ? -1 : 1); if (j < 0 || j >= P.order.length) return;
      e.preventDefault(); [P.order[i], P.order[j]] = [P.order[j], P.order[i]]; paintPanel();
      panelEl.querySelector(`.cmp-item[data-i="${j}"]`)?.focus();
    });
    panelEl.addEventListener('keyup', (e) => { if ((e.key === ' ' || e.key === 'Enter') && charge) charge.finish(false); });
    document.body.appendChild(panelEl);
    animate = true;
  }
  const P = cs.panel, out = outgoing(), remote = demo ? true : pd.outgoing?.remote;
  const mode = curSheet() ? 'sheet' : (!demo && onCommitView() && P.mode) || 'out', prevMode = lastMode, switched = !animate && mode !== prevMode;
  lastMode = mode;
  // A printing receipt must not be redrawn halfway through, so later repaints leave it alone.
  if (mode === 'sheet' && prevMode === 'sheet' && panelEl.dataset.rcpt === curSheet().id) return;
  const before = new Map();
  if (!animate) for (const li of panelEl.querySelectorAll('.cmp-item[data-k]')) before.set(li.dataset.k, li.getBoundingClientRect().top);
  const prevProg = P.prog ?? 0;
  let prog = null;
  const branch = esc(demo ? 'practice' : pd.branch || 'HEAD'), upstream = esc(demo ? 'nowhere (practice)' : pd.outgoing?.upstream || 'the remote');
  let title, sub, list, foot = '', body = null;
  const sheet = curSheet();
  if ((P.mode === 'review' || P.mode === 'run') && onCommitView() && !demo) {
    const n = P.order.length, done = [...P.state.values()].filter((x) => x === 'done').length;
    if (P.mode === 'run') prog = n ? done / n : 0;
    title = P.mode === 'run' ? `Adding ${Math.min(done + 1, n)} of ${n} to the cart` : `Add ${n} to the cart`;
    sub = P.mode === 'run' ? 'Hang on, this takes a moment' : '';
    list = P.order.map((g, i) => {
      const k = P.state.get(g.id), files = P.mode === 'run' && P.count?.has(g.id) ? P.count.get(g.id) : g.files.filter((p) => isOn(g, p)).length;
      const mark = k === 'done' ? `<i class="cmp-dot is-done">${icon('Tick02', 11)}</i>` : k === 'busy' ? '<i class="cmp-dot is-busy"></i>' : `<span class="cm-num mono">${i + 1}</span>`;
      return `<li class="cmp-item ${k ? 'is-' + k : ''} ${P.tick === g.id ? 'is-tick' : ''}" ${P.mode === 'review' ? 'draggable="true" tabindex="0" aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown" title="Drag, or Alt + arrow keys, to reorder"' : ''} data-i="${i}" data-k="${esc(P.shaOf?.get(g.id) || g.id)}">
        ${P.mode === 'review' ? `<span class="rv-grip" aria-hidden="true">${icon('DragDropVertical', 14)}</span>` : ''}${mark}
        <span class="cmp-main"><span class="cmp-subj">${esc(subjectFor(g))}</span><span class="mono muted">${files} file${files === 1 ? '' : 's'}</span></span>
        ${P.mode === 'review' ? `<span class="cmp-tools">
          <button class="icon-btn sm" data-cmp-merge="${i}" ${i ? '' : 'disabled'} title="Fold into the commit above" aria-label="Merge into the commit above">${icon('GitMerge', 13)}</button>
        </span>` : ''}
      </li>`;
    }).join('');
    foot = P.mode === 'review'
      ? `<button class="text-btn bordered" data-cmp-cancel>Cancel</button><button class="btn-primary" data-cmp-go>${icon('ShoppingCartAdd01', 15)}Add ${n} to cart</button>`
      : `<button class="btn-primary" disabled>Committing…</button>`;
  } else if (sheet) {
    // Pushed (or a weekly statement): no header, the paper says it all. Just a save and a close,
    // floating in the corner, and the printer the paper comes out of.
    const arrive = sheet.printed ? '' : ' is-arrive';
    body = `<div class="cmp-float">
        <button class="cmp-fbtn" data-rcpt-save title="Save as image">${icon('Image01', 15)}<span>Save image</span></button>
        <button class="cmp-fbtn is-icon" data-cmp-close title="Close" aria-label="Close">${icon('Cancel01', 14)}</button>
      </div>
      <div class="rcpt-wrap ${arrive ? 'is-printing' : ''}"><div class="rcpt-feed">${specHtml(sheet.spec)}</div></div>
      <div class="prn ${arrive ? 'is-on' : ''}" aria-hidden="true"><span class="prn-slot"><i></i></span><span class="prn-face">${MARK.replace('<svg ', '<svg class="prn-mark" ').replace('width="22" height="22"', 'width="14" height="14"')}<span class="prn-name">staged</span><span class="prn-grille"></span><i class="prn-led"></i></span></div>`;
  } else {
    const n = out.length;
    // The panel is your cart: commits drop in as you make them, and pushing is checking out.
    const bump = n > (P.lastN ?? n) ? ' is-bump' : '';
    P.lastN = n;
    title = `Cart<span class="cmp-count${bump}">${n}</span>`;
    sub = remote ? `${branch} → ${upstream}` : `${branch} · no remote yet`;
    const tf = out.reduce((s, c) => s + (c.files || 0), 0), ta = out.reduce((s, c) => s + (c.add || 0), 0), td = out.reduce((s, c) => s + (c.del || 0), 0);
    list = out.map((c, i) => `<li class="cmp-item is-out ${c.sha === P.fresh ? 'is-fresh' : ''}" data-k="${c.sha}">
        <i class="cmp-dot" aria-hidden="true"></i>
        <span class="cmp-main"><span class="cmp-subj" title="${esc(c.subject)}">${esc(c.subject)}</span><span class="mono muted">${c.sha.slice(0, 7)}${c.files ? ` · ${c.files} file${c.files === 1 ? '' : 's'}` : ''} · ${ago(c.at)}</span></span>
        ${i === 0 && c.undo && pd.canUndo && onCommitView() && !demo ? `<button class="text-btn sm" data-cmp-undo ${cs.busy ? 'disabled' : ''} title="Put this commit's changes back">Undo</button>` : ''}
      </li>`).join('');
    // Pushing is a big moment, so it's a hold, not a click: the bar charges, each commit lights up
    // from the oldest, and letting go early drains it back.
    const total = `<div class="cmp-total"><span>Total</span><span class="mono">${tf} file${tf === 1 ? '' : 's'} · <b class="a">+${ta}</b> <b class="d">−${td}</b></span></div>`;
    if (remote) foot = total + (P.pushing
      ? `<button class="btn-primary cmp-push is-pushing is-approved" disabled>${icon('ArrowUp02', 15)}<span class="cmp-lbl">Pushing…</span></button>`
      : `<button class="btn-primary cmp-push" data-cmp-push ${cs.busy ? 'disabled' : ''} aria-label="Hold to push ${n} commit${n === 1 ? '' : 's'}"><i class="cmp-charge" aria-hidden="true"></i><span class="cmp-lbl"><span class="cmp-lbl-idle">Hold to push</span><span class="cmp-lbl-hold">Keep holding…</span></span></button>`);
  }
  const html = `${sheet ? '' : `<header class="cmp-head">
      <div class="cmp-titles"><h3>${title}</h3>${sub ? `<p class="mono">${sub}</p>` : ''}</div>
      ${mode === 'out' ? `<button class="icon-btn sm" data-stmt title="This week's statement" aria-label="This week's statement">${icon('ReceiptText', 15)}</button>` : ''}
      ${P.mode === 'run' ? '' : `<button class="icon-btn sm cmp-x" data-cmp-close aria-label="Close">${icon('Cancel01', 14)}</button>`}
      ${prog != null ? '<i class="cmp-prog" aria-hidden="true"></i>' : ''}</header>`}
    ${body ?? `<ol class="cmp-list scroll-fade">${list}</ol>`}
    ${foot ? `<footer class="cmp-foot">${foot}</footer>` : ''}`;
  // Nothing changed (several refreshes land after a commit): leave the DOM alone so running animations finish.
  if (!animate && !switched && html === panelEl.__html) return;
  panelEl.__html = html;
  panelEl.classList.toggle('is-sheet', !!sheet);
  panelEl.innerHTML = html;
  P.prog = prog;
  panelEl.dataset.rcpt = sheet ? sheet.id : '';
  if (sheet && !sheet.printed) { sheet.printed = true; printReceipt(); }
  else if (sheet) panelEl.querySelector('.rcpt-stamp')?.classList.add('is-on');
  const bar = panelEl.querySelector('.cmp-prog');
  if (bar) { bar.style.transform = `scaleX(${prog})`; if (!calm()) bar.animate([{ transform: `scaleX(${prevProg})` }, { transform: `scaleX(${prog})` }], { duration: 520, easing: SLIDE }); }
  if (!calm()) {
    if (animate) panelEl.animate([{ transform: 'translateX(100%)' }, { transform: 'none' }], { duration: 480, easing: SLIDE });
    let n = 0;
    // A commit just made: its row opens a slot at the top and the rows below are pushed down by it
    // (no separate slide for them), then it fades in as the commit's dot lands.
    const fresh = !animate && !switched ? panelEl.querySelector('.cmp-item.is-fresh') : null;
    if (fresh) {
      const h = fresh.offsetHeight;
      fresh.style.overflow = 'hidden';
      fresh.animate([{ height: '0px', paddingTop: '0px', paddingBottom: '0px', marginTop: '0px', marginBottom: '0px' }, { height: h + 'px' }], { duration: 560, delay: 200, easing: SLIDE, fill: 'backwards' }).finished.then(() => { fresh.style.overflow = ''; }, () => {});
      fresh.animate([{ opacity: 0, transform: 'translateY(-8px) scale(.98)' }, { opacity: 1, transform: 'none' }], { duration: 460, delay: 520, easing: SLIDE, fill: 'backwards' });
    }
    for (const li of panelEl.querySelectorAll('.cmp-item')) {
      if (fresh) break;
      const was = before.get(li.dataset.k);
      if (was != null) {
        const dy = was - li.getBoundingClientRect().top;
        if (Math.abs(dy) > 1) li.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 520, easing: SLIDE });
      } else if ((animate || switched) && !li.classList.contains('is-fresh')) {
        li.animate([{ opacity: 0, transform: 'translateX(18px)' }, { opacity: 1, transform: 'none' }], { duration: 420, delay: (animate ? 160 : 40) + n++ * 45, easing: SLIDE, fill: 'backwards' });
      }
    }
  }
  // keep the new row marked for a moment, so a repaint right after a commit doesn't restart its entrance
  if (P.fresh && !P.freshT) P.freshT = setTimeout(() => { P.fresh = null; P.freshT = null; }, 1600);
}
let dragI = null;
function onPanelDrag(e) {
  const P = cs.panel; if (P.mode !== 'review') return;
  const li = e.target.closest?.('.cmp-item');
  if (e.type === 'dragstart') { dragI = +li.dataset.i; li.classList.add('is-drag'); e.dataTransfer.effectAllowed = 'move'; }
  else if (e.type === 'dragover') { e.preventDefault(); for (const x of panelEl.querySelectorAll('.cmp-item')) x.classList.toggle('is-over', x === li); }
  else if (e.type === 'drop') { e.preventDefault(); if (!li || dragI == null) return; const [g] = P.order.splice(dragI, 1); P.order.splice(+li.dataset.i, 0, g); dragI = null; paintPanel(); }
  else { dragI = null; paintPanel(); }
}
function onPanelClick(e) {
  const P = cs.panel, t = (q) => e.target.closest(q);
  let b;
  if (t('[data-cmp-close]') && curSheet()) return tearReceipt();
  if (t('[data-stmt]')) return openStatement();
  if (t('[data-cmp-close]')) { if (P.mode === 'review') { P.mode = null; P.order = []; } P.pushed = null; if (demo) demo = null; else closedRepos.add(route.repo); paintPanel(); return onCommitView() ? draw() : undefined; }
  if ((b = t('[data-rcpt-save]')) && curSheet()) {
    b.disabled = true;
    return shareSpec(curSheet().spec).then(({ copied }) => toast(copied ? 'Saved to Downloads and copied. Paste it into a post.' : 'Saved to Downloads'), (err) => toast(err.message)).finally(() => { b.disabled = false; });
  }
  if (t('[data-cmp-cancel]')) { P.mode = null; P.order = []; paintPanel(); return draw(); }
  if (t('[data-cmp-go]')) return makeAll();
  if ((b = t('[data-cmp-merge]'))) {
    const i = +b.dataset.cmpMerge; const [g] = P.order.splice(i, 1);
    P.order[i - 1].files.push(...g.files); cs.groups = cs.groups.filter((x) => x !== g);
    if (P.order.length < 2) { P.mode = null; P.order = []; }
    paintPanel(); return draw();
  }
  if (t('[data-cmp-undo]')) {
    return run('undo', async () => {
      await api(`/api/changes/undo?repo=${encodeURIComponent(cs.repo)}`, {});
      toast('Undid the last commit. Its files are back in your changes.');
    });
  }
}

// ---------- hold to push ----------
const HOLD_PUSH = 1200;
let charge = null;
function startCharge(btn) {
  const P = cs.panel;
  if (charge || P.pushing || btn.disabled) return;
  const t0 = performance.now();
  // oldest first: they leave in the order they were made
  const rows = [...panelEl.querySelectorAll('.cmp-item.is-out')].reverse();
  const fill = btn.querySelector('.cmp-charge');
  btn.classList.add('is-charging'); panelEl.classList.add('is-charging');
  const fa = calm() ? null : fill?.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: HOLD_PUSH, easing: 'cubic-bezier(.5, 0, .75, 1)', fill: 'forwards' });
  const timers = rows.map((li, i) => setTimeout(() => { li.classList.add('is-armed'); sfxTick(i); }, ((i + 1) / (rows.length + 1)) * HOLD_PUSH * 0.9));
  timers.push(setTimeout(() => btn.classList.add('is-ready'), HOLD_PUSH * 0.72));
  timers.push(setTimeout(() => finish(true), HOLD_PUSH));
  const early = () => finish(false);
  const finish = (go) => {
    if (charge?.finish !== finish) return;
    charge = null;
    timers.forEach(clearTimeout);
    removeEventListener('pointerup', early); removeEventListener('pointercancel', early); btn.removeEventListener('pointerleave', early); removeEventListener('blur', early);
    btn.classList.remove('is-ready'); panelEl?.classList.remove('is-charging');
    if (go) return pushNow(btn);
    btn.classList.remove('is-charging');
    for (const li of rows) li.classList.remove('is-armed');
    const held = performance.now() - t0;
    if (fa) {
      const m = new DOMMatrixReadOnly(getComputedStyle(fill).transform);
      fa.cancel();
      fill.animate([{ transform: `scaleX(${m.a})` }, { transform: 'scaleX(0)' }], { duration: 380, easing: SLIDE });
    }
    if (held > 160) sfxDrain();
    // a tap instead of a hold: the button gives a little shake so you know to keep pressing
    if (held < 300 && !calm()) btn.animate([{ transform: 'none' }, { transform: 'translateX(-3px)' }, { transform: 'translateX(3px)' }, { transform: 'translateX(-1.5px)' }, { transform: 'none' }], { duration: 340, easing: 'ease-out' });
  };
  charge = { finish };
  addEventListener('pointerup', early); addEventListener('pointercancel', early); btn.addEventListener('pointerleave', early); addEventListener('blur', early);
}
async function pushNow(btn) {
  const P = cs.panel, practice = !!demo, repo = cartKey(), items = outgoing().slice();
  P.pushing = true; panelEl?.classList.add('is-sending');
  btn.classList.remove('is-charging'); btn.classList.add('is-pushing', 'is-launch');
  // Card accepted: the reader beeps, then the commits fly off to the remote.
  const lbl = btn.querySelector('.cmp-lbl');
  btn.classList.add('is-approved');
  if (lbl) lbl.innerHTML = `${icon('Tick02', 14)}Approved`;
  if (!calm()) { sfxApproved(); await new Promise((ok) => setTimeout(ok, 420)); }
  if (lbl) lbl.textContent = 'Pushing…';
  const upstream = practice ? 'nowhere (practice)' : pd.outgoing?.upstream || 'the remote', branch = practice ? 'practice' : pd.branch;
  try {
    await Promise.all([practice ? new Promise((ok) => setTimeout(ok, 600)) : api(`/api/x/push?repo=${encodeURIComponent(repo)}`, {})]);
    let no = 1;
    try { const k = `staged-push-no:${repo}`; no = (+localStorage.getItem(k) || 0) + 1; localStorage.setItem(k, String(no)); } catch {}
    const link = practice ? '' : compareUrl(route.remote, route.provider, pd.outgoing?.base, items[0]?.sha);
    const R = { id: String(Date.now()), items, repo, name: practice ? 'practice' : repo, upstream, branch, at: Date.now(), practice, no, link };
    R.spec = receiptSpec(R);
    if (!practice) logPush(R);
    P.pushed = R;
  } catch (e) { toast(e.message); }
  P.pushing = false; panelEl?.classList.remove('is-sending');
  paintPanel();
  if (practice) return;
  await refreshOutgoing();
  if (onCommitView()) loadChanges(cs.repo, { keep: true });
  onPushed?.();
}
// The receipt glides up out of the printer at the bottom of the panel in one smooth pass, like a
// laser printer: it warms up, feeds the page out evenly, eases to a stop, then gets stamped.
function printReceipt() {
  const wrap = panelEl?.querySelector('.rcpt-wrap'), paper = panelEl?.querySelector('.rcpt'), prn = panelEl?.querySelector('.prn');
  const stamp = () => { const st = panelEl?.querySelector('.rcpt-stamp'); if (!st) return; st.classList.add('is-on'); if (!calm()) { st.classList.add('is-slam'); sfxStamp(); } };
  const done = () => { wrap?.classList.remove('is-printing'); prn?.classList.remove('is-on'); if (!calm()) { sfxBeeps(0.38); prn?.classList.add('is-beep'); setTimeout(() => prn?.classList.remove('is-beep'), 1200); } setTimeout(stamp, calm() ? 0 : 1050); };
  if (!paper || calm()) return done();
  // the paper feeds at a steady speed, like a real printer, so a longer receipt takes longer
  // (about 4.5ms a pixel), and the motor sound runs exactly as long as the paper moves
  const warm = 380, ms = Math.round(Math.max(900, Math.min(7000, paper.offsetHeight * 4.5)));
  sfxLaser(warm, ms);
  const a = warm / (warm + ms), z = (warm + ms) / (warm + ms + 120);
  paper.animate([{ transform: 'translateY(100%)', offset: 0 }, { transform: 'translateY(100%)', offset: a * z }, { transform: 'translateY(-0.6%)', offset: z }, { transform: 'none', offset: 1 }],
    { duration: warm + ms + 120, easing: 'linear', fill: 'backwards' }).finished.then(done, done);
}
// Done: the receipt is torn off and the panel slides away.
function tearReceipt() {
  const P = cs.panel, which = curSheet();
  const paper = panelEl?.querySelector('.rcpt');
  const end = () => {
    if (curSheet() !== which) return;
    if (which === stmt) stmt = null; else { P.pushed = null; if (which?.practice) demo = null; }
    paintPanel(); if (onCommitView()) draw();
  };
  if (!paper || calm()) return end();
  sfxTear();
  paper.animate([{ transform: 'none', opacity: 1 }, { transform: 'translate(8px, -60px) rotate(5deg)', opacity: 0 }], { duration: 420, easing: 'cubic-bezier(.5, 0, .75, 0)', fill: 'forwards' }).finished.then(end, end);
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
    cs.format = f; store.formats = { ...(store.formats || {}), [cs.repo]: f }; save(); return draw();
  }
  if ((b = t('[data-emoji]'))) { const g = groupById(b.dataset.emoji); return emojiPicker(b, { current: g.emoji, type: g.type, suggested: g.emojiSuggestions, onPick: (e, type) => { g.emoji = e; if (type !== 'revert' && g.edited == null) { g.type = type; fetch(`/api/changes/learn-style?repo=${encodeURIComponent(cs.repo)}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-changes': '1' }, body: JSON.stringify({ type, emoji: e }) }).catch(() => {}); } draw(); } }); }
  if ((b = t('[data-moveopen]'))) return b.dataset.dragged ? undefined : openMoveMenu(b);
  if ((b = t('[data-more]'))) return openMoreMenu(b);
  if (t('[data-regroup]')) return regroup();
  if ((b = t('[data-chunks]'))) return togglePanel(cs.hunkOpen, b.dataset.g + '|' + b.dataset.chunks, b);
  if ((b = t('[data-diff]'))) return togglePanel(cs.open, b.dataset.g + '|' + b.dataset.diff, b);
  if ((b = t('[data-addbody]'))) {
    const id = b.dataset.addbody;
    if (cs.bodyOpen.has(id)) { cs.bodyOpen.delete(id); return draw(); }
    cs.bodyOpen.add(id); draw(); return host.querySelector(`[data-body="${CSS.escape(id)}"]`)?.focus();
  }
  if ((b = t('[data-reset]'))) { groupById(b.dataset.reset).edited = null; return draw(); }
  if ((b = t('[data-dismiss]'))) { cs.banner = null; return draw(); }
  if ((b = t('[data-regroup]'))) return regroup();
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
    wrap.querySelector('.cm-count').textContent = full.length >= 60 ? full.length : '';
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
}

function moveFile(p, fromId, to) {
  if (!to) return;
  const from = groupById(fromId) || cs.groups.find((g) => g.files.includes(p));
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
  cs.justMoved = p + '|' + dest.id; clearTimeout(cs.movedT); cs.movedT = setTimeout(() => { cs.justMoved = null; }, 1200);
  draw();
  // remember this correction for next time
  fetch(`/api/changes/learn?repo=${encodeURIComponent(cs.repo)}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-changes': '1' }, body: JSON.stringify({ file: p, from: from.files, to: learnTo }) }).catch(() => {});
  toast('Moved. It will remember this next time.');
}
let moveMenu = null;
function closeMoveMenu() { moveMenu?.remove(); moveMenu = null; removeEventListener('pointerdown', outsideMove, true); removeEventListener('keydown', keyMove, true); }
const outsideMove = (e) => { if (moveMenu && !moveMenu.contains(e.target) && !e.target.closest('[data-moveopen], [data-more]')) closeMoveMenu(); };
const keyMove = (e) => {
  if (!moveMenu) return;
  const items = [...moveMenu.querySelectorAll('button')], at = items.indexOf(document.activeElement);
  if (e.key === 'Escape') { e.stopPropagation(); const back = moveMenu.opener; closeMoveMenu(); back?.focus(); }
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus(); }
};
function openMoveMenu(btn) {
  if (moveMenu?.opener === btn) return closeMoveMenu();
  closeMoveMenu();
  const g = groupById(btn.dataset.g), p = btn.dataset.moveopen;
  const others = cs.groups.filter((x) => x !== g);
  moveMenu = document.createElement('div');
  moveMenu.className = 'cm-menu'; moveMenu.setAttribute('role', 'menu'); moveMenu.opener = btn;
  moveMenu.innerHTML = `<p class="cm-menu-h mono muted">Move ${esc(p.split('/').pop())} to</p>
    ${others.map((o, i) => `<button role="menuitem" data-moveto="${esc(o.id)}"><span class="cm-num mono">${cs.groups.indexOf(o) + 1}</span><span>${esc(clip(subjectFor(o), 56))}</span></button>`).join('')}
    <button role="menuitem" data-moveto="__new"><span class="cm-num mono">+</span><span>New commit</span></button>`;
  document.body.appendChild(moveMenu);
  const r = btn.getBoundingClientRect(), w = Math.min(320, innerWidth - 24);
  Object.assign(moveMenu.style, { width: w + 'px', left: Math.max(12, Math.min(r.right - w, innerWidth - w - 12)) + 'px' });
  const below = r.bottom + 6 + moveMenu.offsetHeight < innerHeight;
  moveMenu.style.top = (below ? r.bottom + 6 : Math.max(12, r.top - 6 - moveMenu.offsetHeight)) + 'px';
  if (!calm()) moveMenu.animate([{ opacity: 0, transform: `translateY(${below ? -4 : 4}px) scale(.98)` }, { opacity: 1, transform: 'none' }], { duration: 160, easing: EASE });
  moveMenu.addEventListener('click', (e) => { const b = e.target.closest('[data-moveto]'); if (!b) return; closeMoveMenu(); moveFile(p, g?.id, b.dataset.moveto); });
  addEventListener('pointerdown', outsideMove, true); addEventListener('keydown', keyMove, true);
  moveMenu.querySelector('button')?.focus();
}

// The rarely used actions of a commit card, out of the way: a description, and throwing it all away.
function openMoreMenu(btn) {
  if (moveMenu?.opener === btn) return closeMoveMenu();
  closeMoveMenu();
  const g = groupById(btn.dataset.more); if (!g) return;
  const open = cs.bodyOpen.has(g.id), has = !!(g.body || '').trim();
  moveMenu = document.createElement('div');
  moveMenu.className = 'cm-menu'; moveMenu.setAttribute('role', 'menu'); moveMenu.opener = btn;
  moveMenu.innerHTML = `<button role="menuitem" data-act="desc"><span class="cm-menu-ic">${icon('Note01', 14)}</span><span>${open ? 'Hide description' : has ? 'Edit description' : 'Add description'}</span></button>
    <button role="menuitem" data-act="discard" class="is-danger"><span class="cm-menu-ic">${icon('Delete02', 14)}</span><span>Discard these changes…</span></button>`;
  document.body.appendChild(moveMenu);
  const r = btn.getBoundingClientRect(), w = 220;
  Object.assign(moveMenu.style, { width: w + 'px', left: Math.max(12, Math.min(r.right - w, innerWidth - w - 12)) + 'px' });
  const below = r.bottom + 6 + moveMenu.offsetHeight < innerHeight;
  moveMenu.style.top = (below ? r.bottom + 6 : Math.max(12, r.top - 6 - moveMenu.offsetHeight)) + 'px';
  if (!calm()) moveMenu.animate([{ opacity: 0, transform: `translateY(${below ? -4 : 4}px) scale(.98)` }, { opacity: 1, transform: 'none' }], { duration: 160, easing: EASE });
  moveMenu.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    closeMoveMenu();
    if (b.dataset.act === 'desc') {
      if (cs.bodyOpen.has(g.id)) { cs.bodyOpen.delete(g.id); return draw(); }
      cs.bodyOpen.add(g.id); draw(); return host.querySelector(`[data-body="${CSS.escape(g.id)}"]`)?.focus();
    }
    const files = g.files.filter((p) => cs.files.has(p));
    confirmDialog({ title: `Discard ${files.length} file${files.length > 1 ? 's' : ''}?`, text: `Your changes to ${files.length > 1 ? 'these files' : esc(files[0])} go away. You can bring them back right after.`, ok: 'Discard', danger: true })
      .then((go) => go && discard(discardWhat(g), host.querySelector(`[data-group="${CSS.escape(g.id)}"]`)));
  });
  addEventListener('pointerdown', outsideMove, true); addEventListener('keydown', keyMove, true);
  moveMenu.querySelector('button')?.focus();
}


// Drag a file by its grip onto another commit (or the "new commit" strip) to move it there.
let drag = null;
function dragStart(e) {
  const grip = e.target.closest('.cm-grip'); if (!grip || e.button !== 0) return;
  const row = grip.closest('.cm-file'); if (!row) return;
  const sx = e.clientX, sy = e.clientY;
  const move = (ev) => {
    if (!drag) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
      const r = row.getBoundingClientRect();
      const ghost = row.cloneNode(true); ghost.classList.add('cm-ghost');
      Object.assign(ghost.style, { width: Math.min(r.width, 380) + 'px', left: r.left + 'px', top: r.top + 'px' });
      document.body.appendChild(ghost);
      drag = { p: row.dataset.row, from: row.dataset.g, row, ghost, dx: sx - r.left, dy: sy - r.top, over: null };
      row.classList.add('is-lifted'); host.classList.add('is-dragging');
      if (!calm()) ghost.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.02) rotate(-.6deg)' }], { duration: 160, easing: EASE, fill: 'forwards' });
    }
    drag.ghost.style.left = ev.clientX - drag.dx + 'px'; drag.ghost.style.top = ev.clientY - drag.dy + 'px';
    drag.ghost.hidden = true; const under = document.elementFromPoint(ev.clientX, ev.clientY); drag.ghost.hidden = false;
    let tgt = under?.closest('[data-drop]'); if (tgt && tgt.dataset.drop === drag.from) tgt = null;
    if (tgt !== drag.over) { drag.over?.classList.remove('is-over'); tgt?.classList.add('is-over'); drag.over = tgt; }
  };
  const up = () => {
    removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
    if (!drag) return; // a plain click: the grip opens the move menu
    const d = drag; drag = null; grip.dataset.dragged = '1'; setTimeout(() => delete grip.dataset.dragged, 0);
    host.classList.remove('is-dragging'); d.row.classList.remove('is-lifted'); d.over?.classList.remove('is-over');
    const to = d.over?.dataset.drop;
    if (to) { d.ghost.remove(); moveFile(d.p, d.from, to); return; }
    const r = d.row.getBoundingClientRect(), g = d.ghost.getBoundingClientRect();
    d.ghost.animate([{ transform: `translate(0,0)` }, { transform: `translate(${r.left - g.left}px, ${r.top - g.top}px)` }], { duration: calm() ? 0 : 220, easing: EASE }).finished.then(() => d.ghost.remove(), () => d.ghost.remove());
  };
  addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', up);
}
