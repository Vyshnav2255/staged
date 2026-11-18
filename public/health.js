// Health: site weight per week, and images worth a look. Branches and stashes live on Tree.
import { icon } from './icons.js';
import { esc, ago, bytes, api, copy, dShort, dLong } from './ui.js';

const CATS = ['images', 'css', 'js', 'fonts', 'media'];
const CAT_LABEL = { images: 'Images', css: 'CSS', js: 'JavaScript', fonts: 'Fonts', media: 'Audio & video' };
const CAT_COLOR = { images: 'var(--t-feature)', css: 'var(--t-ui)', js: 'var(--t-fix)', fonts: 'var(--t-perf)', media: 'var(--t-refactor)' };

const st = { repo: null, weight: null, images: null, state: null, error: '', weeks: 26 };
let host = null, ctx = null;

export function mountHealth(el, context) {
  host = el; ctx = context;
  if (!host.dataset.healthBound) { host.addEventListener('click', onClick); host.dataset.healthBound = '1'; }
  if (st.repo !== ctx.repo) { st.repo = ctx.repo; st.weight = st.images = st.state = null; load(); }
  else draw();
}

async function load() {
  draw();
  const r = encodeURIComponent(st.repo);
  const [w, im] = await Promise.allSettled([
    api(`/api/x/weight?repo=${r}&weeks=${st.weeks}`), api(`/api/x/images?repo=${r}`),
  ]);
  if (st.repo !== ctx.repo) return;
  st.weight = w.status === 'fulfilled' ? w.value.weeks : [];
  st.images = im.status === 'fulfilled' ? im.value.images : [];
  st.error = [w, im].find((x) => x.status === 'rejected')?.reason?.message || '';
  draw();
}

const total = (w) => CATS.reduce((s, c) => s + (w[c] || 0), 0);

function weightSection() {
  const weeks = st.weight;
  if (!weeks) return `<section class="h-card"><h2>Site weight</h2><div class="loading mono">Weighing every week…</div></section>`;
  if (!weeks.length) return `<section class="h-card"><h2>Site weight</h2><p class="muted">No commits in this range.</p></section>`;
  const now = weeks[weeks.length - 1], first = weeks[0];
  const delta = total(now) - total(first);
  // biggest jump between consecutive weeks
  let jump = null;
  for (let i = 1; i < weeks.length; i++) {
    const d = total(weeks[i]) - total(weeks[i - 1]);
    if (!jump || d > jump.d) jump = { d, w: weeks[i] };
  }
  const max = Math.max(...weeks.map(total), 1);
  const W = 100 / weeks.length;
  const bars = weeks.map((w, i) => {
    let acc = 0;
    const segs = CATS.filter((c) => w[c]).map((c) => {
      const h = (w[c] / max) * 100;
      const seg = `<span style="height:${h}%;bottom:${acc}%;background:${CAT_COLOR[c]}"></span>`;
      acc += h;
      return seg;
    }).join('');
    const tip = `${dShort.format(new Date(w.week))}: ${bytes(total(w))} · ${CATS.filter((c) => w[c]).map((c) => `${CAT_LABEL[c]} ${bytes(w[c])}`).join(' · ')}`;
    return `<div class="w-col" style="left:${i * W}%;width:${W}%" title="${esc(tip)}"><div class="w-bar">${segs}</div></div>`;
  }).join('');
  const split = CATS.filter((c) => now[c]).map((c) => `<span class="w-key"><i style="background:${CAT_COLOR[c]}"></i>${CAT_LABEL[c]} <b class="mono">${bytes(now[c])}</b></span>`).join('');
  return `<section class="h-card">
    <div class="h-head"><h2>Site weight</h2>
      <div class="seg">${[12, 26, 52].map((n) => `<button data-weeks="${n}" aria-selected="${st.weeks === n}">${n}w</button>`).join('')}</div>
    </div>
    <div class="h-stats">
      <div><div class="stat-label">Today</div><div class="stat-value">${bytes(total(now))}</div></div>
      <div><div class="stat-label">Change over ${weeks.length} weeks</div><div class="stat-value ${delta > 0 ? 'up-bad' : 'down-good'}">${delta >= 0 ? '+' : '−'}${bytes(Math.abs(delta))}</div></div>
      ${jump && jump.d > 0 ? `<div class="h-jump"><div class="stat-label">Biggest jump</div><div>+${bytes(jump.d)} in the week of ${dShort.format(new Date(jump.w.week))}</div><div class="muted t-ellipsis" title="${esc(jump.w.subject)}">${esc(jump.w.subject)}</div></div>` : ''}
    </div>
    <div class="w-chart">${bars}</div>
    <div class="w-axis mono"><span>${dShort.format(new Date(first.week))}</span><span>${dShort.format(new Date(now.week))}</span></div>
    <div class="w-keys">${split}</div>
    <p class="note" style="margin:10px 0 0">Everything in the repo that ships to the browser, measured at the last commit of each week. Lighthouse scores need a build step, so they're not here yet.</p>
  </section>`;
}

