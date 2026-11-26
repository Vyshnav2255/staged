// Home: anything waiting to be committed, pushed or pulled first, then what's running, then how
// your week is going and your last six months at a glance. Details live in each repo's own views.
import { icon } from './icons.js';
import { esc, ago, api, hostOf, toast, modal, reducedMotion } from './ui.js';
import { openStatement } from './commit-view.js';
import { runningAll } from './run.js';
import { animate, SPRING } from './motion.js';

const DAY = 864e5;
// Our springs (motion.js): cards glide, new ones rise, cleared ones fold away.
const GLIDE = SPRING.smooth, RISE = SPRING.smooth;
let host = null, ctx = null, data = null, loadedAt = 0, painted = '';
let shownCount = -1, clearIsNew = false, busy = false, again = false, dayPanel = null;
// Each dirty repo's commit plan, from the same grouping rules the Commit screen uses.
const plans = new Map();
// Repos folded shut in Waiting on you, remembered between visits.
const folded = new Set((() => { try { return JSON.parse(localStorage.getItem('staged.home.folded') || '[]'); } catch { return []; } })());
const saveFolded = () => { try { localStorage.setItem('staged.home.folded', JSON.stringify([...folded])); } catch {} };

export function mountHome(el, context) {
  host = el; ctx = context;
  if (!host.dataset.homeBound) {
    host.addEventListener('click', onClick);
    host.dataset.homeBound = '1';
  }
  draw();
  if (Date.now() - loadedAt > 3000) load();
}

async function load() {
  loadedAt = Date.now();
  try { data = await api('/api/x/today'); } catch (e) { data = { error: e.message || 'Unknown error', repos: null }; }
  draw();
  loadPlans();
}

async function loadPlans() {
  for (const r of data?.repos || []) {
    if (!r.dirty) { plans.delete(r.name); continue; }
    const key = `${r.dirty}:${r.oldest}`;
    if (plans.get(r.name)?.key === key) continue;
    plans.set(r.name, { key, loading: true });
    try {
      const d = await api(`/api/changes?repo=${encodeURIComponent(r.name)}`);
      const g = d.groups || [];
      plans.set(r.name, { key, groups: g.map((x) => ({ emoji: x.emoji || '', name: x.gitmoji || x.title || 'Changes', files: (x.files || []).length })) });
    } catch { plans.set(r.name, { key, failed: true }); }
    draw();
  }
}

const dayAt = (base, add = 0) => { const d = new Date(base); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + add); return d.getTime(); };
const plural = (n, w, ws = w + 's') => `${n} ${n === 1 ? w : ws}`;
const fmt = new Intl.NumberFormat('en');
const dayName = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const dayLong = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
const monthName = new Intl.DateTimeFormat('en-GB', { month: 'short' });
const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });
const span = (t) => ago(t).replace(' ago', '');

function activity() {
  const all = (ctx.repos || []).flatMap((r) => r.commits);
  const byDay = new Map();
  for (const c of all) { const k = dayAt(c.t); byDay.set(k, (byDay.get(k) || 0) + 1); }
  const today = dayAt(Date.now());
  let streak = 0, d = byDay.get(today) ? today : dayAt(today, -1);
  while (byDay.get(d)) { streak++; d = dayAt(d, -1); }
  const ws = dayAt(today, -((new Date(today).getDay() + 6) % 7));
  const into = Date.now() - ws, lws = dayAt(ws, -7);
  const week = all.filter((c) => c.t >= ws);
  const lastWeek = all.filter((c) => c.t >= lws && c.t < lws + into);
  const weeks = Array.from({ length: 12 }, (_, i) => { const a = dayAt(ws, -7 * (11 - i)), b = dayAt(a, 7); return all.filter((c) => c.t >= a && c.t < b).length; });
  const last = all.reduce((m, c) => (!m || c.t > m.t ? c : m), null);
  return { byDay, today, streak, week, lastWeek, weeks, ws, last };
}

