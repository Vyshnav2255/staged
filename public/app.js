import { icon } from './icons.js';
import { mountCommit, refreshCommit, setPanelRoute, openPanel, practiceCart, openStatement, renameLast, applyStyle, learnedStyle } from './commit-view.js';
import { mountTree } from './tree.js';
import { mountHome } from './today.js';
import { mountReadme } from './readme.js';
import { mountAbout } from './about.js';
import { mountSettings } from './settings.js';
import { openProjectSettings } from './project.js';
import { openRun, loadRun, running, runCache, runCommand, onRunChange } from './run.js';
import { initUpdates } from './update.js';
import { previewCommit } from './fx.js';
import { soundOn, setSound } from './sfx.js';
import { initSegs, initFluidHover, initMotionSystem, enter } from './motion.js';
import { initPalette, open as openPalette } from './palette.js';
import { openStory, releasePanel, openRelease, openChangelog } from './release.js';
import { api, hostOf, commitUrl, esc, compact, ago, dShort, dLong, toast, closeDock, syncDock } from './ui.js';

// ---------- constants ----------
const TYPES = ['feature', 'ui', 'fix', 'perf', 'refactor', 'other'];
const TYPE_LABEL = { feature: 'Feature', ui: 'Design', fix: 'Fix', perf: 'Perf', refactor: 'Chore', other: 'Other' };
const NOTES_LABEL = { feature: 'New', ui: 'Design', fix: 'Fixes', perf: 'Performance', refactor: 'Maintenance', other: 'Other' };
const RANGES = { '4w': 4, '12w': 12, '1y': 52, all: Infinity };
const DAY = 86400000;
const WEEK = 7 * DAY;

const $ = (s) => document.querySelector(s);
const fmt = new Intl.NumberFormat('en');
const dMonth = new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric' });
const dTime = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

function weekStart(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}
function monthStart(t) { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); }
function weekLabel(ws) {
  const we = ws + 6 * DAY;
  const a = new Date(ws), b = new Date(we);
  const thisWeek = weekStart(Date.now());
  const prefix = ws === thisWeek ? 'This week' : ws === thisWeek - WEEK ? 'Last week' : '';
  const range = a.getMonth() === b.getMonth()
    ? `${a.getDate()} – ${dShort.format(b)}`
    : `${dShort.format(a)} – ${dShort.format(b)}`;
  const year = b.getFullYear() !== new Date().getFullYear() ? ' ' + b.getFullYear() : '';
  return prefix ? `${prefix} · ${range}` : range + year;
}

// ---------- state ----------
const VIEWS = ['week', 'feature', 'release', 'tree', 'commit', 'readme', 'settings', 'about'];
const PANE_VIEWS = ['tree', 'commit', 'readme', 'settings', 'about'];
const GLOBAL_VIEWS = ['readme', 'settings', 'about'];
const isHome = () => state.repo === 'all' && state.view === 'week';
const state = { repoState: null, data: null, repo: 'all', view: 'week', range: '12w', q: '', off: new Set(), open: new Set(), expanded: new Set() };

function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('repo')) state.repo = h.get('repo');
  if (VIEWS.includes(h.get('view'))) state.view = h.get('view');
  if (RANGES[h.get('range')]) state.range = h.get('range');
}
function writeHash() {
  const h = new URLSearchParams({ repo: state.repo, view: state.view, range: state.range });
  history.replaceState(null, '', '#' + h);
}

// ---------- data ----------
async function load() {
  try {
    const res = await fetch('/api/repos');
    const data = await res.json();
    for (const r of data.repos) {
      for (const c of r.commits) { c.t = Date.parse(c.date); c.repo = r.name; c.url = commitUrl(r, c.sha); }
      r.last = r.commits[0]?.t || 0;
    }
    data.repos.sort((a, b) => b.last - a.last);
    state.data = data;
    if (state.repo !== 'all' && !data.repos.some((r) => r.name === state.repo)) state.repo = 'all';
    render();
  } catch (e) {
    $('#list').innerHTML = `<div class="empty"><h3>Couldn't read your repos</h3><p>${esc(e.message)}</p></div>`;
  }
}

function currentRepos() {
  return state.repo === 'all' ? state.data.repos : state.data.repos.filter((r) => r.name === state.repo);
}
function allCommits() {
  const list = currentRepos().flatMap((r) => r.commits);
  return state.repo === 'all' ? list.sort((a, b) => b.t - a.t) : list;
}
// Releases always show every release, so the time range doesn't apply there.
function range() { return state.view === 'release' ? 'all' : state.range; }
function rangeStart() {
  const n = RANGES[range()];
  return n === Infinity ? -Infinity : weekStart(Date.now()) - (n - 1) * WEEK;
}
function matches(c) {
  if (state.off.has(c.type)) return false;
  if (!state.q) return true;
  const q = state.q.toLowerCase();
  return c.subject.toLowerCase().includes(q) || c.areas.some((a) => a.toLowerCase().includes(q)) || c.sha.startsWith(q) || c.repo.toLowerCase().includes(q);
}
function visible() {
  const start = rangeStart();
  return allCommits().filter((c) => c.t >= start && matches(c));
}

// ---------- render: chrome ----------
function renderSidebar() {
  const repos = state.data.repos;
  const nameOf = (r) => `<span class="repo-name">${r.remote ? `<span class="repo-host" title="On ${esc(hostOf(r).name)}">${icon(hostOf(r).icon, 14)}</span>` : `<span class="repo-host is-local" title="Local only">${icon('Folder01', 14)}</span>`}<span class="repo-label">${esc(r.name)}</span>${r.dirty ? `<span class="repo-dirty" title="${r.dirty} uncommitted"></span>` : ''}</span>`;
  let html = `<div class="side-top">
    <button class="repo is-home" data-home aria-current="${state.repo === 'all' && !GLOBAL_VIEWS.includes(state.view)}">
      <span class="repo-name"><span class="repo-host">${icon('Home01', 14)}</span><span class="repo-label">Home</span></span>
    </button>
  </div>
  <div class="side-sec"><span class="side-sec-h mono">Repos</span>${repos.length > 6 ? `<label class="side-filter">${icon('Search01', 13)}<input id="repoFilter" type="search" placeholder="Filter" value="${esc(state.sideQ || '')}" autocomplete="off" spellcheck="false" aria-label="Filter repos"></label>` : ''}</div>
  <div class="repo-list scroll-fade"><i class="repo-hover" aria-hidden="true"></i>`;
  for (const r of repos) {
    const meta = r.last ? ago(r.last) : 'no commits';
    const hide = state.sideQ && !r.name.toLowerCase().includes(state.sideQ.toLowerCase());
    html += `<button class="repo" data-repo="${esc(r.name)}" aria-current="${state.repo === r.name && !GLOBAL_VIEWS.includes(state.view)}" title="${esc(r.name)}"${hide ? ' hidden' : ''}>
      ${nameOf(r)}
      <span class="repo-meta mono">${esc(meta)}</span>
    </button>`;
  }
  html += `<p class="side-empty muted" ${repos.some((r) => !state.sideQ || r.name.toLowerCase().includes(state.sideQ.toLowerCase())) ? 'hidden' : ''}>No repo matches</p></div>`;
  $('#repos').innerHTML = html;
}

