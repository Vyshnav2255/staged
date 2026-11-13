// Git tree: every branch, merge and tag, drawn as lanes that grow in when you open it.
import { icon } from './icons.js';
import { esc, ago, dLong, api, copy, compact, reducedMotion, modal } from './ui.js';

const ROW = 36;      // row height
const LANE = 16;     // lane spacing
const PAD = 14;      // left padding inside the graph
const LANE_COLORS = ['var(--lane-0)', 'var(--t-feature)', 'var(--t-ui)', 'var(--t-fix)', 'var(--t-refactor)', 'var(--t-perf)'];

const st = { repo: null, data: null, all: true, limit: 300, open: null, hover: null, error: '' };
let host = null, ctx = null;

export function mountTree(el, context) {
  host = el; ctx = context;
  if (!host.dataset.treeBound) {
    host.addEventListener('click', onClick);
    host.addEventListener('mouseover', onOver);
    host.addEventListener('mouseleave', () => setHover(null));
    host.dataset.treeBound = '1';
  }
  if (st.repo !== ctx.repo) { st.repo = ctx.repo; st.data = null; st.open = null; st.limit = 300; load(); }
  else draw(false);
}

async function load(animate = true) {
  host.innerHTML = '<div class="loading mono">Growing the tree…</div>';
  try {
    st.data = await api(`/api/x/graph?repo=${encodeURIComponent(st.repo)}&limit=${st.limit}&all=${st.all ? 1 : 0}`);
    st.error = '';
  } catch (e) { st.error = e.message; }
  draw(animate);
}

function layout(commits) {
  const index = new Map(commits.map((c, i) => [c.sha, i]));
  const lanes = [];
  const rows = [];
  let maxW = 1;
  for (const c of commits) {
    let L = lanes.indexOf(c.sha);
    if (L < 0) { L = lanes.indexOf(null); if (L < 0) { L = lanes.length; lanes.push(null); } }
    for (let k = 0; k < lanes.length; k++) if (lanes[k] === c.sha) lanes[k] = null;
    const parentLanes = [];
    c.parents.forEach((p, pi) => {
      let pl = lanes.indexOf(p);
      if (pl < 0) {
        if (pi === 0 && lanes[L] === null) pl = L;
        else { pl = lanes.indexOf(null); if (pl < 0) { pl = lanes.length; lanes.push(null); } }
        lanes[pl] = p;
      }
      parentLanes.push(pl);
    });
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    maxW = Math.max(maxW, lanes.length, L + 1);
    rows.push({ L, parentLanes });
  }
  const edges = [];
  commits.forEach((c, i) => {
    c.parents.forEach((p, pi) => {
      const j = index.has(p) ? index.get(p) : null;
      edges.push({ from: i, fromLane: rows[i].L, lane: rows[i].parentLanes[pi], to: j, merge: pi > 0 });
    });
  });
  return { rows, edges, width: maxW, index };
}

