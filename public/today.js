// Home: how your week is going, your last six months at a glance, and anything waiting to be
// committed or pushed. Details live in each repo's own views.
import { icon } from './icons.js';
import { esc, ago, api, hostOf } from './ui.js';

const DAY = 864e5;
let host = null, ctx = null, data = null, loadedAt = 0, painted = '';

export function mountHome(el, context) {
  host = el; ctx = context;
  if (!host.dataset.homeBound) { host.addEventListener('click', onClick); host.dataset.homeBound = '1'; }
  draw();
  if (Date.now() - loadedAt > 3000) load();
}

async function load() {
  loadedAt = Date.now();
  try { data = await api('/api/x/today'); } catch (e) { data = { error: e.message, repos: [] }; }
  draw();
}

const dayAt = (base, add = 0) => { const d = new Date(base); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + add); return d.getTime(); };
const plural = (n, w, ws = w + 's') => `${n} ${n === 1 ? w : ws}`;
const fmt = new Intl.NumberFormat('en');

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
  return { byDay, today, streak, week, lastWeek, weeks, ws };
}

const bars = (vals) => {
  const max = Math.max(1, ...vals);
  return `<svg class="hv-bars" viewBox="0 0 ${vals.length * 8} 28" preserveAspectRatio="none" aria-hidden="true">${vals.map((v, i) => { const h = v ? Math.max(2, (v / max) * 26) : 1; return `<rect x="${i * 8}" y="${28 - h}" width="6" height="${h}" rx="1.5" class="${i === vals.length - 1 ? 'is-now' : ''}"/>`; }).join('')}</svg>`;
};

function tiles(a) {
  const diff = a.week.length - a.lastWeek.length;
  const add = a.week.reduce((s, c) => s + c.add, 0), del = a.week.reduce((s, c) => s + c.del, 0);
  const days = Array.from({ length: 14 }, (_, i) => a.byDay.get(dayAt(a.today, i - 13)) || 0);
  return `<div class="hv-tiles">
    <div class="hv-tile">
      <span class="hv-label">This week</span>
      <span class="hv-num">${a.week.length}<small>commits</small></span>
      <span class="hv-sub mono"><span class="${diff > 0 ? 'up' : diff < 0 ? 'down' : ''}">${a.lastWeek.length || a.week.length ? (diff === 0 ? 'same pace as last week' : `${diff > 0 ? '+' : '−'}${Math.abs(diff)} vs last week`) : 'a fresh start'}</span>${add + del ? ` · <span class="a">+${fmt.format(add)}</span> <span class="d">−${fmt.format(del)}</span> lines` : ''}</span>
      ${bars(a.weeks)}
    </div>
    <div class="hv-tile">
      <span class="hv-label">Streak</span>
      <span class="hv-num">${a.streak}<small>${a.streak === 1 ? 'day' : 'days'}</small></span>
      <span class="hv-days" aria-hidden="true">${days.map((n, i) => `<i class="${n ? 'is-on' : ''} ${i === 13 ? 'is-today' : ''}"></i>`).join('')}</span>
    </div>
  </div>`;
}

function heat(a) {
  const start = dayAt(a.ws, -25 * 7);
  let max = 1;
  for (const [k, n] of a.byDay) if (k >= start) max = Math.max(max, n);
  const f = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  let cells = '';
  for (let i = 0; i < 26 * 7; i++) {
    const t = dayAt(start, i);
    if (t > a.today) { cells += '<i class="hm-c is-future"></i>'; continue; }
    const n = a.byDay.get(t) || 0;
    const lv = !n ? 0 : n / max > 0.66 ? 4 : n / max > 0.33 ? 3 : n > 1 ? 2 : 1;
    cells += `<i class="hm-c l${lv}${t === a.today ? ' is-today' : ''}" title="${f.format(t)}: ${plural(n, 'commit')}"></i>`;
  }
  return `<div class="home-panel home-heat">
    <div class="home-panel-h"><b>Last 6 months</b></div>
    <div class="hm">${cells}</div>
    <div class="home-panel-f mono muted"><span></span><span class="hm-key">less <i class="hm-c l1"></i><i class="hm-c l2"></i><i class="hm-c l3"></i><i class="hm-c l4"></i> more</span></div>
  </div>`;
}