// ---------- headline: what's waiting, said in one line ----------
// app.js shows this as the page title on Home; until the repos are read it falls back to a greeting.
export function homeHeadline() {
  if (!data || data.error) return null;
  const list = waitList();
  const ready = list.reduce((s, r) => s + (plans.get(r.name)?.groups?.length || 0), 0);
  const dirtyRepos = list.filter((r) => r.dirty).length;
  const push = list.reduce((s, r) => s + (r.ahead || 0), 0);
  const pull = list.reduce((s, r) => s + (r.behind || 0), 0);
  const oldest = Math.min(...list.map((r) => r.oldest || Infinity));
  const title = !list.length ? 'Everything is saved'
    : ready ? `${plural(ready, 'commit')} ready in ${plural(dirtyRepos, 'repo')}`
    : dirtyRepos ? `${plural(list.reduce((s, r) => s + (r.dirty || 0), 0), 'file')} to commit`
    : push ? `${plural(push, 'commit')} to push` : `${plural(pull, 'commit')} to pull`;
  const sub = [];
  if (list.length && (ready || dirtyRepos) && push) sub.push(`${push} waiting to push`);
  if (pull && (ready || dirtyRepos || push)) sub.push(`${pull} to pull`);
  if (oldest < Infinity) sub.push(`oldest change ${span(oldest)}`);
  if (!list.length) sub.push('every repo is committed and pushed');
  return { title, sub: sub.join(' · ') };
}

// ---------- waiting on you: one ledger, a block per repo, a line per ready commit ----------
const head = (title, count = '', extra = '') => `<div class="home-head"><h3 class="h-sub">${title}</h3>${count !== '' ? `<span class="hx-count">${count}</span>` : ''}${extra}</div>`;

function waiting() {
  if (!data) return `${head('Waiting on you')}<div class="hx-panel"><div class="hx-repo is-skel"></div><div class="hx-repo is-skel"></div></div>`;
  if (data.error) {
    return `${head('Waiting on you')}<div class="home-clear is-error">${icon('Alert02', 16)}<span>Couldn't read your repos, so this can't say what's waiting.</span><button class="text-btn bordered sm" data-retry>${icon('Refresh', 13)}Try again</button></div>`;
  }
  const list = waitList();
  if (!list.length) return '';
  const first = list[0]?.name;
  let ready = 0, files = 0;
  const block = (r) => {
    const old = r.oldest && Date.now() - r.oldest > DAY;
    const repo = (ctx.repos || []).find((x) => x.name === r.name);
    const h = hostOf(repo);
    const p = plans.get(r.name);
    const groups = p?.groups || [];
    ready += groups.length; files += groups.reduce((s, g) => s + g.files, 0);
    const lines = !r.dirty ? ''
      : groups.length ? `<ul class="hx-lines">${groups.slice(0, 6).map((g) => `<li><span class="hx-em" aria-hidden="true">${esc(g.emoji || '•')}</span><span class="hx-cname" title="${esc(g.name)}">${esc(g.name)}</span><i class="hx-leader" aria-hidden="true"></i><span class="hx-files">${plural(g.files, 'file')}</span></li>`).join('')}${groups.length > 6 ? `<li class="hx-more"><span></span><span>and ${groups.length - 6} more</span></li>` : ''}</ul>`
      : p?.failed ? `<p class="hx-note">${plural(r.dirty, 'file')} changed</p>` : `<p class="hx-note is-load">Grouping ${plural(r.dirty, 'changed file')}…</p>`;
    const notes = [
      r.ahead ? `${icon('ArrowUp02', 13)}${plural(r.ahead, 'commit')} made, not pushed` : '',
      r.behind ? `${icon('ArrowDown02', 13)}${plural(r.behind, 'commit')} to pull from ${esc(h.name)}` : '',
      r.dirty && !r.ahead && !r.behind && groups.length ? `${plural(r.dirty, 'file')} changed, nothing to push` : '',
    ].filter(Boolean);
    // One clear action per repo: commit first, then push, then pull.
    const main = r.dirty ? `<button class="text-btn bordered hx-act" data-commit="${esc(r.name)}">${icon('GitCommit', 14)}Commit${groups.length ? ` <b>${groups.length}</b>` : ''}</button>`
      : r.ahead ? `<button class="text-btn bordered hx-act" data-cart="${esc(r.name)}" title="Open the cart to push">${icon('ArrowUp02', 14)}Push <b>${r.ahead}</b></button>`
      : `<button class="text-btn bordered hx-act" data-pull="${esc(r.name)}">${icon('Download04', 14)}Pull <b>${r.behind}</b></button>`;
    const second = r.dirty && r.ahead ? `<button class="text-btn bordered hx-act2" data-cart="${esc(r.name)}" title="Open the cart to push">Push ${r.ahead}</button>` : '';
    const shut = folded.has(r.name);
    const summary = [groups.length ? plural(groups.length, 'commit') + ' ready' : r.dirty ? plural(r.dirty, 'file') : '', r.ahead ? `${r.ahead} to push` : '', r.behind ? `${r.behind} to pull` : ''].filter(Boolean).join(' · ');
    return `<div class="hx-repo${r.name === first ? ' is-first' : ''}${shut ? ' is-shut' : ''}" data-repo="${esc(r.name)}">
      <div class="hx-repo-h">
        <button class="hx-fold" data-fold="${esc(r.name)}" aria-expanded="${!shut}" title="${shut ? 'Show' : 'Hide'} ${esc(r.name)}'s commits">${icon('ArrowRight01', 14)}</button>
        <span class="hv-host" title="${repo?.remote ? `On ${esc(h.name)}` : 'Local only'}">${icon(repo?.remote ? h.icon : 'Folder01', 14)}</span>
        <button class="hv-wname" data-open="${esc(r.name)}">${esc(r.name)}</button>
        ${r.branch ? `<span class="hx-branch">${esc(r.branch)}</span>` : ''}
        ${shut && summary ? `<span class="hx-sum">${esc(summary)}</span>` : ''}
        ${r.oldest ? `<span class="hx-age${old ? ' is-old' : ''}" title="Oldest change: ${esc(new Date(r.oldest).toLocaleString('en-GB'))}">${old ? 'waiting ' : ''}${span(r.oldest)}</span>` : ''}
      </div>
      ${shut ? '' : lines}
      <div class="hx-repo-f"${shut ? ' hidden' : ''}><span class="hx-note">${notes.join('<span class="hx-sep">·</span>')}</span>${second}${main}</div>
    </div>`;
  };
  const blocks = list.map(block).join('');
  const total = ready ? `<div class="hx-total"><span>Total</span><b>${plural(ready, 'commit')} ready<span class="hx-sep">·</span>${plural(files, 'file')}</b></div>` : '';
  return `${head('Waiting on you', list.length)}<div class="hx-panel hx-ledger">${blocks}${total}</div>`;
}

