import { icon } from './icons.js';
import { mountCommit, refreshCommit } from './commit-view.js';
import { mountTree } from './tree.js';
import { mountHealth } from './health.js';
import { mountHome } from './today.js';
import { mountReadme } from './readme.js';
import { mountSettings } from './settings.js';
import { initUpdates, checkNow } from './update.js';
import { pushLaunch, pushButtonDone, previewCommit, previewPush } from './fx.js';
import { soundOn, setSound } from './sfx.js';
import { initSegs, countUp, enter } from './motion.js';
import { initGlance } from './glance.js';
import { initPalette, open as openPalette } from './palette.js';
import { recapCard, recapFor, openStory, releasePanel, openRelease, openChangelog } from './release.js';
import { api, copy, hostOf, commitUrl } from './ui.js';

// ---------- constants ----------
const TYPES = ['feature', 'ui', 'fix', 'perf', 'refactor', 'other'];
const TYPE_LABEL = { feature: 'Feature', ui: 'Design', fix: 'Fix', perf: 'Perf', refactor: 'Chore', other: 'Other' };
const NOTES_LABEL = { feature: 'New', ui: 'Design', fix: 'Fixes', perf: 'Performance', refactor: 'Maintenance', other: 'Other' };
const RANGES = { '4w': 4, '12w': 12, '1y': 52, all: Infinity };
const DAY = 86400000;
const WEEK = 7 * DAY;

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = new Intl.NumberFormat('en');
const compact = (n) => (n >= 10000 ? (n / 1000).toFixed(0) + 'k' : n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n));
const dShort = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const dLong = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const dMonth = new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric' });
const dTime = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

function ago(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 86400 * 30) return Math.floor(s / 86400) + 'd ago';
  if (s < 86400 * 365) return Math.floor(s / 86400 / 30) + 'mo ago';
  return (s / 86400 / 365).toFixed(1).replace(/\.0$/, '') + 'y ago';
}
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
const VIEWS = ['week', 'feature', 'release', 'tree', 'health', 'commit', 'readme', 'settings'];
const PANE_VIEWS = ['tree', 'health', 'commit', 'readme', 'settings'];
const GLOBAL_VIEWS = ['readme', 'settings'];
const isHome = () => state.repo === 'all' && state.view === 'week';
const state = { repoState: null, data: null, repo: 'all', view: 'week', range: '12w', q: '', off: new Set(), open: new Set(), expanded: new Set() };

function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('repo')) state.repo = h.get('repo');
  if (VIEWS.includes(h.get('view'))) state.view = h.get('view');
  if (h.get('view') === 'today') { state.repo = 'all'; state.view = 'week'; } // Today is part of Home now
  if (RANGES[h.get('range')]) state.range = h.get('range');
}
function writeHash() {
  const h = new URLSearchParams({ repo: state.repo, view: state.view, range: state.range });
  history.replaceState(null, '', '#' + h);
}

// ---------- data ----------
async function load(spin) {
  const btn = $('#refresh');
  if (spin) btn.classList.add('spin');
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
  } finally {
    btn.classList.remove('spin');
  }
}

