// Repo weight on a repo's Overview, and Media: a docked side panel with the heavy images and videos and a
// Shrink button. Branches and stashes live on Tree.
import { icon } from './icons.js';
import { bar } from './bar.js';
import { esc, ago, bytes, api, copy, toast, dShort, dLong, modal } from './ui.js';
import { sfxClunk, sfxSettle } from './sfx.js';

const CATS = ['images', 'css', 'js', 'fonts', 'media'];
const CAT_LABEL = { images: 'Images', css: 'CSS', js: 'JavaScript', fonts: 'Fonts', media: 'Audio & video' };
const CAT_COLOR = { images: 'var(--t-feature)', css: 'var(--t-ui)', js: 'var(--t-fix)', fonts: 'var(--t-perf)', media: 'var(--t-refactor)' };

const st = { repo: null, weight: null, images: null, state: null, error: '', weeks: 12 };
// Shrink: tools available, files being worked on, and the last result per path.
const sh = { tools: null, busy: new Set(), setup: false, done: new Map(), last: null, run: null };
// Numbers that count to their new value when a file finishes: key -> { from, to, at }.
const ticks = new Map();
// kHost: the Repo weight card beside Codebase on Overview. mHost: the Media panel's body while it's open.
let kHost = null, mHost = null, media = null, ctx = null;

function bind(el) {
  if (el.dataset.healthBound) return;
  el.addEventListener('click', onClick);
  el.addEventListener('error', (e) => { if (e.target.matches?.('.md-thumb img')) e.target.remove(); }, true);
  el.dataset.healthBound = '1';
}
function use(repo) {
  if (st.repo === repo) return false;
  st.repo = repo; st.weight = st.images = st.state = null; sh.last = null; sh.done = new Map(); sh.fresh = null; ticks.clear();
  load();
  return true;
}

// Overview: the Repo weight card, with a line about heavy media that opens the Media panel.
// The page's range (4w, 12w, 1y, All) sets how many weeks it weighs; the server stops at two years.
const WEEKS = { '4w': 4, '12w': 12, '1y': 52, all: 104 };
// Weigh the repo without showing a card (the stats timeline on Overview draws the weight itself).
export function primeWeight(context) {
  ctx = context;
  const weeks = WEEKS[ctx.range] || 12;
  if (weeks !== st.weeks) { st.weeks = weeks; if (st.repo === ctx.repo) { st.weight = null; reweigh(); } }
  use(ctx.repo);
}
// The card beside Codebase: what the repo is made of, its heaviest images and videos, and the way into Media.
export function mountKinds(el, context) {
  kHost = el; bind(el);
  ctx = { ...context, onWeight: ctx?.onWeight || context.onWeight };
  const weeks = WEEKS[ctx.range] || 12;
  if (weeks !== st.weeks) { st.weeks = weeks; if (st.repo === ctx.repo) { st.weight = null; reweigh(); } }
  if (!use(ctx.repo)) draw();
}
function reweigh() {
  const repo = st.repo, weeks = st.weeks;
  api(`/api/x/weight?repo=${encodeURIComponent(repo)}&weeks=${weeks}`).then((r) => { if (st.repo === repo && st.weeks === weeks) { st.weight = r.weeks; draw(); ctx?.onWeight?.(); } }).catch(() => {});
}

// Media: docked on the right like Run, and it follows the repo you pick.
export function openMedia(repo, context) {
  if (!repo || repo === 'all') return toast('Open a repo first');
  if (context) ctx = context;
  if (media) { const m = media; media = null; mHost = null; m.close(true); }
  use(repo);
  const m = modal({ title: 'Media', body: '<div data-md></div>', side: true, repo, follow: (r) => openMedia(r), onClose: () => { if (media === m) { media = null; mHost = null; } } });
  m.el.classList.add('is-ps', 'is-media');
  media = m; mHost = m.el.querySelector('[data-md]'); bind(mHost);
  draw();
  return m;
}
export const mediaOpen = () => !!media;