function imageSection() {
  const imgs = st.images;
  if (!imgs) return `<section class="h-card"><h2>Images</h2><div class="loading mono">Checking images…</div></section>`;
  const flagged = imgs.filter((i) => i.issues.length);
  const saved = flagged.filter((i) => i.issues.some((x) => x.startsWith('over'))).reduce((s, i) => s + Math.max(0, i.bytes - 200 * 1024), 0);
  if (!flagged.length) return `<p class="muted h-ok">${icon('Tick02', 14)}${imgs.length ? `All ${imgs.length} recent image${imgs.length === 1 ? ' is' : 's are'} WebP or SVG and under 250 KB.` : 'No new images in the last 6 months.'}</p>`;
  return `<section class="h-card">
    <div class="h-head"><h2>Images to check</h2><span class="mono muted">${flagged.length} of ${imgs.length} added in the last 6 months${saved ? ` · about ${bytes(saved)} to save` : ''}</span></div>
    ${flagged.length ? `<div class="img-list">${flagged.slice(0, 40).map((i) => `<div class="img-row">
        <img class="img-thumb" loading="lazy" src="/api/x/file?repo=${encodeURIComponent(st.repo)}&path=${encodeURIComponent(i.path)}" alt="">
        <span class="img-path"><span class="cm-path"><span class="dir">${esc(i.path.includes('/') ? i.path.slice(0, i.path.lastIndexOf('/') + 1) : '')}</span>${esc(i.path.split('/').pop())}</span>
          <span class="muted img-meta">${i.committed ? `${esc(i.subject || '')} · ${ago(Date.parse(i.date))}` : 'not committed yet'}</span></span>
        <span class="img-issues">${i.issues.map((x) => `<span class="chip ${x.startsWith('over 500') ? 'is-bad' : ''}">${esc(x)}</span>`).join('')}</span>
        <span class="mono">${bytes(i.bytes)}</span>
      </div>`).join('')}</div>` : '<p class="muted">Every recent image is WebP or SVG and under 250 KB. Nice.</p>'}
  </section>`;
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

function draw() {
  if (!host || ctx.view !== 'health') return;
  host.innerHTML = `${st.error ? `<div class="cm-banner is-error"><span>${esc(st.error)}</span></div>` : ''}
    ${weightSection()}${imageSection()}`;
}

function onClick(e) {
  let b;
  if ((b = e.target.closest('[data-weeks]'))) { st.weeks = +b.dataset.weeks; st.weight = null; draw(); api(`/api/x/weight?repo=${encodeURIComponent(st.repo)}&weeks=${st.weeks}`).then((r) => { st.weight = r.weeks; draw(); }); return; }
  if ((b = e.target.closest('[data-copycmd]'))) copy(b.dataset.copycmd, 'Command copied');
}