function currentRepos() {
  return state.repo === 'all' ? state.data.repos : state.data.repos.filter((r) => r.name === state.repo);
}
function allCommits() {
  const list = currentRepos().flatMap((r) => r.commits);
  return state.repo === 'all' ? list.sort((a, b) => b.t - a.t) : list;
}
function rangeStart() {
  const n = RANGES[state.range];
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
  const total = repos.reduce((n, r) => n + r.commits.length, 0);
  const waiting = repos.filter((r) => r.dirty).length;
  const nameOf = (r) => `<span class="repo-name">${r.remote ? `<span class="repo-host" title="On ${esc(hostOf(r).name)}">${icon(hostOf(r).icon, 14)}</span>` : `<span class="repo-host is-local" title="Local only">${icon('Folder01', 14)}</span>`}<span class="repo-label">${esc(r.name)}</span>${r.dirty ? `<span class="repo-dirty" title="${r.dirty} uncommitted"></span>` : ''}</span>`;
  let html = `<div class="side-top">
    <button class="repo is-home" data-home aria-current="${state.repo === 'all' && !GLOBAL_VIEWS.includes(state.view)}">
      <span class="repo-name"><span class="repo-host">${icon('Home01', 14)}</span><span class="repo-label">Home</span></span>
      <span class="repo-meta mono">${waiting ? `${waiting} repo${waiting > 1 ? 's' : ''} with work waiting` : `all clear · ${fmt.format(total)} commits`}</span>
    </button>
  </div>
  <div class="side-sec"><span class="side-sec-h mono">Repos <b>${repos.length}</b></span>${repos.length > 6 ? `<label class="side-filter">${icon('Search01', 13)}<input id="repoFilter" type="search" placeholder="Filter" value="${esc(state.sideQ || '')}" autocomplete="off" spellcheck="false" aria-label="Filter repos"></label>` : ''}</div>
  <div class="repo-list">`;
  for (const r of repos) {
    const meta = [r.last ? ago(r.last) : 'no commits', r.dirty ? `${r.dirty} uncommitted` : ''].filter(Boolean).join(' · ');
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
    const active = repos.filter((r) => r.last > Date.now() - 30 * DAY).length;
    $('#meta').innerHTML = `<span>${icon('Calendar03', 13)}${new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date())}</span><span>${repos.length} repos</span><span>${active} active this month</span>`;
    gh.hidden = true;
  } else {
    const r = repos[0];
    $('#title').textContent = r.name;
    $('#meta').innerHTML = [
      `<span>${icon('GitBranch', 13)}${esc(r.branch)}</span>`,
      `<span>${icon('GitCommit', 13)}${fmt.format(r.commits.length)} commits</span>`,
      `<span>${icon('Tag01', 13)}${r.tags.length ? r.tags.length + ' tags' : 'no tags'}</span>`,
      r.dirty ? `<span>${r.dirty} uncommitted files</span>` : '',
      r.last ? `<span>${icon('Clock01', 13)}last commit ${ago(r.last)}</span>` : '',
    ].join('');
    gh.hidden = !r.remote;
    gh.href = r.remote || '#';
    { const h = hostOf(r); gh.innerHTML = icon(h.icon, 16); gh.title = `Open ${r.name} on ${h.name}`; gh.setAttribute('aria-label', gh.title); }
    const rs = state.repoState && state.repoState.repo === r.name ? state.repoState : null;
    if (rs && (rs.ahead || rs.behind)) $('#meta').innerHTML += `<span class="${rs.ahead ? 'is-ahead' : ''}">${rs.ahead ? `${icon('ArrowUp01', 13)}${rs.ahead} to push` : ''}${rs.ahead && rs.behind ? ' · ' : ''}${rs.behind ? `${icon('ArrowDown01', 13)}${rs.behind} behind` : ''}</span>`;
  }
  const push = $('#pushBtn');
  const rs2 = state.repo !== 'all' && state.repoState && state.repoState.repo === state.repo ? state.repoState : null;
  push.hidden = !(rs2 && rs2.ahead && !GLOBAL_VIEWS.includes(state.view));
  push.innerHTML = `${icon('ArrowUp02', 15)}<span>Push ${rs2?.ahead || ''}</span>`;
  $('#readmeLink').setAttribute('aria-current', state.view === 'readme');
  $('#settingsLink').setAttribute('aria-current', state.view === 'settings');
  if (state.view === 'readme') { $('#title').textContent = 'README'; $('#meta').innerHTML = '<span>How staged works</span>'; gh.hidden = true; push.hidden = true; }
  if (state.view === 'settings') { $('#title').textContent = 'Settings'; $('#meta').innerHTML = '<span>AI, messages, sound and updates</span>'; gh.hidden = true; push.hidden = true; }
  const viewTabs = [...document.querySelectorAll('#viewSeg button')];
  const hasViewTab = viewTabs.some((b) => b.dataset.v === state.view);
  for (const b of viewTabs) {
    const selected = b.dataset.v === state.view;
    b.setAttribute('aria-selected', selected);
    b.tabIndex = selected || (!hasViewTab && b.dataset.v === 'week') ? 0 : -1;
  }
  const dirty = repos.reduce((s, r) => s + (r.dirty || 0), 0);
  $('#dirtyCount').textContent = dirty ? dirty : '';
  for (const b of document.querySelectorAll('#rangeSeg button')) b.setAttribute('aria-selected', b.dataset.r === state.range);
}

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