async function load() {
  draw();
  const r = encodeURIComponent(st.repo);
  if (!sh.tools) api('/api/shrink/status').then((t) => { sh.tools = t; draw(); }).catch(() => {});
  api(`/api/shrink/last?repo=${r}`).then((x) => { sh.last = x.run; draw(); }).catch(() => {});
  const weeks = st.weeks;
  const [w, im] = await Promise.allSettled([
    api(`/api/x/weight?repo=${r}&weeks=${weeks}`), api(`/api/x/images?repo=${r}`),
  ]);
  if (st.repo !== ctx.repo) return;
  if (st.weeks === weeks) { st.weight = w.status === 'fulfilled' ? w.value.weeks : []; ctx?.onWeight?.(); } // else the newer range is already on its way
  st.images = im.status === 'fulfilled' ? im.value.images : [];
  st.error = [w, im].find((x) => x.status === 'rejected')?.reason?.message || '';
  draw();
}

const total = (w) => CATS.reduce((s, c) => s + (w[c] || 0), 0);

// For the stats list on Overview: today's weight and the change over the range (null until weighed).
export function weightSummary(repo) {
  const weeks = st.repo === repo ? st.weight : null;
  if (!weeks?.length) return null;
  return { total: total(weeks[weeks.length - 1]), delta: total(weeks[weeks.length - 1]) - total(weeks[0]), weeks: weeks.length };
}

// For the stats timeline on Overview: the total of each weighed week with its date. The series only has the weeks
// that had commits, so the caller places each point by its date (null until weighed).
export function weightSeries(repo) {
  const weeks = st.repo === repo ? st.weight : null;
  if (!weeks?.length) return null;
  return { v: weeks.map(total), t: weeks.map((w) => w.week) };
}

// Today's weight, the change over the range and the biggest jump. These sit on the Codebase card (#wstats).
export function weightStats(repo) {
  const weeks = st.repo === repo ? st.weight : null;
  if (!weeks?.length) return '';
  const now = weeks[weeks.length - 1], first = weeks[0];
  const delta = total(now) - total(first);
  let jump = null;
  for (let i = 1; i < weeks.length; i++) { const d = total(weeks[i]) - total(weeks[i - 1]); if (!jump || d > jump.d) jump = { d, w: weeks[i] }; }
  return `<div class="h-stats">
      <div><div class="stat-label">Today</div><div class="stat-value">${bytes(total(now))}</div></div>
      <div><div class="stat-label">Change over ${weeks.length} week${weeks.length === 1 ? '' : 's'}</div><div class="stat-value ${delta > 0 ? 'up-bad' : 'down-good'}">${delta >= 0 ? '+' : '−'}${bytes(Math.abs(delta))}</div></div>
      ${jump && jump.d > 0 ? `<div class="h-jump"><div class="stat-label">Biggest jump</div><div>+${bytes(jump.d)} in the week of ${dShort.format(new Date(jump.w.week))}</div><div class="muted t-ellipsis" title="${esc(jump.w.subject)}">${esc(jump.w.subject)}</div></div>` : ''}
    </div>`;
}

// What the repo is made of right now: one bar by kind with a legend, then the heaviest images and videos.
function kindsCard() {
  const weeks = st.weight;
  const head = (right = '') => `<div class="h-head"><h2>Repo weight</h2>${right}</div>`;
  if (!weeks) return `<section class="h-card rw-card">${head()}<div class="loading mono">Weighing…</div>${mediaLine()}</section>`;
  if (!weeks.length) return `<section class="h-card rw-card">${head()}<p class="muted">No commits in this range.</p>${mediaLine()}</section>`;
  const now = weeks[weeks.length - 1], T = total(now);
  const kinds = CATS.filter((c) => now[c]).sort((a, b) => now[b] - now[a]);
  const pct = (v) => { const p = (v / T) * 100; return p >= 1 ? `${Math.round(p)}%` : '<1%'; };
  return `<section class="h-card rw-card">${head(`<span class="mono rw-total">${bytes(T)}</span>`)}
    ${bar(kinds.map((c) => ({ value: now[c], color: CAT_COLOR[c], title: `${CAT_LABEL[c]} ${bytes(now[c])}` })), { cls: 'rw-kbar' })}
    <div class="rw-keys">${kinds.map((c) => `<span><i style="background:${CAT_COLOR[c]}"></i>${CAT_LABEL[c]}</span><span class="mono">${bytes(now[c])}</span><span class="mono muted">${pct(now[c])}</span>`).join('')}</div>
    <div class="rw-foot">${mediaLine()}</div>
  </section>`;
}