function renderHeader() {
  const repos = currentRepos();
  const gh = $('#ghLink');
  if (state.repo === 'all') {
    $('#title').textContent = greeting();
    $('#meta').innerHTML = `<span>${icon('Calendar03', 13)}${new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date())}</span>`;
    gh.hidden = true;
  } else {
    const r = repos[0];
    $('#title').textContent = r.name;
    $('#meta').innerHTML = `<span>${icon('GitBranch', 13)}${esc(r.branch)}</span>`;
    gh.hidden = !r.remote;
    gh.href = r.remote || '#';
    { const h = hostOf(r); gh.innerHTML = icon(h.icon, 16); gh.title = `Open ${r.name} on ${h.name}`; gh.setAttribute('aria-label', gh.title); }
    const rs = state.repoState && state.repoState.repo === r.name ? state.repoState : null;
    if (rs && rs.behind) $('#meta').innerHTML += `<span>${icon('ArrowDown01', 13)}${rs.behind} behind</span>`;
  }
  const push = $('#pushBtn');
  const rs2 = state.repo !== 'all' && state.repoState && state.repoState.repo === state.repo ? state.repoState : null;
  push.hidden = !(rs2 && rs2.ahead && !GLOBAL_VIEWS.includes(state.view));
  push.innerHTML = `${icon('ShoppingCart01', 16)}<span>Cart</span><b>${rs2?.ahead || ''}</b>`;
  push.title = 'Open the cart';
  $('#projectBtn').hidden = state.repo === 'all' || GLOBAL_VIEWS.includes(state.view);
  paintRunBtn();
  syncDock(GLOBAL_VIEWS.includes(state.view) ? 'all' : state.repo);
  $('#readmeLink').setAttribute('aria-current', state.view === 'readme');
  $('#settingsLink').setAttribute('aria-current', state.view === 'settings');
  $('#aboutLink').setAttribute('aria-current', state.view === 'about');
  if (GLOBAL_VIEWS.includes(state.view)) $('#runBtn').hidden = true;
  if (state.view === 'readme') { $('#title').textContent = 'README'; $('#meta').innerHTML = '<span>How staged works</span>'; gh.hidden = true; push.hidden = true; }
  if (state.view === 'about') { $('#title').textContent = 'About'; $('#meta').innerHTML = ''; gh.hidden = true; push.hidden = true; }
  if (state.view === 'settings') { $('#title').textContent = 'Settings'; $('#meta').innerHTML = '<span>Repos, sound and updates</span>'; gh.hidden = true; push.hidden = true; }
  const viewTabs = [...document.querySelectorAll('#viewSeg button')];
  const hasViewTab = viewTabs.some((b) => b.dataset.v === state.view);
  for (const b of viewTabs) {
    const selected = b.dataset.v === state.view;
    b.setAttribute('aria-selected', selected);
    b.tabIndex = selected || (!hasViewTab && b.dataset.v === 'week') ? 0 : -1;
  }
  // A dot while there are changes; the commit view puts the number of commits here once it has sorted them.
  const dirty = repos.reduce((s, r) => s + (r.dirty || 0), 0), dc = $('#dirtyCount');
  if (!dirty) { dc.textContent = ''; dc.classList.remove('is-dot'); }
  else if (dc.dataset.repo !== state.repo || !dc.textContent) { dc.textContent = ''; dc.classList.add('is-dot'); }
  for (const b of document.querySelectorAll('#rangeSeg button')) b.setAttribute('aria-selected', b.dataset.r === state.range);
}

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

// ---------- render: stats ----------
function renderStats(list) {
  const n = RANGES[range()];
  let prev = null;
  if (n !== Infinity) {
    const end = rangeStart();
    const start = end - n * WEEK;
    prev = allCommits().filter((c) => c.t >= start && c.t < end && matches(c));
  }
  const sum = (l) => ({ commits: l.length, add: l.reduce((s, c) => s + c.add, 0), del: l.reduce((s, c) => s + c.del, 0), feat: l.filter((c) => c.type === 'feature').length });
  const a = sum(list), b = prev && sum(prev);
  // The comparison is named once, on the first tile; the others just show the change.
  const delta = (k, first) => {
    if (!b) return first ? '<div class="stat-delta">all time</div>' : '';
    const d = k === 'lines' ? (a.add + a.del) - (b.add + b.del) : a[k] - b[k];
    const cls = d === 0 ? '' : d > 0 ? 'up' : 'down';
    return `<div class="stat-delta mono ${cls}">${d === 0 ? 'same' : `${d > 0 ? '+' : '−'}${compact(Math.abs(d))}`}${first ? ` vs previous ${range()}` : ''}</div>`;
  };
  // Repo weight: what the repo weighs now, and how much it grew or shrank across the range.
  const ws = weightSeries(repo), wsum = weightSummary(repo);
  let wd = '';
  if (ws && ws.v.length) {
    const from = n === Infinity ? -Infinity : rangeStart();
    let before = 0;
    ws.t.forEach((t, i) => { if (t < from) before = ws.v[i]; });
    const d = ws.v[ws.v.length - 1] - (n === Infinity ? 0 : before);
    wd = `<div class="stat-delta mono ${d > 0 ? 'heavier' : d < 0 ? 'up' : ''}">${Math.abs(d) < 1024 ? 'same' : `${d > 0 ? '+' : '−'}${fmtBytes(Math.abs(d))}`}${n === Infinity ? ' all time' : ` in ${range()}`}</div>`;
  }
  el.innerHTML = [
    ['Commits', fmt.format(a.commits), delta('commits', true)],
    ['Lines changed', `${compact(a.add + a.del)} <small><span style="color:var(--add)">+${compact(a.add)}</span> <span style="color:var(--del)">−${compact(a.del)}</span></small>`, delta('lines')],
    ['Features shipped', fmt.format(a.feat), delta('feat')],
    ['Repo weight', wsum ? fmtBytes(wsum.total) : ws ? fmtBytes(0) : '…', wd],
  ].map(([l, v, d]) => `<div class="stat"><div class="stat-label">${l}</div><div class="stat-value">${v}</div>${d}</div>`).join('');
}
// the week under the pointer is banded through every lane and read out in words
function statsHover(e) {
  const host = $('#stats'), plot = e.type === 'mouseleave' ? null : e.target.closest?.('.tl-plot'), read = host.querySelector('.tl-read');
  if (!plot || !read) { host.classList.remove('is-hover'); return; }
  const cols = plot.querySelectorAll('.tl-col'), r = plot.querySelector('.tl-cols').getBoundingClientRect();
  const i = Math.min(cols.length - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * cols.length)));
  plot.style.setProperty('--ci', i); read.textContent = cols[i].dataset.tip; host.classList.add('is-hover');
}