// ---------- activity: one heatmap with the week's figures in its header ----------
function activityPanel(a) {
  const start = dayAt(a.ws, -25 * 7);
  let max = 1, total = 0, days = 0;
  const wd = [0, 0, 0, 0, 0, 0, 0];
  for (const [k, n] of a.byDay) if (k >= start) { max = Math.max(max, n); total += n; days++; wd[new Date(k).getDay()] += n; }
  const busiest = total ? new Intl.DateTimeFormat('en-GB', { weekday: 'long' }).format(new Date(2024, 0, 7 + wd.indexOf(Math.max(...wd)))) : '';
  let cells = '', months = '', lastM = -1;
  for (let w = 0; w < 26; w++) {
    const m = new Date(dayAt(start, w * 7)).getMonth();
    if (m !== lastM) { if (w > 0 || new Date(start).getDate() <= 7) months += `<span style="grid-column:${w + 1}">${monthName.format(dayAt(start, w * 7))}</span>`; lastM = m; }
  }
  for (let i = 0; i < 26 * 7; i++) {
    const t = dayAt(start, i);
    if (t > a.today) { cells += '<i class="hm-c is-future"></i>'; continue; }
    const n = a.byDay.get(t) || 0;
    const lv = !n ? 0 : n / max > 0.66 ? 4 : n / max > 0.33 ? 3 : n > 1 ? 2 : 1;
    cells += `<i class="hm-c l${lv}${t === a.today ? ' is-today' : ''}${dayPanel?.day === t ? ' is-picked' : ''}" title="${dayName.format(t)}: ${plural(n, 'commit')}"${n ? ` data-day="${t}"` : ''}></i>`;
  }
  const streak = a.streak ? `${plural(a.streak, 'day')} streak` : 'no streak yet';
  return `${head('Activity', '', `<span class="hx-figs"><b>${a.week.length}</b> ${a.week.length === 1 ? 'commit' : 'commits'} this week<span class="hx-sep">·</span><b>${a.streak}</b> ${a.streak === 1 ? 'day' : 'day'} streak</span>`)}
  <div class="hx-panel hx-act-panel">
    <div class="hx-heat">
      <div class="hm-wrap">
        <div class="hm-months" aria-hidden="true">${months}</div>
        <div class="hm" role="img" aria-label="Commits per day over the last 6 months, ${streak}. Pick a day to see its commits.">${cells}</div>
      </div>
    </div>
    <dl class="hx-stats">
      <div><dt>Last 6 months</dt><dd>${plural(total, 'commit')}</dd></div>
      <div><dt>Active days</dt><dd>${days}</dd></div>
      ${busiest ? `<div><dt>Busiest day</dt><dd>${busiest}</dd></div>` : ''}
      <span class="hm-key">less <i class="hm-c l1"></i><i class="hm-c l2"></i><i class="hm-c l3"></i><i class="hm-c l4"></i> more</span>
    </dl>
  </div>`;
}