// The line under Repo weight: how much the heavy images and videos weigh, and the way into the Media panel.
function mediaLine() {
  if (!st.images) return '';
  const rows = listRows(), done = rows.filter((r) => r.result && r.result.after != null);
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  let text, btn;
  if (sh.busy.size) { text = `<i class="md-dot"></i>Shrinking ${sh.run ? `${sh.run.done + 1} of ${sh.run.total}` : ''}`; btn = 'Show'; }
  else if (done.length) {
    const saved = done.reduce((a, r) => a + r.result.before - r.result.after, 0);
    text = `${plural(done.length, 'file')} shrunk, <b class="mono">−${bytes(saved)}</b> · not committed yet`; btn = 'Open';
  } else if (rows.length) {
    const sum = rows.reduce((a, r) => a + r.bytes, 0);
    text = `${rows.length === 1 ? '1 image or video is' : `${rows.length} images and videos are`} heavier than ${rows.length === 1 ? 'it needs' : 'they need'} to be, <b class="mono">${bytes(sum)}</b>`; btn = 'Shrink…';
  } else return `<div class="w-media is-ok">${icon('Tick02', 14)}<span>${st.images.length ? 'Recent images and videos are light enough.' : 'No new images or videos in the last 6 months.'}</span></div>`;
  return `<div class="w-media">${icon('Image01', 15)}<span>${text}</span><button class="text-btn sh-btn" data-open-media>${btn}</button></div>`;
}

const isVideo = (i) => i.kind === 'video';
const isRaster = (i) => !isVideo(i) && !/\.svg$/i.test(i.path);
// Can this row be shrunk? '' when yes. Missing image tools aren't a blocker: Shrink fetches them.
function blocker(i) {
  if (!isVideo(i) && !isRaster(i)) return 'svg';
  if (isVideo(i) && sh.tools && !sh.tools.ffmpeg) return 'ffmpeg';
  return '';
}

// The list: files still flagged, plus the ones the last Shrink changed (they stay, showing the result).
function listRows() {
  const out = [];
  const files = sh.last?.files || [];
  const taken = new Set(files.flatMap((f) => [f.path, f.newPath].filter(Boolean)));
  for (const f of files) out.push({ path: f.newPath || f.path, was: f.path, kind: isVideo({ path: f.path, kind: /\.(mp4|m4v|mov|webm)$/i.test(f.path) ? 'video' : '' }) ? 'video' : '', bytes: f.before, issues: [], result: f });
  for (const i of st.images || []) if (i.issues.length && !taken.has(i.path)) {
    const res = sh.done.get(i.path) || null;
    out.push(res?.newPath && res.after != null ? { ...i, path: res.newPath, was: i.path, result: res } : { ...i, result: res });
  }
  return out.sort((a, b) => b.bytes - a.bytes);
}