function waiting() {
  if (!data) return `<div class="home-head"><h3 class="h-sub">Waiting on you</h3></div><div class="hv-wait is-skel"></div>`;
  const list = (data.repos || []).filter((r) => r.dirty || r.ahead).sort((x, y) => (x.oldest || Infinity) - (y.oldest || Infinity));
  if (!list.length) return `<div class="home-clear">${icon('Tick02', 16)}<span>Everything is committed and pushed.</span></div>`;
  const row = (r) => {
    const old = r.oldest && Date.now() - r.oldest > 3 * DAY;
    const repo = (ctx.repos || []).find((x) => x.name === r.name);
    return `<div class="hv-wrow ${old ? 'is-old' : ''}">
      <button class="hv-wname" data-open="${esc(r.name)}">${esc(r.name)}</button>
      <span class="hv-wfacts">
        ${r.dirty ? `<span><i class="home-dot is-dirty"></i>${plural(r.dirty, 'file')} to commit</span>` : ''}
        ${r.ahead ? `<span><i class="home-dot is-ahead"></i>${plural(r.ahead, 'commit')} to push</span>` : ''}
        ${r.behind ? `<span><i class="home-dot is-behind"></i>${r.behind} behind ${esc(hostOf(repo).name)}</span>` : ''}
      </span>
      <span class="hv-wage mono">${r.oldest ? `${old ? 'waiting ' : ''}${ago(r.oldest).replace(' ago', '')}` : ''}</span>
      <span class="hv-wact">
        ${r.dirty ? `<button class="btn-primary sm" data-commit="${esc(r.name)}">Commit</button>` : ''}
        ${r.ahead ? `<button class="text-btn bordered sm" data-cart="${esc(r.name)}" title="Open the cart to push">${icon('ShoppingCart01', 14)}Cart</button>` : ''}
      </span>
    </div>`;
  };
  return `<div class="home-head"><h3 class="h-sub">Waiting on you</h3></div><div class="hv-wait">${list.map(row).join('')}</div>`;
}

function loose() {
  const l = (data?.repos || []).filter((r) => r.staleBranches || r.stashes);
  return l.length ? `<div class="home-loose"><span class="mono muted">Loose ends</span>${l.map((r) => `<button class="chip is-btn" data-tree="${esc(r.name)}" title="See branches and stashes in ${esc(r.name)}">${esc(r.name)} · ${[r.staleBranches ? `${r.staleBranches} stale branch${r.staleBranches > 1 ? 'es' : ''}` : '', r.stashes ? `${r.stashes} stash${r.stashes > 1 ? 'es' : ''}` : ''].filter(Boolean).join(', ')}</button>`).join('')}</div>` : '';
}

function draw() {
  if (!host || host.hidden) return;
  const a = activity();
  const html = `${tiles(a)}${waiting()}<div class="home-row is-one">${heat(a)}</div>${loose()}`;
  // Only touch the page when something changed, so nothing shifts or flickers on a refresh.
  if (html === painted && host.firstElementChild) return;
  painted = html;
  host.innerHTML = html;
}

function onClick(e) {
  let b;
  if ((b = e.target.closest('[data-commit]'))) return ctx.go(b.dataset.commit, 'commit');
  if ((b = e.target.closest('[data-open]'))) { const r = (data?.repos || []).find((x) => x.name === b.dataset.open); return ctx.go(b.dataset.open, r?.dirty ? 'commit' : 'week'); }
  if ((b = e.target.closest('[data-tree]'))) return ctx.go(b.dataset.tree, 'tree');
  // Pushing always goes through the cart (hold to push, then the receipt).
  if ((b = e.target.closest('[data-cart]'))) return ctx.openCart(b.dataset.cart);
}