// ---------- render: chart ----------
function renderLegend() {
  const start = rangeStart(), seen = new Set(allCommits().filter((c) => c.t >= start).map((c) => c.type));
  $('#legend').innerHTML = TYPES.filter((t) => seen.has(t) || state.off.has(t)).map((t) =>
    `<button data-type="${t}" aria-pressed="${!state.off.has(t)}" title="Show or hide ${TYPE_LABEL[t]}"><span class="dot" style="background:var(--t-${t})"></span>${TYPE_LABEL[t]}</button>`).join('');
}

function renderChart(list) {
  const el = $('#chart');
  const n = RANGES[range()];
  const oldest = list.length ? list[list.length - 1].t : Date.now();
  const spanWeeks = n === Infinity ? Math.ceil((Date.now() - oldest) / WEEK) + 1 : n;
  const monthly = spanWeeks > 60;
  $('#chartTitle').textContent = monthly ? 'Commits per month' : 'Commits per week';

  const buckets = [];
  if (monthly) {
    const d = new Date(monthStart(oldest));
    const end = monthStart(Date.now());
    while (d.getTime() <= end) { buckets.push(d.getTime()); d.setMonth(d.getMonth() + 1); }
  } else {
    const end = weekStart(Date.now());
    for (let i = spanWeeks - 1; i >= 0; i--) buckets.push(end - i * WEEK);
  }
  const idx = new Map(buckets.map((b, i) => [b, i]));
  const data = buckets.map(() => Object.fromEntries(TYPES.map((t) => [t, 0])));
  for (const c of list) {
    const k = monthly ? monthStart(c.t) : weekStart(c.t);
    const i = idx.get(k);
    if (i !== undefined) data[i][c.type]++;
  }
  const totals = data.map((d) => TYPES.reduce((s, t) => s + d[t], 0));
  const max = Math.max(4, ...totals);
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;

  const W = el.clientWidth || 800, H = el.clientHeight || 168;
  const padL = 28, padB = 20, padT = 4;
  const iw = W - padL, ih = H - padB - padT;
  const bw = iw / buckets.length;
  const barW = Math.max(2, Math.min(28, bw - Math.max(2, bw * 0.28)));
  const y = (v) => padT + ih - (v / top) * ih;

  let grid = '', axis = '';
  for (let v = 0; v <= top; v += step) {
    grid += `<line x1="${padL}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/>`;
    axis += `<text x="${padL - 8}" y="${y(v) + 3}" text-anchor="end">${v}</text>`;
  }
  const labelEvery = Math.ceil(buckets.length / Math.max(1, Math.floor(iw / 64)));
  let cols = '';
  buckets.forEach((b, i) => {
    const x = padL + i * bw + (bw - barW) / 2;
    let acc = 0, segs = '';
    const present = TYPES.filter((t) => data[i][t]);
    present.forEach((t, j) => {
      const v = data[i][t];
      const y1 = y(acc), y0 = y(acc + v);
      let h = y1 - y0 - (j < present.length - 1 ? 2 : 0);
      if (h < 1) h = 1;
      const isTop = j === present.length - 1;
      const r = Math.min(3, barW / 2, h);
      segs += isTop
        ? `<path d="${roundTop(x, y0, barW, h, r)}" fill="var(--t-${t})"/><path class="st-diag" d="${roundTop(x, y0, barW, h, r)}" fill="url(#st-diag)"/>`
        : `<rect x="${x}" y="${y0 + 2}" width="${barW}" height="${Math.max(1, h)}" fill="var(--t-${t})"/><rect class="st-diag" x="${x}" y="${y0 + 2}" width="${barW}" height="${Math.max(1, h)}" fill="url(#st-diag)"/>`;
      acc += v;
    });
    const label = i % labelEvery === 0 || i === buckets.length - 1
      ? `<text x="${x + barW / 2}" y="${H - 5}" text-anchor="middle">${monthly ? dMonth.format(b).replace(' 20', " '") : dShort.format(b)}</text>` : '';
    const detail = TYPES.filter((t) => data[i][t]).map((t) => `${TYPE_LABEL[t]}: ${data[i][t]}`).join(', ') || 'No commits';
    const chartLabel = `${monthly ? dMonth.format(b) : weekLabel(b)}. ${detail}. Total: ${totals[i]} commits${!monthly && state.view === 'week' ? '. Use left and right arrow keys to move between weeks. Press Enter to view this week' : ''}`;
    const navigable = !monthly && state.view === 'week';
    cols += `<g class="col" data-i="${i}" ${navigable ? `role="button" tabindex="${i === 0 ? 0 : -1}"` : 'role="img"'} aria-label="${esc(chartLabel)}" style="--i:${buckets.length - 1 - i}"><rect class="hit" x="${padL + i * bw}" y="${padT}" width="${bw}" height="${ih}" rx="4"/>${segs}</g>`;
    if (label && (i === buckets.length - 1 ? true : buckets.length - 1 - i >= labelEvery * 0.6)) axis += label;
  });
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="group" aria-label="${esc($('#chartTitle').textContent)}">
    <g class="grid">${grid}</g>
    <line class="baseline" x1="${padL}" x2="${W}" y1="${y(0) + .5}" y2="${y(0) + .5}"/>
    <g>${cols}</g><g class="axis">${axis}</g></svg>`;

  el.onmousemove = (e) => {
    const g = e.target.closest('.col');
    if (!g) return hideTip();
    const i = +g.dataset.i, b = buckets[i];
    const title = monthly ? dMonth.format(b) : weekLabel(b);
    const rows = TYPES.filter((t) => data[i][t]).map((t) =>
      `<div class="tip-row"><span class="dot" style="background:var(--t-${t})"></span>${TYPE_LABEL[t]}<b>${data[i][t]}</b></div>`).join('');
    showTip(e, `<div class="tip-title">${esc(title)}</div>${rows || '<div class="tip-row">No commits</div>'}<div class="tip-row" style="margin-top:4px">Total<b>${totals[i]}</b></div>`);
  };
  el.onmouseleave = hideTip;
  el.onclick = (e) => {
    const g = e.target.closest('.col');
    if (!g || monthly || state.view !== 'week') return;
    document.getElementById('w' + buckets[+g.dataset.i])?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  };
  el.onkeydown = (e) => {
    if (!e.target.matches('.col[role="button"]')) return;
    const bars = [...el.querySelectorAll('.col[role="button"]')];
    const at = bars.indexOf(e.target);
    const next = e.key === 'ArrowRight' ? Math.min(bars.length - 1, at + 1)
      : e.key === 'ArrowLeft' ? Math.max(0, at - 1)
        : e.key === 'Home' ? 0 : e.key === 'End' ? bars.length - 1 : -1;
    if (next >= 0) {
      e.preventDefault();
      bars.forEach((bar, i) => { bar.tabIndex = i === next ? 0 : -1; });
      bars[next].focus();
      return;
    }
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    const i = +e.target.dataset.i;
    const section = document.getElementById('w' + buckets[i]);
    section?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    section?.setAttribute('tabindex', '-1');
    section?.focus({ preventScroll: true });
  };
}
function roundTop(x, y, w, h, r) {
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}
function niceStep(max) {
  const raw = max / 3;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) if (raw <= m * p) return m * p;
  return 10 * p;
}

function showTip(e, html) {
  const tip = $('#tip');
  tip.innerHTML = html;
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  let x = e.clientX + 14, yy = e.clientY + 14;
  if (x + r.width > innerWidth - 8) x = e.clientX - r.width - 14;
  if (yy + r.height > innerHeight - 8) yy = e.clientY - r.height - 14;
  tip.style.left = x + 'px';
  tip.style.top = yy + 'px';
}
function hideTip() { $('#tip').hidden = true; }

// ---------- render: rows ----------
function mixBar(counts, w = 72) {
  const total = TYPES.reduce((s, t) => s + (counts[t] || 0), 0);
  if (!total) return '';
  let x = 0, out = '';
  const present = TYPES.filter((t) => counts[t]);
  present.forEach((t, i) => {
    const cw = (counts[t] / total) * w;
    const gap = 0;
    out += `<rect x="${x}" y="0" width="${Math.max(1, cw - gap)}" height="6" fill="var(--t-${t})"/><rect class="st-diag" x="${x}" y="0" width="${Math.max(1, cw - gap)}" height="6" fill="url(#st-diag)"/>`;
    x += cw;
  });
  const title = present.map((t) => `${TYPE_LABEL[t]} ${counts[t]}`).join(' · ');
  return `<svg class="mix" width="${w}" height="6" viewBox="0 0 ${w} 6" preserveAspectRatio="none"><title>${title}</title>${out}</svg>`;
}
function countTypes(list) {
  const c = {};
  for (const x of list) c[x.type] = (c[x.type] || 0) + 1;
  return c;
}

function row(c) {
  const showRepo = state.repo === 'all';
  const areas = c.areas.slice(0, 3).map((a, i) => `<span class="area${i ? ' is-more' : ''}">${esc(a)}</span>`).join('') + (c.areas.length > 3 ? `<span class="area is-more">+${c.areas.length - 3}</span>` : '');
  const d = new Date(c.t);
  const when = Date.now() - c.t < 6 * DAY ? ago(c.t) : dShort.format(d);
  const sha = c.sha.slice(0, 7);
  return `<div class="row">
    <span class="type ${c.guessed ? 'guessed' : ''}" style="--c:var(--t-${c.type})" title="${c.guessed ? 'Guessed from the message' : esc(c.mark || TYPE_LABEL[c.type])}"><span class="dot" style="background:var(--t-${c.type})"></span>${TYPE_LABEL[c.type]}</span>
    <span class="subject"><span class="subject-text">${esc(c.text || c.subject)}</span>${areas ? `<span class="areas">${areas}</span>` : ''}</span>
    ${showRepo ? `<span class="repo-tag">${esc(c.repo)}</span>` : ''}
    <span class="lines mono"><span class="a">+${compact(c.add)}</span> <span class="d">−${compact(c.del)}</span></span>
    ${c.url ? `<a class="sha mono" href="${esc(c.url)}" target="_blank" rel="noopener" title="${esc(c.author)} · ${dLong.format(d)} ${dTime.format(d)}">${sha}</a>` : `<span class="sha mono" title="${esc(c.author)}">${sha}</span>`}
    <span class="when mono" title="${dLong.format(d)} ${dTime.format(d)}">${when}</span>
  </div>`;
}

const PAGE = 8;
function group(id, title, sub, commits, opts = {}) {
  const open = state.open.has(id);
  const shown = open ? commits : commits.slice(0, PAGE);
  const add = commits.reduce((s, c) => s + c.add, 0), del = commits.reduce((s, c) => s + c.del, 0);
  return `<section class="group" id="${id}">
    <div class="group-head">
      <span class="group-title">${esc(title)}</span>
      <span class="group-sub mono">${sub ? esc(sub) + ' · ' : ''}${commits.length} commit${commits.length === 1 ? '' : 's'} · +${compact(add)} −${compact(del)}</span>
      ${mixBar(countTypes(commits)).replace('class="mix"', 'class="group-mix"')}
    </div>
    ${shown.map(row).join('')}
    ${commits.length > PAGE ? `<div class="more"><button class="text-btn" data-toggle="${id}">${open ? 'Show less' : `Show ${commits.length - PAGE} more`}</button></div>` : ''}
  </section>`;
}

let notesSource = new Map(), notesRange = null;
let featureIndex = new Map();

function renderWeek(list) {
  if (!list.length) return emptyState();
  const weeks = new Map();
  for (const c of list) {
    const k = weekStart(c.t);
    if (!weeks.has(k)) weeks.set(k, []);
    weeks.get(k).push(c);
  }
  let html = '';
  for (const [k, commits] of weeks) {
    const id = 'w' + k;
    notesSource.set(id, { title: weekLabel(k), commits });
    html += group(id, weekLabel(k), '', commits);
  }
  return html;
}

function renderFeature(list) {
  if (!list.length) return emptyState();
  const map = new Map();
  for (const c of list) {
    const areas = c.areas.length ? c.areas : ['Unsorted'];
    for (const a of areas.slice(0, 3)) {
      const key = (state.repo === 'all' ? c.repo + ' / ' : '') + a;
      if (!map.has(key)) map.set(key, { name: a, repo: c.repo, key, commits: [] });
      map.get(key).commits.push(c);
    }
  }
  featureIndex = map;
  const feats = [...map.values()].sort((a, b) => b.commits[0].t - a.commits[0].t || b.commits.length - a.commits.length);
  const limit = state.open.has('features') ? feats.length : 30;
  let html = `<div class="cols"><span>Feature or area</span><span>Change mix</span><span>Commits</span><span>Lines</span><span>Last change</span><span></span></div>`;
  for (const f of feats.slice(0, limit)) {
    const add = f.commits.reduce((s, c) => s + c.add, 0), del = f.commits.reduce((s, c) => s + c.del, 0);
    const exp = state.expanded.has(f.key);
    html += `<button class="feat" data-feat="${esc(f.key)}" aria-expanded="${exp}">
      <span class="feat-name">${esc(f.name)}${state.repo === 'all' ? `<span class="mono">${esc(f.repo)}</span>` : ''}</span>
      <span>${mixBar(countTypes(f.commits), 96)}</span>
      <span class="mono">${f.commits.length}</span>
      <span class="mono lines"><span class="a">+${compact(add)}</span> <span class="d">−${compact(del)}</span></span>
      <span class="mono when" style="text-align:left">${ago(f.commits[0].t)}</span>
      <span class="chev">${icon('ArrowRight01', 14)}</span>
    </button>`;
    if (exp) {
      const id = 'f' + hash(f.key);
      notesSource.set(id, { title: f.name, commits: f.commits });
      const open = state.open.has(id);
      const shown = open ? f.commits : f.commits.slice(0, PAGE);
      html += `<div class="feat-body">${shown.map(row).join('')}
        <div class="more">${f.commits.length > PAGE ? `<button class="text-btn" data-toggle="${id}">${open ? 'Show less' : `Show ${f.commits.length - PAGE} more`}</button>` : ''}
        <button class="text-btn" data-story="${esc(f.key)}">${icon('Note01', 14)}Read its story</button></div></div>`;
    }
  }
  if (feats.length > 30) html += `<div class="more"><button class="text-btn" data-toggle="features">${state.open.has('features') ? 'Show fewer' : `Show all ${feats.length} areas`}</button></div>`;
  return html;
}

function renderRelease(list) {
  const repos = currentRepos();
  const tagged = repos.filter((r) => r.tags.length);
  const panel = state.repo !== 'all' ? releasePanel(repos[0]) : '';
  if (!tagged.length) {
    if (panel) return panel;
    return `<div class="empty">
      <h3>No releases yet</h3>
      <p>${state.repo === 'all' ? 'None of these repos has tags.' : `${esc(state.repo)} has no tags.`} Tag a commit when you ship and it shows up here as a release, with notes written from the commits since the last one.</p>
      <p style="margin-top:10px"><code>git tag v0.1 &amp;&amp; git push --tags</code></p>
    </div>`;
  }
  const keep = new Set(list.map((c) => c.sha + c.repo));
  let html = panel, rows = '';
  const seenLatest = new Set();
  for (const r of tagged) {
    const sections = [];
    let cur = { name: 'Unreleased', date: null, commits: [] };
    for (const c of r.commits) {
      if (c.tags.length) {
        if (cur.commits.length || cur.name !== 'Unreleased') sections.push(cur);
        // Several tags on one commit: the newest is its own release with nothing new in it.
        const names = [...c.tags].sort((x, y) => y.localeCompare(x, undefined, { numeric: true }));
        for (const n of names.slice(0, -1)) sections.push({ name: n, date: c.t, commits: [], same: names[names.length - 1] });
        cur = { name: names[names.length - 1], date: c.t, commits: [] };
      }
      cur.commits.push(c);
    }
    sections.push(cur);
    for (const s of sections) {
      const commits = s.commits.filter((c) => keep.has(c.sha + c.repo));
      if (s.name === 'Unreleased') continue; // the panel above already says what's waiting
      if (!commits.length && !(s.same && !state.q && !state.off.size)) continue;
      const id = 'r' + hash(r.name + s.name);
      const title = (state.repo === 'all' ? r.name + ' ' : '') + s.name;
      const open = state.expanded.has(id);
      const isNew = s.name === 'Unreleased', latest = !isNew && !seenLatest.has(r.name);
      if (!isNew) seenLatest.add(r.name);
      notesSource.set(id, { title, commits });
      rows += `<div class="rl-item${open ? ' is-open' : ''}${isNew ? ' is-new' : ''}">
        <button class="rl-row" data-feat="${id}" aria-expanded="${open}" ${commits.length ? '' : 'disabled'}>
          <span class="rl-name">${esc(title)}</span>${latest ? '<span class="rl-badge mono">Latest</span>' : ''}
          <span class="rl-date mono">${s.date ? esc(dLong.format(s.date)) : ''}</span>
          ${commits.length ? icon('ArrowRight01', 14) : '<i></i>'}
        </button>
        ${open ? `<div class="rl-body">${commits.map(row).join('')}<div class="more"><button class="text-btn" data-notes="${id}">${icon('Copy01', 14)}Copy notes</button></div></div>` : ''}
      </div>`;
    }
  }
  if (rows) html += `<div class="rl-list">${rows}</div>`;
  const untagged = repos.length - tagged.length;
  if (state.repo === 'all' && untagged) html += `<p class="note" style="margin-top:0">${untagged} other repos have no tags yet.</p>`;
  return html || emptyState();
}

function emptyState() {
  return `<div class="empty"><h3>Nothing here</h3><p>No commits match this range${state.q ? ' and search' : ''}${state.off.size ? ' with those types hidden' : ''}.</p></div>`;
}
function hash(s) { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0; return (h >>> 0).toString(36); }

function pane(name) {
  let el = document.getElementById('pane-' + name);
  if (!el) { el = document.createElement('section'); el.id = 'pane-' + name; el.className = 'pane'; $('#list').after(el); }
  return el;
}

async function refreshRepoState() {
  if (state.repo === 'all') return;
  const name = state.repo;
  loadRun(name);
  try {
    const s = await api(`/api/x/state?repo=${encodeURIComponent(name)}`);
    state.repoState = { ...s, repo: name };
    if (state.data && state.repo === name) renderHeader();
  } catch {}
}

function ctxFor(view) {
  const r = state.data.repos.find((x) => x.name === state.repo);
  return {
    repo: state.repo, view, q: state.q, repos: state.data.repos, remote: r?.remote || '', host: hostOf(r), commitUrl: (sha) => commitUrl(r, sha),
    pickRepo: (name) => { state.repo = name; render(); },
    go: (name, v) => { state.repo = name; state.view = v; render(); scrollTo({ top: 0 }); },
    openCart: (name) => { state.repo = name; state.view = 'week'; state.repoState = null; render(); refreshRepoState(); scrollTo({ top: 0 }); openPanel(); },
    onChange: () => { load(false); refreshRepoState(); },
    openSettings,
    typeOf: (() => { const m = new Map((r?.commits || []).map((c) => [c.sha, c.type])); return (sha) => m.get(sha) || null; })(),
  };
}

let lastPlace = '';
function render() {
  if (!state.data) return;
  writeHash();
  const place = state.repo + '|' + state.view;
  const moved = lastPlace && place !== lastPlace;
  lastPlace = place;
  if (moved) requestAnimationFrame(() => document.querySelectorAll('.main > :not(.head):not([hidden])').forEach((x) => { if (!x.matches('.controls')) enter(x); }));
  renderSidebar();
  renderHeader();
  { const r = state.data.repos.find((x) => x.name === state.repo); setPanelRoute({ repo: state.repo, view: state.view, remote: r?.remote || '', provider: r?.provider || '' }, () => { refreshRepoState(); load(false); }); }
  const v = state.view;
  const main = document.querySelector('.main');
  for (const x of VIEWS) main.classList.toggle('is-' + x, x === v);
  main.classList.toggle('is-home', isHome());
  const homeEl = $('#home');
  homeEl.hidden = !isHome();
  if (isHome()) { mountHome(homeEl, ctxFor('home')); for (const x of PANE_VIEWS) { const el = document.getElementById('pane-' + x); if (el) el.hidden = true; } return; }
  main.classList.toggle('is-pane', PANE_VIEWS.includes(v));
  $('#q').placeholder = v === 'commit' ? 'Filter files' : v === 'tree' ? 'Find in tree' : 'Search changes';
  for (const x of PANE_VIEWS) { const el = document.getElementById('pane-' + x); if (el) el.hidden = x !== v; }
  $('#list').hidden = PANE_VIEWS.includes(v);
  if (PANE_VIEWS.includes(v)) {
    const el = pane(v);
    el.hidden = false;
    if (v === 'readme') return mountReadme(el);
    if (v === 'settings') return openSettingsPane(el);
    if (v === 'about') return openAboutPane(el);
    if (state.repo === 'all') return pickRepoPane(el, v);
    if (v === 'commit') return mountCommit(el, ctxFor(v));
    if (v === 'tree') return mountTree(el, ctxFor(v));
  }
  renderLegend();
  const list = visible();
  renderStats(list);
  notesRange = { title: range() === 'all' ? 'All changes' : `Last ${state.range}`, commits: list };
  renderChart(list);
  notesSource = new Map();
  const listEl = $('#list');
  listEl.classList.toggle('all-repos', state.repo === 'all');
  listEl.innerHTML = v === 'week' ? renderWeek(list) : v === 'feature' ? renderFeature(list) : renderRelease(list);
}

// Settings is its own page. Commit and Home can open it at a section.
let settingsSection = '', meta = null;
function openSettings(section = '') {
  if (!GLOBAL_VIEWS.includes(state.view)) state.lastView = state.view;
  settingsSection = section; state.view = 'settings'; render(); if (!section) scrollTo({ top: 0 });
}
async function openSettingsPane(el) {
  if (!meta) meta = await api('/api/update').catch(() => ({})).then((u) => ({ version: u.current || '' }));
  const section = settingsSection; settingsSection = '';
  await mountSettings(el, { ...meta, section, onChange: () => refreshCommit(), onRepos: () => load(false) });
}

function openAbout() {
  if (!GLOBAL_VIEWS.includes(state.view)) state.lastView = state.view;
  state.view = 'about'; render(); scrollTo({ top: 0 });
}
async function openAboutPane(el) {
  if (!meta) { meta = await api('/api/update').catch(() => ({})).then((u) => ({ version: u.current || '' })); renderHeader(); }
  mountAbout(el, meta);
}

function pickRepoPane(el, v) {
  const what = { commit: 'commit changes in', tree: 'see the tree of' }[v];
  const repos = v === 'commit' ? state.data.repos.filter((r) => r.dirty).sort((a, b) => b.dirty - a.dirty) : state.data.repos;
  el.innerHTML = repos.length ? `<p class="note">Pick a repo to ${what}.</p><div class="cm-repos">${repos.map((r) => `<button class="cm-repo" data-pickrepo="${esc(r.name)}">
      <span class="feat-name">${esc(r.name)}</span><span class="mono muted">${v === 'commit' ? `${r.dirty} uncommitted file${r.dirty > 1 ? 's' : ''}` : `${fmt.format(r.commits.length)} commits · ${r.last ? ago(r.last) : ''}`}</span>${icon('ArrowRight01', 14)}
    </button>`).join('')}</div>` : `<div class="empty"><h3>Everything is committed</h3><p>None of your repos has uncommitted changes.</p></div>`;
  el.onclick = (e) => { const b = e.target.closest('[data-pickrepo]'); if (b) { el.onclick = null; state.repo = b.dataset.pickrepo; render(); refreshRepoState(); } };
}

// ---------- notes ----------
function notes(id) {
  const src = id === 'range' ? notesRange : notesSource.get(id);
  if (!src) return;
  let md = `## ${src.title}\n`;
  for (const t of TYPES) {
    const cs = src.commits.filter((c) => c.type === t);
    if (!cs.length) continue;
    md += `\n### ${NOTES_LABEL[t]}\n`;
    for (const c of cs) md += `- ${c.text || c.subject}${state.repo === 'all' ? ` (${c.repo})` : ''} \`${c.sha.slice(0, 7)}\`\n`;
  }
  navigator.clipboard.writeText(md).then(() => toast('Release notes copied'), () => toast("Couldn't copy"));
}
// ---------- events ----------
$('#searchIcon').innerHTML = icon('Search01', 15);
// Run: the project's own commands. The button says "Running" with a live dot while any of them is.
function paintRunBtn() {
  const b = $('#runBtn'), repo = state.repo;
  b.hidden = repo === 'all' || GLOBAL_VIEWS.includes(state.view);
  const n = running(repo).length;
  b.classList.toggle('is-live', n > 0);
  b.innerHTML = n ? `<i class="run-dot" aria-hidden="true"></i><span>Running${n > 1 ? ` ${n}` : ''}</span>` : `${icon('Play', 15)}<span>Run</span>`;
  b.title = n ? running(repo).map((j) => j.label).join(', ') : 'Run this project';
}
onRunChange((repo) => { if (repo === state.repo) paintRunBtn(); });
$('#runBtn').addEventListener('click', () => openRun(state.repo));
// Keep the dot honest when something stops on its own (a build finishing) while the panel is closed.
setInterval(() => { if (state.repo !== 'all' && running(state.repo).length && !document.hidden) loadRun(state.repo); }, 5000);
$('#projectBtn').innerHTML = icon('Settings02', 16);
const projectSettings = () => openProjectSettings(state.repo, { learned: learnedStyle(state.repo), onChange: () => applyStyle(state.repo) });
$('#projectBtn').addEventListener('click', projectSettings);
addEventListener('staged:project-settings', projectSettings);
$('#readmeLink').innerHTML = `${icon('BookOpen01', 15)}<span>README</span>`;
$('#settingsLink').innerHTML = `${icon('Settings02', 15)}<span>Settings</span>`;
$('#settingsLink').addEventListener('click', () => openSettings());
$('#aboutLink').innerHTML = `${icon('InformationCircle', 15)}<span>About</span>`;
$('#aboutLink').addEventListener('click', openAbout);
initUpdates(document.querySelector('.side'));
initMotionSystem();
initSegs();
initFluidHover($('#repos'));
$('#readmeLink').addEventListener('click', () => { if (!GLOBAL_VIEWS.includes(state.view)) state.lastView = state.view; state.view = 'readme'; render(); scrollTo({ top: 0 }); });