// Media: the heavy images and videos, weighed like a parcel. One number and a bar with a segment per file say
// how heavy they are, count down while Shrink works, and keep the freed space as a hatched ghost afterwards.
const MB = 1048576;
const keyOf = (r) => r.was || r.path;
const plural = (n, w, many) => `${n} ${n === 1 ? w : many || w + 's'}`;
const big = (b) => { const [n, u] = bytes(b).split(' '); return `${n}<small>${u}</small>`; };
const durs = new Map(); // video path -> seconds, null when unknown, 'wait' while asking
function durOf(path) {
  if (!durs.has(path)) {
    durs.set(path, 'wait');
    api(`/api/shrink/poster?repo=${encodeURIComponent(st.repo)}&path=${encodeURIComponent(path)}&info=1`)
      .then((x) => { durs.set(path, x.duration); if (x.duration) draw(); }).catch(() => durs.set(path, null));
  }
  const d = durs.get(path);
  return typeof d === 'number' ? `${Math.floor(d / 60)}:${String(Math.round(d % 60)).padStart(2, '0')}` : '';
}
function thumbOf(r) {
  const q = `repo=${encodeURIComponent(st.repo)}&path=${encodeURIComponent(r.path)}`;
  if (!isVideo(r)) return `<span class="md-thumb"><img loading="lazy" src="/api/x/file?${q}" alt=""></span>`;
  const d = durOf(r.path);
  return `<span class="md-thumb is-video">${icon('Play', 16)}<img loading="lazy" src="/api/shrink/poster?${q}" alt="">${d ? `<i class="md-dur mono">${d}</i>` : ''}</span>`;
}
// What a file will likely weigh once shrunk, from what Shrink does to each kind (shrink.mjs): photos and
// screenshots become WebP, social images stay PNG or JPEG, videos become H.264. Only a guide for the bar;
// the real size replaces it as each file finishes.
const KEEP_FORMAT = /favicon|apple-touch|(^|[\/_.-])og([-_.]|image)|social|share-card|twitter-card/i;
function guess(r) {
  const p = r.path.toLowerCase();
  const k = isVideo(r) ? 0.25 : /\.png$/.test(p) ? (KEEP_FORMAT.test(p) ? 0.5 : 0.08) : /\.jpe?g$/.test(p) ? (KEEP_FORMAT.test(p) ? 0.7 : 0.3) : /\.gif$/.test(p) ? 0.3 : 0.6;
  return r.bytes * k;
}
// The bar is one piece: what stays (solid), what Shrink already took off (light hatch, "saved") and what it
// can still take off (dark hatch, "about"). Finished files count down from the guess to their real size.
function parts(rows) {
  let keep = 0, freed = 0, can = 0;
  for (const r of rows) {
    if (r.result && r.result.after != null) { const v = shown(keyOf(r)); keep += v; freed += r.result.before - v; }
    else if (!blocker(r) && !r.result?.skipped) { const g = guess(r); keep += g; can += r.bytes - g; }
    else keep += r.bytes;
  }
  return { keep, freed, can };
}
let barRows = [];

function barHtml({ keep, freed, can }, total) {
  const min = total * 0.04;
  return `<i class="md-keep" style="flex-grow:${keep / MB}"></i>`
    + `<i class="md-freed" style="flex-grow:${freed / MB}"${freed < total * 0.005 ? ' hidden' : ''}><b class="mono"${freed < min ? ' hidden' : ''}>−${bytes(freed)} saved</b></i>`
    + `<i class="md-can" style="flex-grow:${can / MB}"${can < total * 0.005 ? ' hidden' : ''}><b class="mono"${can < min ? ' hidden' : ''}>about −${bytes(can)}</b></i>`;
}

