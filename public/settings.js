// Settings: repositories, sound and updates. A project's own choices (message style) live in Project settings.
import { icon } from './icons.js';
import { esc, toast } from './ui.js';
import { soundOn, setSound, sfxGrouped } from './sfx.js';
import { previewCommit } from './fx.js';
import { practiceCart } from './commit-view.js';
import { checkNow } from './update.js';

let host = null, ctx = null, repoInfo = null, scan = null, fresh = new Set();

export async function mountSettings(el, context) {
  host = el; ctx = context;
  if (!host.dataset.bound) { host.addEventListener('click', onClick); host.addEventListener('change', onChange); host.addEventListener('pointerdown', onHold); host.dataset.bound = '1'; }
  await refresh();
  if (ctx.section) host.querySelector(`#set-${ctx.section}`)?.scrollIntoView({ block: 'start' });
}

async function refresh() {
  repoInfo = await fetch('/api/repos/manage').then((r) => r.json()).catch(() => null);
  draw();
}

function draw() {
  if (!host || host.hidden) return;
  host.innerHTML = `
  <div class="set">
    ${reposSection()}

    <section class="set-sec" id="set-feel">
      <header class="set-h"><h2>Sound</h2></header>
      <div class="set-card">
        <label class="set-row is-toggle">
          <div class="set-row-main"><b>Sounds</b><span class="muted">Soft sounds when you commit, push and discard.</span></div>
          <span class="switch"><input type="checkbox" data-sound ${soundOn() ? 'checked' : ''}><i></i></span>
        </label>
        <div class="set-row">
          <div class="set-row-main"><b>Try them</b><span class="muted">Plays the moments without committing or pushing anything.</span></div>
          <div class="set-btns"><button class="text-btn bordered sm" data-preview="commit">Commit</button><button class="text-btn bordered sm" data-preview="push">Push</button></div>
        </div>
      </div>
    </section>

    <section class="set-sec" id="set-updates">
      <header class="set-h"><h2>Updates</h2></header>
      <div class="set-card">
        <div class="set-row">
          <div class="set-row-main"><b>staged ${esc(ctx.version || '')}</b><span class="muted">New releases on GitHub show up in the sidebar within a few hours.</span></div>
          <button class="text-btn bordered sm" data-check>${icon('Refresh01', 13)}Check now</button>
        </div>
      </div>
    </section>
  </div>`;
}
// Settings › Repos: the folders staged looks in (every git repo inside, up to three levels down, shows
// up), single repos added on their own, folders that aren't repos yet, and a switch per repo to hide it.
const TINTS = ['var(--logo-1)', 'var(--logo-2)', 'var(--logo-box)'];
const tint = (name) => TINTS[[...name].reduce((n, ch) => n + ch.charCodeAt(0), 0) % TINTS.length];
const parentOf = (p) => p.replace(/\/[^/]+\/?$/, '');
function reposSection() {
  if (!repoInfo) return '';
  const { folders, repos, plain = [] } = repoInfo;
  const count = (f) => repos.filter((r) => r.path.startsWith(f.path + '/')).length;
  const off = scan ? 'disabled' : '';
  const shown = repos.filter((r) => !r.hidden).length;
  const isRoot = (r) => folders.some((f) => f.kind === 'folder' && f.path === r.path);
  let n = 0;
  const folderRow = (f) => `<div class="rp-folder" style="--d:${n++}">
      <span class="rp-ftile">${icon(f.kind === 'repo' ? 'GitBranch' : 'Folder01', 16)}</span>
      <span class="rp-fmain"><b>${esc(short(f.path))}</b><span class="mono muted">${esc(f.path)}</span></span>
      ${folders.length > 1 && f.kind !== 'repo' ? `<span class="rp-count mono">${count(f)} ${count(f) === 1 ? 'repo' : 'repos'}</span>` : '<span></span>'}
      <button class="rp-x" data-unfolder="${esc(f.path)}" ${folders.length < 2 || scan ? 'disabled' : ''} title="${folders.length < 2 ? 'staged needs at least one folder' : 'Stop looking here'}" aria-label="Remove ${esc(f.path)}">${icon('Cancel01', 14)}</button>
    </div>`;
  const repoTile = (r) => `<div class="rp-tile ${r.hidden ? 'is-off' : ''} ${fresh.has(r.path) ? 'is-new' : ''}" style="--i:${Math.max(0, [...fresh].indexOf(r.path))}" data-tile="${esc(r.path)}">
      <span class="rp-mono ${r.logo ? 'has-logo' : ''}" style="--t:${tint(r.name)}">${r.logo ? `<img src="/api/repos/logo?path=${encodeURIComponent(r.path)}" alt="" loading="lazy" onerror="this.parentNode.classList.remove('has-logo');this.remove()">` : ''}<i>${esc(r.name.replace(/[^a-z0-9]/gi, '').slice(0, 1).toUpperCase() || '·')}</i></span>
      <span class="rp-tmain"><b title="${esc(r.path)}">${esc(r.name)}</b><span class="mono muted"><span class="rp-where">${esc(parentOf(r.path))}</span><span class="rp-hold">removing git…</span></span></span>
      ${isRoot(r) ? '<span></span>' : `<button class="rp-ungit" data-ungit="${esc(r.path)}" ${off} title="Hold to remove git. The files stay; the history goes to the Trash, so it can come back." aria-label="Remove git from ${esc(r.name)}">${icon('Delete02', 14)}</button>`}
      <label class="switch" title="${r.hidden ? 'Hidden. Turn on to show it in staged' : 'Shown in staged'}"><input type="checkbox" data-showrepo="${esc(r.path)}" ${r.hidden ? '' : 'checked'} aria-label="Show ${esc(r.name)}"><i></i></label>
    </div>`;
  const plainTile = (f) => `<div class="rp-tile is-plain">
      <span class="rp-mono is-plain">${icon('Folder01', 15)}</span>
      <span class="rp-tmain"><b>${esc(f.name)}</b><span class="mono muted">${esc(parentOf(f.path))}</span></span>
      <button class="text-btn bordered sm rp-init" data-init="${esc(f.path)}" ${off}>${icon('GitBranch', 13)}Turn on git</button>
    </div>`;
  return `<section class="set-sec rp" id="set-repos">
    <header class="set-h"><h2>Repos</h2><p class="muted">staged finds every git repo inside your folders, up to three levels down.</p></header>
    <div class="set-card rp-card">
      <div class="rp-head"><b>Where staged looks</b></div>
      <div class="rp-folders">${folders.map(folderRow).join('')}</div>
      ${scan ? scanRow() : ''}
      <div class="rp-actions">
        <button class="text-btn bordered sm" data-pick="parent" ${off}>${icon('Add01', 13)}Add a folder</button>
        <button class="text-btn bordered sm" data-pick="repo" ${off}>${icon('GitBranch', 13)}Add one repo</button>
        <button class="text-btn sm rp-rescan" data-rescan ${off}><span class="rp-spin">${icon('Refresh', 13)}</span>Scan again</button>
      </div>
    </div>
    <div class="rp-sub"><b>Your repos</b>${shown === repos.length ? '' : `<span class="mono muted">${shown} of ${repos.length} shown</span>`}</div>
    <div class="rp-grid">${repos.map(repoTile).join('') || '<p class="muted rp-none">No repos yet. Add a folder above.</p>'}</div>
    ${plain.length ? `<div class="rp-sub"><b>Not git repos yet</b><span class="mono muted">staged can't see these until git is on</span></div>
    <div class="rp-grid">${plain.map(plainTile).join('')}</div>` : ''}
  </section>`;
}