// ---------- right column: the week as a receipt, then the latest commits ----------
function side(a) {
  const add = a.week.reduce((s, c) => s + c.add, 0), del = a.week.reduce((s, c) => s + c.del, 0);
  const repos = new Set(a.week.map((c) => c.repo)).size;
  const diff = a.week.length - a.lastWeek.length;
  const wk = isoWeek(a.ws);
  const range = `${new Intl.DateTimeFormat('en-GB', { day: 'numeric' }).format(a.ws)} to ${new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(dayAt(a.ws, 6))}`;
  const receipt = `<div class="hx-panel hx-receipt">
      <div class="hx-rc-h"><b>Week ${wk}</b><span>${range}</span></div>
      <div class="hx-rc-sec">
        <div class="hx-rc-l"><span>commits</span><span>${a.week.length}</span></div>
        <div class="hx-rc-l"><span>lines</span><span><span class="a">+${fmt.format(add)}</span> <span class="d">−${fmt.format(del)}</span></span></div>
        <div class="hx-rc-l"><span>repos touched</span><span>${repos}</span></div>
      </div>
      <div class="hx-rc-total"><span>Total</span><b>${a.week.length}<small>${a.week.length === 1 ? 'commit' : 'commits'}</small></b></div>
      <div class="hx-rc-foot"><span>${a.lastWeek.length || a.week.length ? (diff === 0 ? 'same as last week' : `${diff > 0 ? '+' : '−'}${Math.abs(diff)} vs last week`) : 'a fresh start'}</span><button class="text-btn bordered sm" data-stmt>${icon('ReceiptText', 13)}Print statement</button></div>
    </div>`;
  const st = new Map((data?.repos || []).map((r) => [r.name, r]));
  const latest = (ctx.repos || []).flatMap((r) => r.commits.slice(0, 5).map((c, i) => ({ c, unpushed: st.get(r.name)?.upstream ? i < (st.get(r.name).ahead || 0) : null }))).sort((x, y) => y.c.t - x.c.t).slice(0, 5);
  const feed = latest.length ? `${head('Latest', latest.length)}<div class="hx-panel hx-feed">${latest.map(({ c, unpushed }) => `<button class="hx-fi" data-open="${esc(c.repo)}">
      <span class="hx-cname" title="${esc(c.subject)}">${esc(c.subject)}</span>
      <span class="hx-fi-m">${esc(c.repo)}<span class="hx-sep">·</span>${esc(span(c.t))}<span class="hx-sep">·</span><span class="mono">${esc(c.sha.slice(0, 7))}</span></span>
      ${unpushed === null ? '<i class="hx-pdot is-local" title="Local repo"></i>' : `<i class="hx-pdot${unpushed ? '' : ' is-pushed'}" title="${unpushed ? 'Not pushed yet' : 'Pushed'}"></i>`}
    </button>`).join('')}<div class="hx-fi-key"><span><i class="hx-pdot is-pushed"></i>pushed</span><span><i class="hx-pdot"></i>not pushed</span></div></div>` : '';
  return `${head("This week's statement")}${receipt}${feed}`;
}

function isoWeek(t) {
  const d = new Date(t); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const w1 = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d - w1) / DAY - 3 + ((w1.getDay() + 6) % 7)) / 7);
}

// Up to three cards share the full width; more wrap into columns.
const grid = (n) => `hv-cards${n <= 3 ? ` is-${n}` : ''}`;