$('#repos').addEventListener('input', (e) => {
  if (e.target.id !== 'repoFilter') return;
  state.sideQ = e.target.value.trim();
  const q = state.sideQ.toLowerCase();
  let any = false;
  for (const b of $('#repos').querySelectorAll('.repo-list [data-repo]')) { const show = !q || b.dataset.repo.toLowerCase().includes(q); b.hidden = !show; any ||= show; }
  $('#repos').querySelector('.side-empty').hidden = any;
});
$('#repos').addEventListener('keydown', (e) => {
  if (e.target.id !== 'repoFilter') return;
  if (e.key === 'Escape') { e.target.value = ''; e.target.dispatchEvent(new Event('input', { bubbles: true })); e.target.blur(); }
  if (e.key === 'Enter') { const first = $('#repos').querySelector('.repo-list [data-repo]:not([hidden])'); if (first) first.click(); }
});
$('#repos').addEventListener('click', (e) => {
  if (e.target.closest('[data-home]')) { goHome(); return; }
  const b = e.target.closest('[data-repo]');
  if (!b) return;
  state.repo = b.dataset.repo;
  if (GLOBAL_VIEWS.includes(state.view)) state.view = state.lastView && !GLOBAL_VIEWS.includes(state.lastView) ? state.lastView : 'week';
  state.open.clear(); state.expanded.clear();
  state.repoState = null;
  render();
  refreshRepoState();
  scrollTo({ top: 0 });
});
function goHome() {
  state.repo = 'all'; state.view = 'week'; state.repoState = null; state.open.clear(); state.expanded.clear();
  render(); scrollTo({ top: 0, behavior: 'smooth' });
}
$('#brandHome').addEventListener('click', (e) => { e.preventDefault(); goHome(); });
// Pushing happens in the side panel (hold to push). This button brings the panel back after you close it.
$('#pushBtn').addEventListener('click', () => { closeDock(); openPanel(); });
initPalette((q) => {
  const items = [];
  const repos = state.data ? state.data.repos : [];
  const goRepo = (name, view) => () => { state.repo = name; if (view) state.view = view; else if (GLOBAL_VIEWS.includes(state.view)) state.view = 'week'; state.repoState = null; render(); refreshRepoState(); scrollTo({ top: 0 }); };
  items.push({ group: 'Go to', label: 'Home', hint: 'what is waiting, across every repo', run: goHome });
  items.push({ group: 'Actions', label: 'Preview commit animation', hint: 'nothing is committed', run: () => setTimeout(previewCommit, 200) });
  items.push({ group: 'Actions', label: 'Try the cart and push', hint: 'practice, nothing is pushed', run: () => setTimeout(practiceCart, 200) });
  items.push({ group: 'Actions', label: "Print this week's statement", hint: 'every push this week, added up', run: () => setTimeout(openStatement, 200) });
  items.push({ group: 'Actions', label: soundOn() ? 'Turn sounds off' : 'Turn sounds on', hint: 'commit and push sounds', run: () => { setSound(!soundOn()); toast(soundOn() ? 'Sounds on' : 'Sounds off'); } });
  items.push({ group: 'Go to', label: 'Settings', hint: 'Repos, sound, updates', run: () => openSettings() });
  if (state.repo !== 'all') {
    items.push({ group: 'Run', label: 'Run…', hint: `${state.repo}: all its commands`, run: () => setTimeout(() => openRun(state.repo), 200) });
    for (const c of runCache(state.repo)?.commands || []) items.push({ group: 'Run', label: `Run ${c.label}`, hint: c.cmd, run: () => { runCommand(state.repo, c.id); toast(`Running ${c.label}${c.kind === 'serve' ? '. The page opens when it’s ready.' : ''}`); } });
  }
  if (state.repo !== 'all') items.push({ group: 'Actions', label: 'Rename last commit', hint: `${state.repo}: change its message, even after a push`, run: () => setTimeout(() => renameLast(state.repo), 200) });
  if (state.repo !== 'all') items.push({ group: 'Go to', label: 'Project settings', hint: `${state.repo}: commit message style`, run: projectSettings });
  items.push({ group: 'Go to', label: 'README', hint: 'how staged works', run: () => { state.view = 'readme'; render(); scrollTo({ top: 0 }); } });
  items.push({ group: 'Go to', label: 'About', hint: 'who makes staged, and buy me a coffee', run: openAbout });
  for (const r of repos) items.push({ group: 'Repos', label: r.name, hint: r.dirty ? `${r.dirty} uncommitted` : r.last ? ago(r.last) : '', run: goRepo(r.name) });
  const views = [['week', 'Weeks'], ['feature', 'Features'], ['release', 'Releases'], ['tree', 'Tree'], ['commit', 'Commit']];
  for (const [v, label] of views) items.push({ group: 'Views', label, hint: state.repo === 'all' ? '' : state.repo, run: () => { state.view = v; render(); } });
  const cur = repos.find((r) => r.name === state.repo);
  if (cur) {
    items.push({ group: 'Actions', label: `New release of ${cur.name}`, run: () => openRelease(cur, () => load(false)) });
    items.push({ group: 'Actions', label: `Write changelog for ${cur.name}`, run: () => openChangelog(cur, () => load(false)) });
    if (state.repoState?.ahead) items.push({ group: 'Actions', label: `Push ${cur.name}`, hint: `${state.repoState.ahead} to push`, boost: 1, run: () => $('#pushBtn').click() });
  }
  for (const r of repos.filter((x) => x.dirty)) items.push({ group: 'Actions', label: `Commit changes in ${r.name}`, hint: `${r.dirty} files`, run: goRepo(r.name, 'commit') });
  if (q.length >= 2) {
    let n = 0;
    for (const r of repos) for (const c of r.commits) {
      if (n >= 30) break;
      if (c.subject.toLowerCase().includes(q) || c.sha.startsWith(q)) { n++; items.push({ group: 'Commits', label: c.subject, hint: `${r.name} · ${ago(c.t)}`, run: () => { state.repo = r.name; state.view = 'week'; state.range = 'all'; state.q = c.sha.slice(0, 7); $('#q').value = state.q; render(); } }); }
    }
  }
  return items;
});
$('#viewSeg').addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (b) { state.view = b.dataset.v; render(); } });
$('#viewSeg').addEventListener('keydown', (e) => {
  const current = e.target.closest('[role="tab"]');
  if (!current) return;
  const tabs = [...document.querySelectorAll('#viewSeg [role="tab"]')];
  const at = tabs.indexOf(current);
  const next = e.key === 'ArrowRight' ? (at + 1) % tabs.length
    : e.key === 'ArrowLeft' ? (at - 1 + tabs.length) % tabs.length
      : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
  if (next < 0) return;
  e.preventDefault();
  tabs[next].focus();
  tabs[next].click();
});
$('#rangeSeg').addEventListener('click', (e) => { const b = e.target.closest('[data-r]'); if (b) { state.range = b.dataset.r; render(); } });
$('#legend').addEventListener('click', (e) => {
  const b = e.target.closest('[data-type]');
  if (!b) return;
  const t = b.dataset.type;
  if (e.altKey || e.metaKey) { state.off = new Set(TYPES.filter((x) => x !== t)); }
  else state.off.has(t) ? state.off.delete(t) : state.off.add(t);
  if (state.off.size === TYPES.length) state.off.clear();
  render();
});
let qT;
$('#q').addEventListener('input', (e) => { clearTimeout(qT); qT = setTimeout(() => { state.q = e.target.value.trim(); render(); }, 120); });
$('#list').addEventListener('click', (e) => {
  const t = e.target.closest('[data-toggle]');
  if (t) { const id = t.dataset.toggle; state.open.has(id) ? state.open.delete(id) : state.open.add(id); render(); return; }
  const n = e.target.closest('[data-notes]');
  if (n) { notes(n.dataset.notes); return; }
  const f = e.target.closest('[data-feat]');
  if (f) { const k = f.dataset.feat; state.expanded.has(k) ? state.expanded.delete(k) : state.expanded.add(k); render(); return; }
  const st = e.target.closest('[data-story]');
  if (st) { const f = featureIndex.get(st.dataset.story); if (f) openStory(f.name, f.commits, f.repo); return; }
  const repo = state.data.repos.find((r) => r.name === state.repo);
  if (e.target.closest('[data-release]') && repo) return openRelease(repo, () => load(false));
  if (e.target.closest('[data-changelog]') && repo) return openChangelog(repo, () => load(false));
});
$('#copyRange').innerHTML = `${icon('Layers01', 14)}Copy notes`;
$('#copyRange').addEventListener('click', () => notes('range'));
addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select')) { if (e.key === 'Escape') e.target.blur(); return; }
  if (e.key === '/') { e.preventDefault(); $('#q').focus(); }
  if (e.key === 'r' && !e.metaKey && !e.ctrlKey) { load(); if (state.view === 'commit') refreshCommit(); }
});
// Redraw the chart whenever its box changes size: the window, or the cart opening beside it.
let rT, chartW = 0;
new ResizeObserver(([e]) => {
  const w = Math.round(e.contentRect.width);
  if (!w || w === chartW) return;
  chartW = w; clearTimeout(rT);
  rT = setTimeout(() => state.data && !$('#chart').closest('[hidden]') && renderChart(visible()), 60);
}).observe($('#chart'));
addEventListener('focus', () => { if (state.data) { load(false); if (state.view === 'commit') refreshCommit(); } });

