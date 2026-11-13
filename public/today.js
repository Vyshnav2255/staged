// Today: where you left things, across every repo.
import { icon } from './icons.js';
import { esc, ago, api, toast, copy, hostOf } from './ui.js';

let host = null, ctx = null, data = null, busy = null;

export function mountToday(el, context) {
  host = el; ctx = context;
  if (!host.dataset.todayBound) { host.addEventListener('click', onClick); host.dataset.todayBound = '1'; }
  draw();
  load();
}

async function load() {
  try { data = await api('/api/x/today'); } catch (e) { data = { error: e.message, repos: [] }; }
  draw();
}

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

function draw() {
  if (!host || ctx.view !== 'today') return;
  const recap = ctx.recap();
  if (!data) { host.innerHTML = `<div class="today-hello"><h2>${greeting()}</h2><p class="muted">Looking at your repos…</p></div>`; return; }
  const repos = data.repos || [];
  const waiting = repos.filter((r) => r.dirty || r.ahead).sort((a, b) => (a.oldest || Infinity) - (b.oldest || Infinity));
  const loose = repos.filter((r) => r.staleBranches || r.stashes);
  const line = waiting.length
    ? `${waiting.length} repo${waiting.length > 1 ? 's have' : ' has'} work waiting${waiting.some((r) => r.ahead) ? ', some of it ready to push' : ''}.`
    : 'Everything is committed and pushed.';
  host.innerHTML = `
    <div class="today-hello"><h2>${greeting()}</h2><p class="muted">${line}</p></div>
    ${recap ? `<section class="recap">
      <div class="recap-label mono">${esc(recap.label)}</div>
      <p class="recap-text">${esc(recap.text)}</p>
      <div class="recap-tools"><button class="text-btn bordered" data-copyrecap>${icon('Copy01', 14)}Copy</button></div>
    </section>` : ''}
    <h3 class="h-sub">Waiting on you</h3>
    ${waiting.length ? `<div class="today-list">${waiting.map((r) => `<div class="today-row">
        <div class="today-main">
          <div class="feat-name">${esc(r.name)} <span class="mono muted">${esc(r.branch)}</span></div>
          <div class="muted today-meta">
            ${r.dirty ? `${r.dirty} uncommitted file${r.dirty > 1 ? 's' : ''}${r.oldest ? `, oldest from ${ago(r.oldest)}` : ''}` : ''}
            ${r.dirty && r.ahead ? ' · ' : ''}
            ${r.ahead ? `${r.ahead} commit${r.ahead > 1 ? 's' : ''} to push` : ''}
            ${r.behind ? ` · ${r.behind} behind ${esc(hostOf(ctx.repos?.find((x) => x.name === r.name)).name)}` : ''}
          </div>
        </div>
        ${r.oldest && Date.now() - r.oldest > 3 * 864e5 ? '<span class="chip is-bad">sitting a while</span>' : ''}
        <div class="today-actions">
          ${r.ahead ? `<button class="text-btn bordered" data-push="${esc(r.name)}" ${busy ? 'disabled' : ''}>${icon('ArrowUp02', 14)}${busy === r.name ? 'Pushing…' : 'Push'}</button>` : ''}
          ${r.dirty ? `<button class="btn-primary" data-commit="${esc(r.name)}">Commit</button>` : ''}
        </div>
      </div>`).join('')}</div>` : '<p class="muted">Nothing waiting. Go make something.</p>'}
    ${loose.length ? `<h3 class="h-sub">Loose ends</h3><div class="today-list">${loose.map((r) => `<button class="today-row is-link" data-health="${esc(r.name)}">
        <div class="today-main"><div class="feat-name">${esc(r.name)}</div>
        <div class="muted today-meta">${[r.staleBranches ? `${r.staleBranches} stale branch${r.staleBranches > 1 ? 'es' : ''}` : '', r.stashes ? `${r.stashes} stash${r.stashes > 1 ? 'es' : ''}` : ''].filter(Boolean).join(' · ')}</div></div>
        ${icon('ArrowRight01', 14)}
      </button>`).join('')}</div>` : ''}`;
}

async function onClick(e) {
  let b;
  if ((b = e.target.closest('[data-copyrecap]'))) return copy(ctx.recap().text, 'Recap copied');
  if ((b = e.target.closest('[data-commit]'))) return ctx.go(b.dataset.commit, 'commit');
  if ((b = e.target.closest('[data-health]'))) return ctx.go(b.dataset.health, 'health');
  if ((b = e.target.closest('[data-push]'))) {
    busy = b.dataset.push; draw();
    try { await api(`/api/x/push?repo=${encodeURIComponent(busy)}`, {}); toast(`Pushed ${busy}`); }
    catch (err) { toast(err.message); }
    busy = null; load(); ctx.onChange();
  }
}