// What's running right now across every repo (a dev server, a build), each with its page and a stop.
function runningNow() {
  const jobs = runningAll();
  if (!jobs.length) return '';
  const up = (t) => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`; };
  const card = (j) => `<div class="hv-card hv-run">
      <div class="hv-card-h"><span class="hv-live" aria-hidden="true"></span><button class="hv-wname" data-run-repo="${esc(j.repo)}" title="Open ${esc(j.repo)}'s commands">${esc(j.repo)}</button><span class="hv-wage mono">up ${up(j.at)}</span></div>
      <div class="hv-run-what"><b>${esc(j.label)}${j.external ? ' <small class="muted" title="Started outside staged: in a Terminal, or before staged restarted">· outside staged</small>' : ''}</b><code class="mono" title="${esc(j.cmd)}">${esc(j.cmd)}</code></div>
      <div class="hv-card-f">
        ${j.url ? `<button class="text-btn bordered sm" data-run-open="${esc(j.repo)}" data-id="${esc(j.id)}" title="Open ${esc(j.url)}">${icon('LinkSquare02', 13)}${esc(j.url.replace(/^https?:\/\//, '').replace(/\/$/, ''))}</button>` : `<span class="muted hv-boot">${j.kind === 'serve' ? 'Starting…' : 'Running…'}</span>`}
        <button class="text-btn sm hv-stop" data-run-stop="${esc(j.repo)}" data-id="${esc(j.id)}" title="Stop ${esc(j.label)}">${icon('Stop', 12)}Stop</button>
      </div>
    </div>`;
  return `<div class="home-head"><h3 class="h-sub">Running now</h3><span class="hx-count">${plural(jobs.length, 'command')}</span></div><div class="${grid(jobs.length)}">${jobs.map(card).join('')}</div>`;
}

const waitList = () => (data?.repos || []).filter((r) => r.dirty || r.ahead || r.behind)
  .sort((x, y) => (x.oldest || Infinity) - (y.oldest || Infinity) || (y.ahead || 0) - (x.ahead || 0));

// The page title on Home is the headline; the date sits at the right of the line under it.
function headline() {
  const hl = homeHeadline(), t = document.getElementById('title'), m = document.getElementById('meta');
  if (!hl || !t || !m || ctx.isHome && !ctx.isHome()) return;
  t.textContent = hl.title;
  const sub = m.querySelector('.home-sub');
  if (sub) sub.textContent = hl.sub;
}

function draw() {
  if (!host || host.hidden) return;
  if (busy) { again = true; return; }
  const a = activity();
  const count = data && !data.error ? waitList().length : -1;
  // The tick draws itself only when the last thing waiting was just cleared, not on every visit.
  if (count === 0 && shownCount > 0) clearIsNew = true; else if (count !== 0) clearIsNew = false;
  if (count >= 0) shownCount = count;
  const html = `<div class="hx"><div class="hx-main">${activityPanel(a)}${waiting()}${runningNow()}</div><aside class="hx-side">${side(a)}</aside></div>`;
  headline();
  // Only touch the page when something changed, so nothing shifts or flickers on a refresh.
  if (html === painted && host.firstElementChild) return;
  const before = new Map([...host.querySelectorAll('.hx-repo[data-repo]')].map((el) => [el.dataset.repo, el]));
  const keep = new Set([...html.matchAll(/class="hx-repo[^"]*" data-repo="([^"]*)"/g)].map((m) => m[1]));
  const gone = [...before].filter(([k]) => !keep.has(k)).map(([, el]) => el);
  const paint = () => {
    const rects = new Map([...host.querySelectorAll('.hx-repo[data-repo]')].map((el) => [el.dataset.repo, el.getBoundingClientRect()]));
    painted = html;
    host.innerHTML = html;
    if (reducedMotion() || !before.size) return;
    // FLIP: cards that stay glide to their new place; new ones fade up.
    for (const el of host.querySelectorAll('.hx-repo[data-repo]')) {
      const r0 = rects.get(el.dataset.repo);
      if (!r0) { animate(el, { opacity: [0, 1], y: [6, 0] }, RISE); continue; }
      const r1 = el.getBoundingClientRect();
      const dx = r0.left - r1.left, dy = r0.top - r1.top;
      if (dx || dy) animate(el, { x: [dx, 0], y: [dy, 0] }, GLIDE);
    }
  };
  if (!gone.length || reducedMotion()) return paint();
  // A repo that was just cleared folds away first, then the rest slide into its place.
  busy = true;
  Promise.all(gone.map((el) => Promise.resolve(animate(el, { opacity: 0, scale: 0.96 }, { duration: 0.16, ease: 'easeIn' })).catch(() => {})))
    .then(() => { busy = false; paint(); if (again) { again = false; draw(); } });
}

async function pull(name, btn) {
  if (btn) { btn.disabled = true; btn.classList.add('is-busy'); }
  try {
    const r = await api(`/api/x/pull?repo=${encodeURIComponent(name)}`, {});
    toast(r?.pulled ? `Pulled ${plural(r.pulled, 'commit')} into ${name}` : `${name} is already up to date`);
    ctx.onChange?.();
    load();
  } catch (e) {
    toast(e.message || `Couldn't pull ${name}`);
    if (btn) { btn.disabled = false; btn.classList.remove('is-busy'); }
  }
}