const scanRow = () => `<div class="set-scan ${scan.found != null ? 'is-done' : ''}" role="status" aria-live="polite">
  <span class="set-scan-ic">${icon(scan.found != null ? 'Tick02' : 'Search01', 14)}</span>
  <span class="set-scan-text"><b>${esc(scan.found != null ? scan.result : scan.label)}</b><span class="set-scan-tick mono">${esc(scan.tick)}</span></span>
  <span class="set-scan-bar" aria-hidden="true"><i></i></span>
</div>`;

async function post(body) {
  const r = await fetch('/api/repos/manage', { method: 'POST', headers: { 'content-type': 'application/json', 'x-changes': '1' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { toast(j.error || "Couldn't change that"); return null; }
  return j;
}
async function manage(body) {
  const j = await post(body);
  if (!j) return false;
  repoInfo = j; draw(); ctx.onRepos?.();
  return true;
}

// Adding or rescanning a folder: a short scan with the folder names ticking past, then the repos it
// found drop into the list one after another, with a soft sound.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function scanWith(label, body, done) {
  const before = new Set((repoInfo?.repos || []).map((r) => r.path));
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  scan = { label, tick: 'Looking through folders…' }; draw();
  const t0 = performance.now();
  const j = await post(body);
  if (!j) { scan = null; draw(); return null; }
  const added = j.repos.filter((r) => !before.has(r.path));
  const tick = (t) => { scan.tick = t; const el = host.querySelector('.set-scan-tick'); if (el) { el.textContent = t; el.classList.remove('is-in'); void el.offsetWidth; el.classList.add('is-in'); } };
  if (!calm) {
    const names = [...j.repos, ...(j.plain || [])].map((r) => r.name).slice(0, 16);
    for (const n of names) { tick(n); await wait(Math.max(45, 520 / names.length)); }
    const left = 900 - (performance.now() - t0);
    if (left > 0) await wait(left);
  }
  scan.found = added.length;
  scan.result = done(added, j);
  tick(added.length ? added.slice(0, 3).map((r) => r.name).join(', ') + (added.length > 3 ? ` and ${added.length - 3} more` : '') : (j.plain || []).length ? `${j.plain.length} ${j.plain.length === 1 ? 'folder isn’t' : 'folders aren’t'} git repos yet` : 'Nothing new');
  const row = host.querySelector('.set-scan');
  if (row) { row.classList.add('is-done'); row.querySelector('b').textContent = scan.result; row.querySelector('.set-scan-ic').innerHTML = icon('Tick02', 14); }
  await wait(calm ? 300 : 900);
  repoInfo = j; scan = null;
  fresh = new Set(added.map((r) => r.path));
  draw(); ctx.onRepos?.();
  if (added.length) sfxGrouped(Math.min(5, added.length));
  setTimeout(() => { fresh = new Set(); }, 2000);
  return { j, added };
}
const short = (p) => String(p).replace(/\/$/, '').split('/').pop() || p;
const foundText = (added) => (added.length ? `Found ${added.length} ${added.length === 1 ? 'repo' : 'repos'}` : 'No new repos');
const addPath = (p) => scanWith(`Scanning ${short(p)}`, { action: 'add', path: p }, foundText);

// Remove git: hold for 1.5s (let go to cancel). The .git folder goes to the Trash, with Undo.
const HOLD_MS = 1500;
function onHold(e) {
  const b = e.target.closest('[data-ungit]');
  if (!b || b.disabled || e.button > 0) return;
  const tile = b.closest('.rp-tile');
  tile.classList.add('is-holding');
  const t0 = Date.now();
  const done = setTimeout(() => { stop(); ungit(b.dataset.ungit); }, HOLD_MS);
  const stop = () => { clearTimeout(done); tile.classList.remove('is-holding'); for (const k of ['pointerup', 'pointerleave', 'pointercancel']) b.removeEventListener(k, early); };
  const early = () => { if (Date.now() - t0 < HOLD_MS) { stop(); if (Date.now() - t0 < 300) toast('Hold the button to remove git'); } };
  for (const k of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(k, early);
}
async function ungit(p) {
  const n = short(p), tile = host.querySelector(`[data-tile="${CSS.escape(p)}"]`);
  if (tile && !matchMedia('(prefers-reduced-motion: reduce)').matches) { tile.classList.add('is-leaving'); await wait(260); }
  if (!(await manage({ action: 'ungit', path: p }))) { tile?.classList.remove('is-leaving'); return; }
  toast(`Removed git from ${n}. Its history is in the Trash.`, { action: 'Undo', ms: 8000, onAction: async () => { if (await manage({ action: 'regit', path: p })) { fresh = new Set([p]); draw(); setTimeout(() => { fresh = new Set(); }, 2000); toast(`${n} is a git repo again`); } } });
}

async function onClick(e) {
  let b;
  if ((b = e.target.closest('[data-pick]'))) {
    // staged's server opens the computer's own folder picker, since a web page can't see full paths.
    b.disabled = true;
    try {
      const r = await fetch('/api/repos/pick', { method: 'POST', headers: { 'content-type': 'application/json', 'x-changes': '1' }, body: JSON.stringify({ kind: b.dataset.pick }) }).then((x) => x.json());
      if (r.error) toast(r.error);
      else if (r.path) await addPath(r.path);
    } finally { b.disabled = false; }
    return;
  }
  if ((b = e.target.closest('[data-ungit]'))) { if (e.detail === 0) ungit(b.dataset.ungit); return; } // keyboard: no hold needed, Undo covers it
  if ((b = e.target.closest('[data-rescan]'))) { await scanWith('Scanning your folders', { action: 'scan' }, foundText); return; }
  if ((b = e.target.closest('[data-init]'))) {
    const p = b.dataset.init, n = short(p);
    const r = await scanWith(`Turning on git in ${n}`, { action: 'init', path: p }, () => `${n} is a git repo now`);
    if (r) toast(`${n} now shows in staged. Make its first commit from the Commit tab.`);
    return;
  }
  if ((b = e.target.closest('[data-unfolder]'))) { if (await manage({ action: 'remove', path: b.dataset.unfolder })) toast(`Removed ${b.dataset.unfolder}`); return; }
  if ((b = e.target.closest('[data-preview]'))) { b.dataset.preview === 'commit' ? previewCommit() : practiceCart(); return; }
  if ((b = e.target.closest('[data-check]'))) return checkNow();
}
function onChange(e) {
  const el = e.target;
  if (el.matches('[data-showrepo]')) { manage({ action: el.checked ? 'show' : 'hide', path: el.dataset.showrepo }); return; }
  if (el.matches('[data-sound]')) { setSound(el.checked); return; }
}