readHash();
refreshRepoState();
$('#list').innerHTML = '<div class="loading mono">Reading repos…</div>';
load(false);

// ---------- live reload ----------
// When staged's own files change (or it restarts after an update), refresh without losing your place.
// If you're typing or have a dialog open, wait until you're done.
(() => {
  if (!('EventSource' in window)) return;
  let boot = null, pending = false;
  const busy = () => document.querySelector('.modal-wrap, .pal-wrap') || (document.activeElement?.matches('input, textarea') && document.activeElement.value);
  // Never loop: after 3 automatic reloads in 20 seconds, stop and wait for a manual refresh.
  const looping = () => {
    try {
      const now = Date.now(), recent = JSON.parse(sessionStorage.getItem('staged-reloads') || '[]').filter((t) => now - t < 20000);
      if (recent.length >= 3) { console.warn('staged: skipped an automatic reload (too many in a row)'); return true; }
      sessionStorage.setItem('staged-reloads', JSON.stringify([...recent, now]));
    } catch {}
    return false;
  };
  const reload = () => {
    if (looping()) return;
    if (busy()) { if (!pending) { pending = true; const t = setInterval(() => { if (!busy()) { clearInterval(t); location.reload(); } }, 1500); } return; }
    location.reload();
  };
  const es = new EventSource('/api/live');
  es.addEventListener('hello', (e) => { const id = JSON.parse(e.data); if (boot && boot !== id) reload(); boot = id; });
  es.addEventListener('change', (e) => {
    const { file } = JSON.parse(e.data);
    if (/\.css$/.test(file)) {
      for (const l of document.querySelectorAll('link[rel="stylesheet"]')) l.href = l.href.replace(/(\?.*)?$/, `?v=${Date.now()}`);
      return;
    }
    reload();
  });
})();