// A day on the heatmap opens beside the page: what you committed that day, per repo.
function openDay(t) {
  if (dayPanel?.day === t) { dayPanel.m.close(); return; }
  const commits = (ctx.repos || []).flatMap((r) => r.commits).filter((c) => dayAt(c.t) === t).sort((x, y) => y.t - x.t);
  const by = new Map();
  for (const c of commits) { if (!by.has(c.repo)) by.set(c.repo, []); by.get(c.repo).push(c); }
  const row = (c) => `<li class="dp-row">
      <span class="dp-t mono">${clock.format(c.t)}</span>
      ${c.url ? `<a class="dp-s" href="${esc(c.url)}" target="_blank" rel="noopener" title="${esc(c.subject)}">${esc(c.subject)}</a>` : `<span class="dp-s" title="${esc(c.subject)}">${esc(c.subject)}</span>`}
      <span class="dp-n mono">${c.add ? `<span class="a">+${fmt.format(c.add)}</span>` : ''}${c.del ? ` <span class="d">−${fmt.format(c.del)}</span>` : ''}</span>
    </li>`;
  const body = `<div class="dp">
    <p class="dp-sum muted">${plural(commits.length, 'commit')} in ${plural(by.size, 'repo')}</p>
    ${[...by].map(([repo, cs]) => `<section class="dp-repo">
      <div class="dp-h"><button class="hv-wname" data-dp-open="${esc(repo)}">${esc(repo)}</button><span class="mono muted">${plural(cs.length, 'commit')}</span></div>
      <ul>${cs.map(row).join('')}</ul>
    </section>`).join('')}
  </div>`;
  const m = modal({ title: dayLong.format(t), body, side: true, onClose: () => { if (dayPanel?.m === m) { dayPanel = null; mark(); } } });
  m.el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-dp-open]');
    if (b) { m.close(); ctx.go(b.dataset.dpOpen, 'week'); }
  });
  dayPanel = { day: t, m };
  mark();
}
const mark = () => host?.querySelectorAll('.hm-c[data-day]').forEach((el) => el.classList.toggle('is-picked', +el.dataset.day === dayPanel?.day));

function onClick(e) {
  let b;
  if (e.target.closest('[data-retry]')) { data = null; draw(); return load(); }
  if ((b = e.target.closest('[data-fold]'))) { const n = b.dataset.fold; folded.has(n) ? folded.delete(n) : folded.add(n); saveFolded(); return draw(); }
  if ((b = e.target.closest('[data-day]'))) return openDay(+b.dataset.day);
  if (e.target.closest('[data-stmt]')) return openStatement();
  if ((b = e.target.closest('[data-commit]'))) return ctx.go(b.dataset.commit, 'commit');
  if ((b = e.target.closest('[data-pull]'))) return pull(b.dataset.pull, b);
  if ((b = e.target.closest('[data-open]'))) { const r = (data?.repos || []).find((x) => x.name === b.dataset.open); return ctx.go(b.dataset.open, r?.dirty ? 'commit' : 'week'); }
  // Pushing always goes through the cart (hold to push, then the receipt).
  if ((b = e.target.closest('[data-cart]'))) return ctx.openCart(b.dataset.cart);
  if ((b = e.target.closest('[data-run-repo]'))) return ctx.openRun?.(b.dataset.runRepo);
  if ((b = e.target.closest('[data-run-open]'))) return api(`/api/run/open?repo=${encodeURIComponent(b.dataset.runOpen)}`, { id: b.dataset.id }).catch(() => {});
  if ((b = e.target.closest('[data-run-stop]'))) { b.disabled = true; return api(`/api/run/stop?repo=${encodeURIComponent(b.dataset.runStop)}`, { id: b.dataset.id }).then(() => ctx.refreshRunning?.(), () => { b.disabled = false; }); }
}