// ---------- render: stats ----------
function renderStats(list) {
  const n = RANGES[state.range];
  let prev = null;
  if (n !== Infinity) {
    const end = rangeStart();
    const start = end - n * WEEK;
    prev = allCommits().filter((c) => c.t >= start && c.t < end && matches(c));
  }
  const sum = (l) => {
    const days = new Set(l.map((c) => new Date(c.t).toDateString()));
    const add = l.reduce((s, c) => s + c.add, 0), del = l.reduce((s, c) => s + c.del, 0);
    const feat = l.filter((c) => c.type === 'feature').length;
    const fix = l.filter((c) => c.type === 'fix').length;
    return { commits: l.length, days: days.size, add, del, feat, fixShare: l.length ? Math.round((fix / l.length) * 100) : 0 };
  };
  const a = sum(list), b = prev && sum(prev);
  const delta = (k, invert) => {
    if (!b) return '<div class="stat-delta">all time</div>';
    const d = a[k] - b[k];
    if (!b[k] && !a[k]) return '<div class="stat-delta">—</div>';
    const cls = d === 0 ? '' : (d > 0) !== !!invert ? 'up' : 'down';
    const txt = k === 'fixShare' ? `${d > 0 ? '+' : ''}${d} pts` : `${d > 0 ? '+' : ''}${fmt.format(d)}`;
    return `<div class="stat-delta mono ${cls}">${d === 0 ? 'same as' : txt + ' vs'} previous ${state.range}</div>`;
  };
  const num = (k, n) => `<span class="num" data-k="${k}" data-n="${n}">${fmt.format(n)}</span>`;
  $('#stats').innerHTML = [
    ['Commits', num('commits', a.commits), delta('commits')],
    ['Active days', num('days', a.days), delta('days')],
    ['Lines changed', `${compact(a.add + a.del)} <small><span style="color:var(--add)">+${compact(a.add)}</span> <span style="color:var(--del)">−${compact(a.del)}</span></small>`, b ? `<div class="stat-delta mono">${compact(b.add + b.del)} previous ${state.range}</div>` : delta()],
    ['Features shipped', num('feat', a.feat), delta('feat')],
    ['Fix share', `${num('fix', a.fixShare)}<small>%</small>`, delta('fixShare', true)],
  ].map(([l, v, d]) => `<div class="stat"><div class="stat-label">${l}</div><div class="stat-value">${v}</div>${d}</div>`).join('');
  for (const el of $('#stats').querySelectorAll('.num')) countUp(el, +el.dataset.n, el.dataset.k, (n) => fmt.format(Math.round(n)));
}

// ---------- render: chart ----------
function renderLegend() {
  $('#legend').innerHTML = TYPES.map((t) =>
    `<button data-type="${t}" aria-pressed="${!state.off.has(t)}" title="Show or hide ${TYPE_LABEL[t]}"><span class="dot" style="background:var(--t-${t})"></span>${TYPE_LABEL[t]}</button>`).join('');
}