const x = (lane) => PAD + lane * LANE;
const dayFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
function dayLabel(iso) {
  const d = new Date(iso); const t = new Date(); t.setHours(0, 0, 0, 0);
  const diff = Math.round((t - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 864e5);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return dayFmt.format(d) + (d.getFullYear() !== t.getFullYear() ? ` '${String(d.getFullYear()).slice(2)}` : '');
}
const y = (row) => row * ROW + ROW / 2;

function edgePath(e, total) {
  const x1 = x(e.fromLane), y1 = y(e.from), x2 = x(e.lane);
  const endRow = e.to === null ? total : e.to;
  const yEnd = e.to === null ? total * ROW : y(e.to);
  const xEnd = e.to === null ? x2 : x2;
  if (x1 === x2) return `M${x1},${y1} L${xEnd},${yEnd}`;
  // bend into the lane within the next row, then run straight
  const yb = Math.min(y1 + ROW, yEnd);
  const mid = (y1 + yb) / 2;
  let d = `M${x1},${y1} C${x1},${mid} ${x2},${mid} ${x2},${yb}`;
  if (yb < yEnd) d += ` L${xEnd},${yEnd}`;
  void endRow;
  return d;
}

function refPills(refs, isHead) {
  const out = [];
  for (const r of refs) {
    if (r.startsWith('HEAD -> ')) out.push(`<span class="ref is-head">${icon('GitBranch', 12)}${esc(r.slice(8))}</span>`);
    else if (r === 'HEAD') out.push(`<span class="ref is-head">HEAD</span>`);
    else if (r.startsWith('tag: ')) out.push(`<span class="ref is-tag">${icon('Tag01', 12)}${esc(r.slice(5))}</span>`);
    else if (r.includes('/')) out.push(`<span class="ref is-remote">${esc(r)}</span>`);
    else out.push(`<span class="ref">${icon('GitBranch', 12)}${esc(r)}</span>`);
  }
  void isHead;
  return out.join('');
}

function draw(animate) {
  if (!host || ctx.view !== 'tree') return;
  if (st.error) { host.innerHTML = `<div class="empty"><h3>Couldn't read the tree</h3><p>${esc(st.error)}</p></div>`; return; }
  if (!st.data) return;
  const { commits, head } = st.data;
  const q = (ctx.q || '').toLowerCase();
  const { rows, edges, width } = layout(commits);
  const total = commits.length;
  const gw = PAD * 2 + (width - 1) * LANE;
  const H = total * ROW;
  const motion = animate && !reducedMotion();

  let paths = '';
  edges.forEach((e, k) => {
    const color = LANE_COLORS[e.lane % LANE_COLORS.length];
    const delay = motion ? Math.min(e.from * 14, 900) : 0;
    const fade = e.to === null ? ' stroke-dasharray="3 4"' : '';
    paths += `<path class="edge ${motion ? 'grow' : ''}" data-e="${k}" data-from="${e.from}" data-to="${e.to ?? ''}" d="${edgePath(e, total)}" stroke="${color}"${fade} style="--d:${delay}ms"/>`;
  });
  let nodes = '';
  commits.forEach((c, i) => {
    const L = rows[i].L;
    const t = ctx.typeOf ? ctx.typeOf(c.sha) : null;
    const color = t ? `var(--t-${t})` : LANE_COLORS[L % LANE_COLORS.length];
    const isHead = c.sha === head;
    const merge = c.parents.length > 1;
    const tag = c.refs.some((r) => r.startsWith('tag: '));
    const delay = motion ? Math.min(i * 14, 900) + 120 : 0;
    const shape = tag
      ? `<rect x="${x(L) - 5}" y="${y(i) - 5}" width="10" height="10" rx="2.5" transform="rotate(45 ${x(L)} ${y(i)})" fill="${color}"/>`
      : merge
        ? `<circle cx="${x(L)}" cy="${y(i)}" r="3.5" fill="${color}"/>`
        : `<circle cx="${x(L)}" cy="${y(i)}" r="4.75" fill="var(--surface)" stroke="${color}" stroke-width="2"/>`;
    nodes += `<g class="node ${motion ? 'pop' : ''}" data-row="${i}" style="--d:${delay}ms; transform-origin:${x(L)}px ${y(i)}px">
      ${isHead ? `<circle class="halo" cx="${x(L)}" cy="${y(i)}" r="9" fill="none" stroke="var(--ink)" stroke-width="1.5"/><circle cx="${x(L)}" cy="${y(i)}" r="5.5" fill="var(--ink)"/>` : shape}
    </g>`;
  });

  const dayKey = (c) => new Date(c.date).toDateString();
  let seps = '';
  commits.forEach((c, i) => { if (i && dayKey(c) !== dayKey(commits[i - 1])) seps += `<line x1="0" x2="${gw}" y1="${i * ROW}" y2="${i * ROW}"/>`; });
  const list = commits.map((c, i) => {
    const newDay = i === 0 || dayKey(c) !== dayKey(commits[i - 1]);
    const hit = q && (c.subject.toLowerCase().includes(q) || c.sha.startsWith(q) || c.author.toLowerCase().includes(q));
    return `<div class="t-row ${newDay && i ? 'day-start' : ''} ${hit ? 'is-hit' : ''} ${st.open === c.sha ? 'is-open' : ''} ${c.sha === head ? 'is-headrow' : ''}" data-row="${i}" data-sha="${c.sha}" style="--d:${motion ? Math.min(i * 14, 900) + 60 : 0}ms">
      <span class="t-subj">${refPills(c.refs, c.sha === head)}<span class="t-text">${esc(c.subject)}</span></span>
      <span class="t-author">${esc(c.author)}</span>
      <span class="t-when mono ${newDay ? 'is-day' : ''}" title="${dLong.format(new Date(c.date))}">${newDay ? dayLabel(c.date) : ''}</span>
      <span class="t-sha mono">${c.sha.slice(0, 7)}</span>
    </div>`;
  }).join('');

  const merges = commits.filter((c) => c.parents.length > 1).length;
  const tagN = commits.filter((c) => c.refs.some((r) => r.startsWith('tag: '))).length;
  const branchN = new Set(commits.flatMap((c) => c.refs.filter((r) => !r.startsWith('tag: ')).map((r) => r.replace(/^HEAD -> /, '')))).size;

  host.innerHTML = `
    <div class="t-bar">
      <div class="seg" role="radiogroup" aria-label="Branches">
        <button data-scope="all" aria-selected="${st.all}">All branches</button>
        <button data-scope="head" aria-selected="${!st.all}">This branch</button>
      </div>
      <span class="mono muted">${total} commits · ${branchN} branches · ${merges} merges${tagN ? ` · ${tagN} tags` : ''}</span>
      <span class="t-legend mono muted"><i class="lg-head"></i>you are here <i class="lg-commit"></i>commit, coloured by type <i class="lg-merge"></i>merge <i class="lg-tag"></i>tag</span>
    </div>
    <div class="t-wrap" style="--gw:${gw}px">
      <svg class="t-graph" width="${gw}" height="${H}" viewBox="0 0 ${gw} ${H}" aria-hidden="true">
        <g class="seps">${seps}</g><g class="edges">${paths}</g><g class="nodes">${nodes}</g>
      </svg>
      <div class="t-rows">${list}</div>
    </div>
    ${commits.length >= st.limit ? `<div class="more"><button class="text-btn bordered" data-more>Show ${Math.min(500, 2000 - st.limit)} older commits</button></div>` : ''}`;

  // set real lengths so the lines draw in
  if (motion) for (const p of host.querySelectorAll('path.edge')) { const len = p.getTotalLength(); p.style.setProperty('--len', len); }
}

function detailHtml(c, d) {
  const body = d ? d.message.split('\n').slice(1).join('\n').trim() : '';
  const files = d ? d.files : [];
  const add = files.reduce((s, f) => s + f.add, 0), del = files.reduce((s, f) => s + f.del, 0);
  return `<div class="t-detail">
    <div class="t-detail-title">${esc(c.subject)}</div>
    <div class="mono muted">${esc(c.author)} · ${dLong.format(new Date(c.date))}</div>
    <div class="t-detail-refs">${refPills(c.refs)}</div>
    ${body ? `<pre class="t-body">${esc(body)}</pre>` : ''}
    <div class="t-detail-tools">
      <button class="text-btn bordered" data-copysha="${c.sha}">${icon('Copy01', 14)}${c.sha.slice(0, 7)}</button>
      ${ctx.remote ? `<a class="text-btn bordered" href="${esc(ctx.commitUrl(c.sha))}" target="_blank" rel="noopener">${icon(ctx.host.icon, 14)}Open on ${esc(ctx.host.name)}</a>` : ''}
      ${c.parents.length > 1 ? `<span class="mono muted">merge of ${c.parents.length} lines</span>` : ''}
    </div>
    <div class="t-files-head mono muted">${d ? `${files.length} file${files.length === 1 ? '' : 's'} · <span class="a">+${compact(add)}</span> <span class="d">−${compact(del)}</span>` : 'Reading commit…'}</div>
    <div class="t-files">${files.slice(0, 120).map((f) => `<div class="t-file"><span class="cm-path"><span class="dir">${esc(f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : '')}</span>${esc(f.path.split('/').pop())}</span><span class="lines mono"><span class="a">+${compact(f.add)}</span> <span class="d">−${compact(f.del)}</span></span></div>`).join('')}${files.length > 120 ? `<div class="muted mono">+${files.length - 120} more files</div>` : ''}</div>
  </div>`;
}

// ---------- hover: light up a commit's whole line of history ----------
function lineage(i) {
  const { commits } = st.data;
  const index = new Map(commits.map((c, k) => [c.sha, k]));
  const keep = new Set([i]);
  const up = [i];
  while (up.length) { const k = up.pop(); for (const p of commits[k].parents) { const j = index.get(p); if (j != null && !keep.has(j)) { keep.add(j); up.push(j); } } }
  // descendants
  const children = new Map();
  commits.forEach((c, k) => c.parents.forEach((p) => { const j = index.get(p); if (j != null) { if (!children.has(j)) children.set(j, []); children.get(j).push(k); } }));
  const down = [i];
  while (down.length) { const k = down.pop(); for (const ch of children.get(k) || []) if (!keep.has(ch)) { keep.add(ch); down.push(ch); } }
  return keep;
}
function setHover(i) {
  if (!host || st.hover === i) return;
  st.hover = i;
  const wrap = host.querySelector('.t-wrap');
  if (!wrap) return;
  if (i == null) { wrap.classList.remove('is-tracing'); return; }
  const keep = lineage(i);
  wrap.classList.add('is-tracing');
  for (const n of wrap.querySelectorAll('.node')) n.classList.toggle('on', keep.has(+n.dataset.row));
  for (const r of wrap.querySelectorAll('.t-row')) r.classList.toggle('on', keep.has(+r.dataset.row));
  for (const p of wrap.querySelectorAll('path.edge')) p.classList.toggle('on', keep.has(+p.dataset.from) && (p.dataset.to === '' || keep.has(+p.dataset.to)));
}
let hoverT;
function onOver(e) {
  const r = e.target.closest('.t-row');
  clearTimeout(hoverT);
  hoverT = setTimeout(() => setHover(r ? +r.dataset.row : null), r ? 60 : 120);
}

async function onClick(e) {
  let b;
  if ((b = e.target.closest('[data-scope]'))) { st.all = b.dataset.scope === 'all'; st.open = null; return load(); }
  if ((b = e.target.closest('[data-more]'))) { st.limit = Math.min(2000, st.limit + 500); return load(false); }
  if ((b = e.target.closest('[data-copysha]'))) return copy(b.dataset.copysha, 'Commit id copied');
  if ((b = e.target.closest('.t-row'))) {
    const sha = b.dataset.sha;
    const c = st.data.commits.find((x) => x.sha === sha);
    for (const r of host.querySelectorAll('.t-row')) r.classList.toggle('is-open', r.dataset.sha === sha);
    st.open = sha;
    const m = modal({ title: 'Commit', body: detailHtml(c, null), side: true, onClose: () => { st.open = null; host.querySelector('.t-row.is-open')?.classList.remove('is-open'); } });
    m.el.addEventListener('click', (ev) => { const cb = ev.target.closest('[data-copysha]'); if (cb) copy(cb.dataset.copysha, 'Commit id copied'); });
    let d;
    try { d = await api(`/api/x/commit?repo=${encodeURIComponent(st.repo)}&sha=${sha}`); } catch (err) { d = { sha, message: c.subject + '\n\n' + err.message, files: [] }; }
    const body = m.el.querySelector('.modal-body');
    if (body) body.innerHTML = detailHtml(c, d);
  }
}