// The scale at the top of Media: the images and videos sit on the plate as one parcel, and the display is an
// LED dot matrix with the repo's weight right now (what is committed, less what Shrink took off and isn't
// committed yet). As files shrink the parcel gets smaller inside a lime outline of what it weighed, the
// display counts down, and when a run ends the plate springs up once.
const GLYPH = {
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  '.': ['0', '0', '0', '0', '0', '0', '1'],
  ' ': ['00', '00', '00', '00', '00', '00', '00'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
};
const savedTxt = (b) => (b < 1024 ? '0 MB' : bytes(b));
const LED_COLS = 62, LED_ROWS = 9, LED_P = 4.6;
const ledText = (b) => b >= 1073741824 ? `${(b / 1073741824).toFixed(2)} GB` : b >= 1048576 ? `${(b / 1048576).toFixed(b >= 104857600 ? 0 : 1)} MB` : `${Math.max(0, Math.round(b / 1024))} KB`;
function led(b) {
  const on = new Set();
  const chars = [...ledText(b)];
  const width = chars.reduce((w, c) => w + GLYPH[c][0].length + 1, -1);
  let x = LED_COLS - 1 - width;
  for (const c of chars) {
    const g = GLYPH[c];
    g.forEach((row, y) => { for (let i = 0; i < row.length; i++) if (row[i] === '1') on.add(`${x + i},${y + 1}`); });
    x += g[0].length + 1;
  }
  let dim = '', lit = '', core = '';
  for (let y = 0; y < LED_ROWS; y++) for (let i = 0; i < LED_COLS; i++) {
    const cx = (i * LED_P + LED_P / 2).toFixed(1), cy = (y * LED_P + LED_P / 2).toFixed(1);
    if (on.has(`${i},${y}`)) { lit += `<circle cx="${cx}" cy="${cy}" r="1.7"/>`; core += `<circle cx="${cx}" cy="${cy}" r=".7"/>`; }
    else dim += `<circle cx="${cx}" cy="${cy}" r="1.5"/>`;
  }
  return `<svg class="sc-dots" viewBox="0 0 ${LED_COLS * LED_P} ${LED_ROWS * LED_P}" width="${LED_COLS * LED_P}" height="${LED_ROWS * LED_P}" aria-hidden="true"><g class="sc-off">${dim}</g><g class="sc-on">${lit}</g><g class="sc-core">${core}</g></svg>`;
}
// What the repo weighs right now: the last committed week, less what Shrink saved and isn't committed yet.
function repoNow(saved) {
  const w = st.weight?.length ? total(st.weight[st.weight.length - 1]) : null;
  return w == null ? null : Math.max(0, w - saved);
}
function scale({ total: was, now, state, side }) {
  const k = was ? Math.sqrt(Math.max(now, 1) / was) : 1;
  const age = performance.now() - (sh.springAt || -1e9);
  const spring = state === 'done' && age < 1900;
  const repo = now;
  return `<div class="sv-scale is-${state}${spring ? ' is-fresh' : ''}" style="--k:${k.toFixed(3)};--age:-${Math.round(spring ? age : 0)}ms" data-scale="${was}">
    <div class="sc-top"><div class="sc-load">${state === 'idle' ? '' : '<i class="sc-ghost"></i>'}<i class="sc-box"></i></div><i class="sc-plate"></i><i class="sc-neck"></i></div>
    <div class="sc-body">
      <span class="sc-lcd" role="img" aria-label="Images and videos weigh ${repo == null ? 'not weighed yet' : bytes(repo)}"><i class="sc-lamp"></i><span class="sc-led">${repo == null ? led(0).replace('class="sc-dots"', 'class="sc-dots is-off"') : led(repo)}</span></span>
    </div>
    <div class="sc-feet"><i></i><i></i></div>
  </div>`;
}

// Three figures under the scale, with a quiet line below: a tiny receipt instead of a sentence.
function stats() { return ''; } // the figure strip and foot line were removed (user, 2026-11-26)

function mediaBody() {
  const imgs = st.images;
  if (!imgs) return `<div class="loading mono">Weighing images and videos…</div>`;
  const rows = listRows();
  if (!rows.length) return `<p class="muted h-ok">${icon('Tick02', 14)}${imgs.length ? `All ${imgs.length} recent image${imgs.length === 1 ? ' and video is' : 's and videos are'} light enough.` : 'No new images or videos in the last 6 months.'}</p>`;
  const busy = sh.busy.size > 0;
  const ready = rows.filter((r) => !r.result && !blocker(r) && !sh.busy.has(r.path));
  const isDone = (r) => r.result && r.result.after != null;
  const done = rows.filter(isDone);
  for (const r of done) tick(keyOf(r), r.result.after, guess({ ...r, path: r.was || r.path, bytes: r.result.before }));
  const total = rows.reduce((a, r) => a + (isDone(r) ? r.result.before : r.bytes), 0);
  const now = rows.reduce((a, r) => a + (isDone(r) ? r.result.after : r.bytes), 0);
  tick('__now', now, total);
  const links = done.reduce((a, r) => a + (r.result.links || 0), 0);

  let right, read;
  const was = shown('__now');
  if (busy) {
    right = `<span class="md-prog"><i class="md-dot"></i>${sh.setup ? 'Getting the image tools ready, one time' : `Shrinking ${sh.run.done + 1} of ${sh.run.total}`}</span>`;
    read = scale({ total, now: was, state: 'busy' })
      + stats([['Was', bytes(total)], ['Done', `${sh.run.done} of ${sh.run.total}`], ['Saved so far', `<span data-tick-saved>−${savedTxt(total - was)}</span>`, 'is-saved']],
        `<span class="md-prog"><i class="md-dot"></i>${sh.setup ? 'Getting the image tools ready, one time' : `Shrinking ${sh.run.done + 1} of ${sh.run.total}`}</span>`);
  } else if (done.length) {
    right = `<button class="btn-primary md-all" data-sh-commit>Review in Commit</button><button class="md-link" data-sh-undo>Undo</button>${ready.length ? `<button class="text-btn sh-btn" data-sh-all>Shrink ${ready.length} more</button>` : ''}`;
    read = scale({ total, now: was, state: 'done' })
      + stats([['Was', bytes(total)], [done.length === 1 ? 'File' : 'Files', String(done.length)], [`${Math.round((total - now) / total * 100)}% lighter`, `<span data-tick-saved>−${bytes(total - was)}</span>`, 'is-saved']],
        links ? `${plural(links, 'link')} updated to the new files` : 'Same names, lighter files', '<span class="md-pend">Not committed</span>');
  } else {
    right = ready.length ? `<button class="btn-primary md-all" data-sh-all>${ready.length === 1 ? 'Shrink it' : `Shrink all ${ready.length}`}</button>` : '';
    const can = parts(rows).can;
    read = scale({ total, now: total, state: 'idle' })
      + stats([[rows.length === 1 ? 'File' : 'Files', String(rows.length)], ['Heaviest', bytes(Math.max(...rows.map((r) => r.bytes)))], ['Can save about', can > total * 0.02 ? `−${bytes(can)}` : '—', 'is-can']],
        `Heavier than ${rows.length === 1 ? 'it needs' : 'they need'} to be`);
  }
  barRows = rows;
  const allDone = done.length === rows.length;
  const bar = `<div class="md-bar${allDone ? ' is-done' : ''}${busy ? ' is-busy' : ''}" data-total="${total}">${barHtml(parts(rows), total)}</div>`;

  const rowHtml = (r) => {
    const res = r.result, d = isDone(r), key = keyOf(r), why = blocker(r);
    const working = sh.busy.has(r.path) && sh.run?.current === r.path, queued = sh.busy.has(r.path) && !working;
    const age = d ? since(key) : 1e9;
    const name = r.path.split('/').pop();
    const pct = d && res.before ? Math.round((1 - res.after / res.before) * 100) : 0;
    const side = d
      ? `<span class="md-side"><span class="md-now"><s>${bytes(res.before)}</s><b data-tick="${esc(key)}">${bytes(shown(key))}</b>${pct > 0 ? `<span class="md-pct">−${pct}%</span>` : ''}</span></span>`
      : `<span class="md-side"><span class="md-now"><b>${bytes(r.bytes)}</b></span></span>`;
    const act = d ? ''
      : working ? `<span class="sh-busy md-st">${isVideo(r) ? 'Encoding' : 'Shrinking'}<i class="md-dot"></i></span>`
      : queued ? `<span class="md-st muted">Next</span>`
      : why === 'ffmpeg' ? `<button class="text-btn sh-btn" data-copycmd="${esc(sh.tools.ffmpegHint)}" title="Videos need ffmpeg. Copy the install command">${icon('Copy01', 13)}ffmpeg</button>`
      : why || res?.skipped ? '' : `<button class="text-btn sh-btn" data-sh="${esc(r.path)}" ${busy ? 'disabled' : ''}>Shrink</button>`;
    return `<div class="md-row${d ? ' is-done' : ''}${working ? ' is-working' : ''}${age < 900 ? ' is-new' : ''}" style="${age < 900 ? `--age:-${Math.round(age)}ms` : ''}" title="${esc((r.was && d ? `${r.path}\nwas ${r.was}` : r.path) + (res?.skipped ? `\n${res.skipped}` : !d && r.issues.length ? `\n${r.issues.join(' · ')}` : ''))}">
      ${thumbOf(r)}
      <span class="md-main"><span class="md-name">${esc(name)}</span></span>
      ${side}${act ? `<span class="md-act">${act}</span>` : ''}
    </div>`;
  };
  const shown60 = rows.slice(0, 60), todo = shown60.filter((r) => !isDone(r)), fin = shown60.filter(isDone);
  const both = todo.length && fin.length;
  // group headers only when both groups show
  const sec = (label, list, extra = '') => list.length ? `${both ? `<div class="md-sec"><span>${label}</span><span class="md-n">${list.length}</span>${extra}</div>` : ''}${list.map(rowHtml).join('')}` : '';
  const list = sec('To shrink', todo, todo.length ? `<span class="md-sec-r">${bytes(todo.reduce((a, r) => a + r.bytes, 0))}</span>` : '')
    + sec('Shrunk', fin);
  return `<div class="md-head"><div class="md-read">${read}</div>${right ? `<div class="md-cta">${right}</div>` : ''}</div>
    <div class="md-list">${list}</div>`;
}

async function shrink(paths) {
  paths = paths.filter((p) => !sh.busy.has(p));
  if (!paths.length || sh.busy.size) return;
  const repo = st.repo;
  for (const p of paths) sh.busy.add(p);
  sh.fresh = new Set(paths);
  sh.run = { total: paths.length, done: 0, current: null };
  if (!sh.tools) sh.tools = await api('/api/shrink/status').catch(() => null);
  if (sh.tools && !sh.tools.sharp && paths.some((p) => !/\.(mp4|m4v|mov|webm)$/i.test(p))) {
    sh.setup = true; draw();
    const r = await api('/api/shrink/setup', {}).catch((e) => ({ sharp: false, error: e.message }));
    sh.setup = false;
    sh.tools = await api('/api/shrink/status').catch(() => sh.tools);
    if (!r.sharp) { sh.busy.clear(); toast(`Couldn't get the image tools: ${r.error}`); draw(); return; }
  }
  const id = sh.last?.id || Date.now().toString(36);
  for (const p of paths) {
    sh.run.current = p; draw();
    try {
      const r = await api('/api/shrink/run', { repo, paths: [p], run: id });
      sh.done.set(p, { ...r.results[0], links: r.results[0]?.newPath ? r.refs || 0 : 0 });
    } catch (e) { sh.done.set(p, { path: p, skipped: e.message }); }
    sh.run.done++;
  }
  sh.busy.clear(); sh.run = null;
  const [last, im] = await Promise.all([
    api(`/api/shrink/last?repo=${encodeURIComponent(repo)}`).catch(() => null),
    api(`/api/x/images?repo=${encodeURIComponent(repo)}`).catch(() => null),
  ]);
  if (st.repo === repo) {
    sh.last = last?.run || null;
    if (im) st.images = im.images;
    for (const [k, v] of sh.done) if (v.after != null) sh.done.delete(k); // now part of the last run
    // the plate springs up once the run is over: a clunk as it lets go, a beep as the display settles
    if (sh.last) { sh.springAt = performance.now(); sfxClunk(true); sfxSettle(); setTimeout(() => draw(), 1950); }
  }
  ctx.onChange?.();
  draw();
}

async function undo() {
  if (!sh.last) return;
  const repo = st.repo;
  try { const r = await api('/api/shrink/undo', { repo, run: sh.last.id }); toast(`Put back ${r.undone} file${r.undone === 1 ? '' : 's'}.`); }
  catch (e) { toast(e.message); }
  sh.last = null; sh.done = new Map(); sh.fresh = null; ticks.clear();
  ctx.onChange?.();
  load();
}

// Shown on Tree, and only when there is something to look at: another branch, a stash, or bot branches.
export function branchCard(s, hostName) {
  if (!s) return '';
  const local = s.branches.filter((b) => !b.remote).sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  const bots = s.branches.filter((b) => b.remote && b.bot).length;
  const stale = (b) => !b.current && Date.now() - Date.parse(b.date) > 30 * 864e5;
  if (local.length <= 1 && !s.stashes.length && !bots) return '';
  return `<section class="h-card t-branches">
    <div class="h-head"><h2>Branches and stashes</h2><span class="mono muted">${local.length} local${bots ? ` · ${bots} bot branches on ${esc(hostName || 'your remote')} hidden` : ''}</span></div>
    <div class="br-list">${local.map((b) => `<div class="br-row">
        <span class="br-name">${icon('GitBranch', 14)}${esc(b.name)}${b.current ? '<span class="chip">current</span>' : ''}${b.merged && !b.current ? '<span class="chip">merged</span>' : ''}${stale(b) ? '<span class="chip is-bad">stale</span>' : ''}</span>
        <span class="muted t-ellipsis" title="${esc(b.subject)}">${esc(b.subject)}</span>
        <span class="mono muted" title="${dLong.format(new Date(b.date))}">${ago(Date.parse(b.date))}</span>
        <span>${!b.current && (b.merged || stale(b)) ? `<button class="text-btn" data-copycmd="git branch ${b.merged ? '-d' : '-D'} ${esc(b.name)}" title="Copy the command to delete it">${icon('Copy01', 13)}Delete command</button>` : ''}</span>
      </div>`).join('')}</div>
    ${s.stashes.length ? `<h3 class="h-sub">Stashes</h3><div class="br-list">${s.stashes.map((x) => `<div class="br-row">
        <span class="br-name">${icon('Archive02', 14)}${esc(x.ref)}</span>
        <span class="muted t-ellipsis">${esc(x.msg)}</span>
        <span class="mono muted">${ago(Date.parse(x.date))}</span>
        <span><button class="text-btn" data-copycmd="git stash show -p ${esc(x.ref)}">${icon('Copy01', 13)}Show command</button></span>
      </div>`).join('')}</div>` : ''}
  </section>`;
}

// Count a number to its new value: a finished file's size runs down from before to after, the saved total runs up.
const TICK_MS = 700;
const ease = (u) => 1 - Math.pow(1 - u, 3);
function tick(key, to, from) {
  const t = ticks.get(key);
  if (t && t.to === to) return;
  const start = t ? shown(key) : from ?? 0;
  // a file seen already finished (after a reload) doesn't count again
  if (!t && !sh.busy.size && !(key.startsWith('__') ? sh.fresh?.size : sh.fresh?.has(key))) { ticks.set(key, { from: to, to, at: -1e9 }); return; }
  ticks.set(key, { from: start, to, at: performance.now() });
}
const since = (key) => performance.now() - (ticks.get(key)?.at ?? -1e9);
function shown(key) {
  const t = ticks.get(key);
  if (!t) return 0;
  const u = Math.min(1, since(key) / TICK_MS);
  return t.from + (t.to - t.from) * ease(u);
}
let tickRaf = 0;
function runTicks() {
  cancelAnimationFrame(tickRaf);
  const step = () => {
    let live = false;
    for (const el of mHost?.querySelectorAll('[data-tick]') || []) {
      const k = el.dataset.tick;
      if (since(k) < TICK_MS) live = true;
      if (el.dataset.fmt === 'big') el.innerHTML = big(shown(k)); else el.textContent = bytes(shown(k));
    }
    // the scale follows the count: the parcel shrinks, the display and the saved figure run down with it
    for (const sc of mHost?.querySelectorAll('.sv-scale:not(.is-idle)[data-scale]') || []) {
      const was = +sc.dataset.scale, now = shown('__now');
      sc.style.setProperty('--k', Math.sqrt(Math.max(now, 1) / was).toFixed(3));
      const r = now, l = sc.querySelector('.sc-led');
      if (r != null && l) l.innerHTML = led(r);
      for (const sv of mHost.querySelectorAll('[data-tick-saved]')) sv.textContent = `−${savedTxt(was - now)}`;
      for (const nv of mHost.querySelectorAll('[data-tick-now]')) nv.textContent = bytes(now);
    }
    if (live) tickRaf = requestAnimationFrame(step);
  };
  step();
}

function draw() {
  if (kHost?.isConnected && !kHost.hidden) kHost.innerHTML = kindsCard();
  if (mHost?.isConnected) { mHost.innerHTML = `<div class="md-dock">${mediaBody()}</div>`; runTicks(); }
}

function onClick(e) {
  let b;
  if (e.target.closest('[data-open-media]')) return openMedia(st.repo);
  if ((b = e.target.closest('[data-copycmd]'))) copy(b.dataset.copycmd, 'Command copied');
  if ((b = e.target.closest('[data-sh]')) && !b.disabled) return shrink([b.dataset.sh]);
  if ((b = e.target.closest('[data-sh-all]')) && !b.disabled) return shrink(listRows().filter((r) => !r.result && !blocker(r)).map((r) => r.path));
  if (e.target.closest('[data-sh-undo]')) return undo();
  if (e.target.closest('[data-sh-commit]')) return ctx.go(st.repo, 'commit');
}