function renderChart(list) {
  const el = $('#chart');
  const n = RANGES[state.range];
  const allL = allCommits();
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
  void allL;
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
        ? `<path d="${roundTop(x, y0, barW, h, r)}" fill="var(--t-${t})"/>`
        : `<rect x="${x}" y="${y0 + 2}" width="${barW}" height="${Math.max(1, h)}" fill="var(--t-${t})"/>`;
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
  const key = [state.repo, state.range, state.view, [...state.off].join()].join('|');
  const grow = key !== renderChart.key;
  renderChart.key = key;
  el.innerHTML = `<svg class="${grow ? 'is-grow' : ''}" viewBox="0 0 ${W} ${H}" role="group" aria-label="${esc($('#chartTitle').textContent)}">
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
    const gap = i < present.length - 1 ? 1.5 : 0;
    out += `<rect x="${x}" y="0" width="${Math.max(1, cw - gap)}" height="6" rx="1.5" fill="var(--t-${t})"/>`;
    x += cw;
  });
  const title = present.map((t) => `${TYPE_LABEL[t]} ${counts[t]}`).join(' · ');
  return `<svg class="mix" width="${w}" height="6" viewBox="0 0 ${w} 6" preserveAspectRatio="none"><title>${title}</title>${out}</svg>`;
}
// What the glance rail reads: a label, a count and the mix of change types.
const glance = (label, commits) => `data-gl="${esc(label)}" data-gl-n="${commits.length}" data-gl-mix="${Object.entries(countTypes(commits)).map(([t, n]) => t + ':' + n).join(',')}"`;
function countTypes(list) {
  const c = {};
  for (const x of list) c[x.type] = (c[x.type] || 0) + 1;
  return c;
}

function row(c) {
  const showRepo = state.repo === 'all';
  const areas = c.areas.slice(0, 3).map((a) => `<span class="area">${esc(a)}</span>`).join('') + (c.areas.length > 3 ? `<span class="area">+${c.areas.length - 3}</span>` : '');
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
  return `<section class="group" id="${id}" ${glance(title, commits)}>
    <div class="group-head">
      <span class="group-title">${esc(title)}</span>
      <span class="group-sub mono">${sub ? esc(sub) + ' · ' : ''}${commits.length} commit${commits.length === 1 ? '' : 's'} · +${compact(add)} −${compact(del)}</span>
      ${mixBar(countTypes(commits)).replace('class="mix"', 'class="group-mix"')}
      <span class="group-tools"><button class="text-btn" data-notes="${id}" title="Copy as release notes (Markdown)">${icon('Layers01', 14)}Copy notes</button></span>
    </div>
    ${shown.map(row).join('')}
    ${commits.length > PAGE ? `<div class="more"><button class="text-btn" data-toggle="${id}">${open ? 'Show less' : `Show ${commits.length - PAGE} more`}</button></div>` : ''}
  </section>`;
}

let notesSource = new Map();
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
  let html = `<div class="cols"><span>Feature or area</span><span class="hide-sm">Change mix</span><span>Commits</span><span class="hide-sm">Lines</span><span class="hide-sm">Last change</span><span></span></div>`;
  for (const f of feats.slice(0, limit)) {
    const add = f.commits.reduce((s, c) => s + c.add, 0), del = f.commits.reduce((s, c) => s + c.del, 0);
    const exp = state.expanded.has(f.key);
    html += `<button class="feat" data-feat="${esc(f.key)}" aria-expanded="${exp}" ${glance(f.name, f.commits)}>
      <span class="feat-name">${esc(f.name)}${state.repo === 'all' ? `<span class="mono">${esc(f.repo)}</span>` : ''}</span>
      <span class="hide-sm">${mixBar(countTypes(f.commits), 96)}</span>
      <span class="mono">${f.commits.length}</span>
      <span class="mono hide-sm lines"><span class="a">+${compact(add)}</span> <span class="d">−${compact(del)}</span></span>
      <span class="mono hide-sm when" style="text-align:left">${ago(f.commits[0].t)}</span>
      <span class="chev">${icon('ArrowRight01', 14)}</span>
    </button>`;
    if (exp) {
      const id = 'f' + hash(f.key);
      notesSource.set(id, { title: f.name, commits: f.commits });
      const open = state.open.has(id);
      const shown = open ? f.commits : f.commits.slice(0, PAGE);
      html += `<div class="feat-body">${shown.map(row).join('')}
        <div class="more">${f.commits.length > PAGE ? `<button class="text-btn" data-toggle="${id}">${open ? 'Show less' : `Show ${f.commits.length - PAGE} more`}</button>` : ''}
        <button class="text-btn" data-story="${esc(f.key)}">${icon('Note01', 14)}Read its story</button>
        <button class="text-btn" data-notes="${id}">${icon('Layers01', 14)}Copy notes</button></div></div>`;
    }
  }
  if (feats.length > 30) html += `<div class="more"><button class="text-btn" data-toggle="features">${state.open.has('features') ? 'Show fewer' : `Show all ${feats.length} areas`}</button></div>`;
  return `<p class="note">Areas come from the folders and files each commit touched. Add a <code class="mono">.changes.json</code> to a repo to name them yourself.</p>` + html;
}

function renderRelease(list) {
  const repos = currentRepos();
  const tagged = repos.filter((r) => r.tags.length);
  const panel = state.repo !== 'all' ? releasePanel(repos[0]) : '';
  if (!tagged.length) {
    if (panel) return panel + `<div class="empty"><h3>No releases yet</h3><p>Hit <b>New release</b> to tag your latest commit as v0.1.0. Notes are written from your commits, and every release after that lists what changed since the one before.</p>
      <button class="text-btn" data-goto="week">${icon('Calendar03', 14)}See weekly drops instead</button></div>`;
    return `<div class="empty">
      <h3>No releases yet</h3>
      <p>${state.repo === 'all' ? 'None of these repos has tags.' : `${esc(state.repo)} has no tags.`} Tag a commit when you ship and it shows up here as a release, with notes written from the commits since the last one.</p>
      <p style="margin-top:10px"><code>git tag v0.1 &amp;&amp; git push --tags</code></p>
      <button class="text-btn" data-goto="week">${icon('Calendar03', 14)}See weekly drops instead</button>
    </div>`;
  }
  const keep = new Set(list.map((c) => c.sha + c.repo));
  let html = panel;
  for (const r of tagged) {
    const sections = [];
    let cur = { name: 'Unreleased', date: null, commits: [] };
    for (const c of r.commits) {
      if (c.tags.length) {
        if (cur.commits.length || cur.name !== 'Unreleased') sections.push(cur);
        cur = { name: c.tags[0], date: c.t, commits: [] };
      }
      cur.commits.push(c);
    }
    sections.push(cur);
    for (const s of sections) {
      const commits = s.commits.filter((c) => keep.has(c.sha + c.repo));
      if (!commits.length) continue;
      const id = 'r' + hash(r.name + s.name);
      const title = (state.repo === 'all' ? r.name + ' ' : '') + s.name;
      notesSource.set(id, { title, commits });
      html += group(id, title, s.date ? dLong.format(s.date) : 'since last tag', commits);
    }
  }
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
    onChange: () => { load(false); refreshRepoState(); },
    recap: () => recapFor(state.data.repos.flatMap((x) => x.commits)),
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
    if (state.repo === 'all') return pickRepoPane(el, v);
    if (v === 'commit') return mountCommit(el, ctxFor(v));
    if (v === 'tree') return mountTree(el, ctxFor(v));
    if (v === 'health') return mountHealth(el, ctxFor(v));
  }
  renderLegend();
  const list = visible();
  renderStats(list);
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
  if (!meta) meta = await Promise.all([api('/api/changes/engines').catch(() => ({})), api('/api/update').catch(() => ({}))]).then(([e, u]) => ({ claude: !!e.claude, version: u.current || '' }));
  const section = settingsSection; settingsSection = '';
  await mountSettings(el, { ...meta, section, onChange: () => refreshCommit(), onRepos: () => load(false) });
}

function pickRepoPane(el, v) {
  const what = { commit: 'commit changes in', tree: 'see the tree of', health: 'check the health of' }[v];
  const repos = v === 'commit' ? state.data.repos.filter((r) => r.dirty).sort((a, b) => b.dirty - a.dirty) : state.data.repos;
  el.innerHTML = repos.length ? `<p class="note">Pick a repo to ${what}.</p><div class="cm-repos">${repos.map((r) => `<button class="cm-repo" data-pickrepo="${esc(r.name)}">
      <span class="feat-name">${esc(r.name)}</span><span class="mono muted">${v === 'commit' ? `${r.dirty} uncommitted file${r.dirty > 1 ? 's' : ''}` : `${fmt.format(r.commits.length)} commits · ${r.last ? ago(r.last) : ''}`}</span>${icon('ArrowRight01', 14)}
    </button>`).join('')}</div>` : `<div class="empty"><h3>Everything is committed</h3><p>None of your repos has uncommitted changes.</p></div>`;
  el.onclick = (e) => { const b = e.target.closest('[data-pickrepo]'); if (b) { el.onclick = null; state.repo = b.dataset.pickrepo; render(); refreshRepoState(); } };
}

// ---------- notes ----------
function notes(id) {
  const src = notesSource.get(id);
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
let toastT;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  t.classList.remove('is-out');
  clearTimeout(toastT);
  toastT = setTimeout(() => { t.classList.add('is-out'); toastT = setTimeout(() => (t.hidden = true), 200); }, 1800);
}

// ---------- events ----------
$('#searchIcon').innerHTML = icon('Search01', 15);
$('#refresh').innerHTML = icon('Refresh01', 16);
$('#cmdk').innerHTML = `${icon('Command', 14)}<span class="mono">K</span>`;
$('#readmeLink').innerHTML = `${icon('BookOpen01', 15)}<span>README</span>`;
$('#settingsLink').innerHTML = `${icon('Settings02', 15)}<span>Settings</span>`;
$('#settingsLink').addEventListener('click', () => openSettings());
initUpdates(document.querySelector('.side'));
initSegs();
initGlance($('.main'));
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
$('#pushBtn').addEventListener('click', async () => {
  const b = $('#pushBtn'); const was = b.innerHTML;
  b.disabled = true; b.classList.add('is-pushing'); b.innerHTML = `${icon('ArrowUp02', 15)}<span>Pushing…</span>`;
  try {
    await Promise.all([api(`/api/x/push?repo=${encodeURIComponent(state.repo)}`, {}), pushLaunch(b, state.repoState?.ahead || 1)]);
    b.innerHTML = `${icon('Tick02', 15)}<span>Pushed</span>`;
    pushButtonDone(b, was);
    toast(`Pushed to ${hostOf(state.data.repos.find((x) => x.name === state.repo)).name}`);
    await new Promise((r) => setTimeout(r, 1400));
  } catch (err) { b.classList.remove('is-pushing'); b.innerHTML = was; toast(err.message); }
  b.disabled = false; refreshRepoState(); load(false);
});
$('#cmdk').addEventListener('click', () => openPalette());
initPalette((q) => {
  const items = [];
  const repos = state.data ? state.data.repos : [];
  const goRepo = (name, view) => () => { state.repo = name; if (view) state.view = view; else if (GLOBAL_VIEWS.includes(state.view)) state.view = 'week'; state.repoState = null; render(); refreshRepoState(); scrollTo({ top: 0 }); };
  items.push({ group: 'Go to', label: 'Home', hint: 'what is waiting, across every repo', run: goHome });
  items.push({ group: 'Actions', label: 'Preview commit animation', hint: 'nothing is committed', run: () => setTimeout(previewCommit, 200) });
  items.push({ group: 'Actions', label: 'Preview push animation', hint: 'nothing is pushed', run: () => setTimeout(previewPush, 200) });
  items.push({ group: 'Actions', label: soundOn() ? 'Turn sounds off' : 'Turn sounds on', hint: 'commit and push sounds', run: () => { setSound(!soundOn()); toast(soundOn() ? 'Sounds on' : 'Sounds off'); } });
  items.push({ group: 'Actions', label: 'Check for updates', hint: 'new versions of staged', run: checkNow });
  items.push({ group: 'Go to', label: 'Settings', hint: 'AI, models, message style, sound', run: () => openSettings() });
  items.push({ group: 'Go to', label: 'AI settings', hint: 'who writes and groups your commits', run: () => openSettings('ai') });
  items.push({ group: 'Go to', label: 'README', hint: 'how staged works', run: () => { state.view = 'readme'; render(); scrollTo({ top: 0 }); } });
  for (const r of repos) items.push({ group: 'Repos', label: r.name, hint: r.dirty ? `${r.dirty} uncommitted` : r.last ? ago(r.last) : '', run: goRepo(r.name) });
  const views = [['week', 'By week'], ['feature', 'By feature'], ['release', 'By release'], ['tree', 'Git tree'], ['health', 'Health and site weight'], ['commit', 'Commit changes']];
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
  const g = e.target.closest('[data-goto]');
  if (g) { state.view = g.dataset.goto; render(); return; }
  if (e.target.closest('[data-recapcopy]')) { const r = recapFor(visible()); if (r) copy(r.text, 'Recap copied'); return; }
  const st = e.target.closest('[data-story]');
  if (st) { const f = featureIndex.get(st.dataset.story); if (f) openStory(f.name, f.commits, f.repo); return; }
  const repo = state.data.repos.find((r) => r.name === state.repo);
  if (e.target.closest('[data-release]') && repo) return openRelease(repo, () => load(false));
  if (e.target.closest('[data-changelog]') && repo) return openChangelog(repo, () => load(false));
});
$('#refresh').addEventListener('click', () => { load(true); refreshRepoState(); if (state.view === 'commit') refreshCommit(); });
addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select')) { if (e.key === 'Escape') e.target.blur(); return; }
  if (e.key === '/') { e.preventDefault(); $('#q').focus(); }
  if (e.key === 'r' && !e.metaKey && !e.ctrlKey) { load(true); if (state.view === 'commit') refreshCommit(); }
});
let rT;
addEventListener('resize', () => { clearTimeout(rT); rT = setTimeout(() => state.data && renderChart(visible()), 100); });
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
