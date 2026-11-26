// Run: a project's own commands on a button. The main one sits on top (for a Jekyll site that's
// "Serve site"); a dev server's page opens by itself once it says where it is. Opens as a side
// panel from the Run button in the repo header, or from ⌘K.
import { icon } from './icons.js';
import { esc, modal, toast, api, ago as since } from './ui.js';
import { sfxApproved, sfxDrain, sfxClunk, warmHum, sfxError, sfxKey, sfxOpen, sfxCopy } from './sfx.js';
import { leave } from './motion.js';

const cache = new Map(); // repo -> { commands, jobs }
const q = (repo) => `repo=${encodeURIComponent(repo)}`;
const live = (j) => j && (j.state === 'running' || j.state === 'stopping');
let onJobsChange = () => {};
export function onRunChange(fn) { onJobsChange = fn; }
export const runCache = (repo) => cache.get(repo);
export const running = (repo) => (cache.get(repo)?.jobs || []).filter(live);

// Every running command in every repo, for the sidebar and Home. Cheap, so it's polled.
let all = [], onAllChange = () => {};
export const runningAll = () => all;
export function onRunningChange(fn) { onAllChange = fn; }
export async function loadRunning() {
  try {
    const { jobs } = await api('/api/run/running');
    const key = (l) => l.map((j) => `${j.repo}\0${j.id}\0${j.url || ''}`).join('|');
    if (key(jobs) !== key(all)) { all = jobs; onAllChange(all); }
  } catch {}
  return all;
}

export async function loadRun(repo) {
  if (!repo || repo === 'all') return null;
  try { const d = await api(`/api/run/list?${q(repo)}`); cache.set(repo, d); onJobsChange(repo, d); loadRunning(); return d; }
  catch { return null; }
}
export async function runCommand(repo, id) {
  try { await api(`/api/run/start?${q(repo)}`, { id }); } catch (e) { return toast(e.message); }
  await loadRun(repo);
}

// What a command is doing right now. The server only says running/done/failed/stopped, so "boot"
// (a dev server that hasn't said its address yet) and "live" (it has) are worked out here.
const PHASE = { idle: 'Ready', boot: 'Starting', live: 'Live', busy: 'Running', stopping: 'Stopping', done: 'Done', failed: 'Failed', stopped: 'Stopped' };
const phaseOf = (c, j) => (!j ? 'idle' : j.state !== 'running' ? j.state : j.url ? 'live' : c.kind === 'serve' ? 'boot' : 'busy');
const p2 = (n) => String(n).padStart(2, '0');
const clock = (t) => { const s = Math.max(0, Math.floor((Date.now() - t) / 1000)); return (s >= 3600 ? `${Math.floor(s / 3600)}:` : '') + `${p2(Math.floor(s / 60) % 60)}:${p2(s % 60)}`; };
const took = (ms) => (ms < 1000 ? 'under a second' : ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`);
const host = (u) => { try { const x = new URL(u); return x.host + (x.pathname === '/' ? '' : x.pathname); } catch { return u; } };
const lastLine = (log) => String(log || '').trim().split('\n').pop().trim();
// Output, one span per line so an address or an error can be picked out and new lines can ease in.
const lines = (log) => String(log).replace(/\n$/, '').split('\n').map((l) =>
  `<span class="rn-ln${/https?:\/\/\S+/.test(l) ? ' is-url' : /\b(error|failed|fatal|exception)\b|ERR!/i.test(l) ? ' is-err' : ''}">${esc(l)}\n</span>`).join('');

export function openRun(repo) {
  if (!repo || repo === 'all') return toast('Open a repo first');
  let d = cache.get(repo), logOf = null, adding = false, timer = null, stuck = true, shown = null;
  const was = new Map(), seen = new Map(); // id -> last phase / how many output lines were already shown
  const jobOf = (id) => d?.jobs?.find((j) => j.id === id);
  const log = (c, j, on) => (logOf === c.id && j ? `<div class="rn-logwrap"><pre class="rn-log mono scroll-fade" data-rn-pre data-id="${esc(c.id)}">${j.log ? lines(j.log) : '<span class="rn-ln is-none">No output yet</span>'}${on ? '<i class="rn-caret"></i>' : ''}</pre>${j.log ? `<button class="rn-copy" data-rn-copy="${esc(c.id)}" aria-label="${j.state === 'failed' ? 'Copy the error report' : 'Copy the output'}">${icon('Copy01', 12)}<span>${j.state === 'failed' ? 'Copy error' : 'Copy output'}</span></button>` : ''}</div>` : '');
  // What the copy button puts on the clipboard: enough to debug from anywhere (an issue, a chat, Claude).
  // The last 30 lines, not just the red one: the line before an error is often the real cause.
  const report = (c, j) => {
    const out = String(j.log || '').replace(/\n+$/, '').split('\n'), tail = out.slice(-30);
    const end = j.ended || Date.now(), how = j.state === 'failed' ? `failed${j.code != null ? ` (exit code ${j.code})` : ''}` : j.state === 'running' ? (j.url ? `running at ${j.url}` : 'running') : j.state;
    return [`Project: ${repo}${c.from && c.from !== 'yours' ? ` (${c.from})` : ''}`, `Command: ${c.cmd}`, `Result: ${how} after ${took(end - j.at)}`, `Ran: ${new Date(j.at).toLocaleString()}`, '',
      `Output${out.length > tail.length ? ` (last ${tail.length} of ${out.length} lines)` : ''}:`, ...tail].join('\n') + '\n';
  };
  const logBtn = (c, j) => (j ? `<button class="icon-btn sm ${logOf === c.id ? 'is-on' : ''}" data-rn-log="${esc(c.id)}" title="Output" aria-label="Show output">${icon('Terminal', 14)}</button>` : '');
  const moreBtn = (c) => `<button class="icon-btn sm rn-more" data-rn-more="${esc(c.id)}" title="More" aria-label="More for ${esc(c.label)}">${icon('MoreHorizontal', 14)}</button>`;
  // The main command is a cassette deck: the tape's label says what it's playing (the address once a
  // server is up), the reels turn while it runs, a counter keeps time, and a flat tray of icon keys runs it.
  const deck = (c) => {
    const j = jobOf(c.id), ph = phaseOf(c, j), on = live(j);
    const label = ph === 'live' ? `<span class="rn-lab-main mono">${esc(host(j.url))}</span>`
      : ph === 'failed' ? `<span class="rn-lab-main mono is-err" title="${esc(lastLine(j.log))}">${esc(lastLine(j.log) || 'It stopped with an error')}</span>`
      : ph === 'done' ? `<span class="rn-lab-main">Finished${j.ended ? ` in ${took(j.ended - j.at)}` : ''}${icon('Tick02', 13)}</span>`
      : ph === 'boot' ? `<span class="rn-lab-main is-quiet">Warming up…</span>`
      : `<span class="rn-lab-main">${esc(c.label)}</span>`;
    const count = on ? `<span class="rn-count mono" data-rn-up="${j.at}"></span>` : `<span class="rn-count mono">${j?.ended ? clock(Date.now() - (j.ended - j.at)) : '00:00'}</span>`;
    return `<section class="rn-deck is-${ph}" data-id="${esc(c.id)}">
      <header class="rn-deck-top"><span class="rn-brand" aria-hidden="true">${icon('Queue02', 13)}<b>staged</b><i class="mono">stereo</i></span><span class="rn-state mono">${PHASE[ph]}</span><i class="rn-led"></i></header>
      <div class="rn-tape">
        <div class="rn-label">${label}<code class="rn-lab-cmd mono" title="${esc(c.cmd)}">${esc(c.cmd)}</code></div>
        <div class="rn-window"><span class="rn-reel is-l"><i></i></span><span class="rn-band"></span><span class="rn-reel is-r"><i></i></span>${count}</div>
        <span class="rn-screw is-a"></span><span class="rn-screw is-b"></span>
      </div>
      <div class="rn-keys">
        <button class="rn-k ${on ? 'is-down' : ''}" data-rn-go="${esc(c.id)}" ${on ? 'disabled' : ''} data-tip="${on ? 'Running' : 'Run'}" aria-label="Run ${esc(c.label)}" aria-pressed="${on}">${icon('Play', 14)}<span>Run</span></button>
        <button class="rn-k" data-rn-stop="${esc(c.id)}" data-tip="${ph === 'stopping' ? 'Stopping…' : 'Stop'}" ${on && ph !== 'stopping' ? '' : 'disabled'} aria-label="Stop ${esc(c.label)}">${icon('Stop', 13)}<span>${ph === 'stopping' ? 'Wait' : 'Stop'}</span></button>
        <button class="rn-k is-ink" ${j?.url && on ? `data-rn-open="${esc(c.id)}"` : 'disabled'} data-tip="${j?.url && on ? `Open ${esc(host(j.url))}` : 'Opens once it serves a page'}">${icon('LinkSquare02', 14)}<span>Open</span></button>
        <button class="rn-k rn-k-out ${logOf === c.id ? 'is-on' : ''}" ${j ? `data-rn-log="${esc(c.id)}"` : 'disabled'} data-tip="${!j ? 'No output yet' : logOf === c.id ? 'Hide output' : 'Show output'}" aria-label="Output" aria-pressed="${logOf === c.id}">${icon('Terminal', 15)}</button>
        <button class="rn-k rn-k-out" data-rn-more="${esc(c.id)}" data-tip="More" aria-label="More for ${esc(c.label)}">${icon('MoreHorizontal', 15)}</button>
      </div>
    </section>${log(c, j, on)}`;
  };
  const row = (c, i) => {
    const j = jobOf(c.id), ph = phaseOf(c, j), on = live(j);
    const st = !j ? '' : `<span class="rn-st">${ph === 'live' ? `<button class="rn-chip mono" data-rn-open="${esc(c.id)}" title="Open ${esc(j.url)}">${esc(host(j.url))}${icon('LinkSquare02', 11)}</button>` : `<span>${PHASE[ph]}${ph === 'failed' && j.code != null ? ` · exit ${esc(j.code)}` : ''}</span>`}
      ${on ? `<span class="mono" data-rn-up="${j.at}"></span>` : j.ended ? `<span class="rn-when">${since(j.ended)}</span>` : ''}</span>`;
    return `<div class="rn-row is-${ph}" data-id="${esc(c.id)}">
      <span class="rn-trk mono">${String(i + 2).padStart(2, '0')}</span>
      <div class="rn-main"><b>${esc(c.label)}</b><code class="mono" title="${esc(c.cmd)}">${esc(c.cmd)}</code>${st}</div>
      <div class="rn-tools">${logBtn(c, j)}
        ${on ? `<button class="icon-btn sm rn-stop" data-rn-stop="${esc(c.id)}" title="Stop" aria-label="Stop ${esc(c.label)}">${icon('Stop', 13)}</button>`
             : `<button class="icon-btn sm rn-go" data-rn-go="${esc(c.id)}" title="Run ${esc(c.cmd)}" aria-label="Run ${esc(c.label)}">${icon('Play', 13)}</button>`}
        ${moreBtn(c)}</div>
    </div>${log(c, j, on)}`;
  };
  const body = () => {
    if (!d) return '<p class="muted">Reading this project…</p>';
    const [first, ...rest] = d.commands;
    return `${first ? deck(first) : `<p class="rn-empty">staged didn't find any commands here. Add the one you use below.</p>`}
      ${rest.length ? `<p class="ps-h rn-h">More commands</p><div class="rn-list">${rest.map(row).join('')}</div>` : ''}
      ${adding ? `<form class="rn-add" data-rn-form>
          <label class="field"><span>Command</span><input class="mono" name="cmd" placeholder="npm run dev" spellcheck="false" autofocus></label>
          <label class="field"><span>Name <em class="muted">optional</em></span><input name="label" placeholder="Dev server"></label>
          <label class="rn-check"><input type="checkbox" name="serve"><span>Keeps running and serves a page (open it when ready)</span></label>
          <div class="rn-add-foot"><button type="button" class="text-btn bordered" data-rn-cancel>Cancel</button><button class="btn-primary">Add</button></div>
        </form>` : `<button class="rn-addbtn" data-rn-add>${icon('Add01', 14)}Add a command</button>`}`;
  };
  const m = modal({ title: `Run ${repo}`, body: `<div data-rn>${body()}</div>`, side: true, repo, follow: (r) => openRun(r), onClose: () => { clearTimeout(timer); clearInterval(beat); closeMenu(); } });
  m.el.classList.add('is-ps', 'is-run');
  const box = () => m.el.querySelector('[data-rn]');
  const byId = (sel, id) => [...box().querySelectorAll(sel)].filter((n) => n.dataset.id === id);
  const stamp = () => box().querySelectorAll('[data-rn-up]').forEach((n) => { n.textContent = clock(+n.dataset.rnUp); });
  const paint = () => {
    const pre = box().querySelector('[data-rn-pre]'), top = pre?.scrollTop;
    if (pre) stuck = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
    const keep = document.activeElement && box().contains(document.activeElement) && document.activeElement.matches('input') ? document.activeElement.name : null;
    if (adding && keep) return; // don't wipe the form while typing
    // Which commands just changed state: those get their moment (a new label goes on, the light pings).
    const fresh = new Map();
    for (const c of d?.commands || []) { const ph = phaseOf(c, jobOf(c.id)); if (was.has(c.id) && was.get(c.id) !== ph) fresh.set(c.id, ph); was.set(c.id, ph); }
    const html = body();
    // Only rebuild when something really changed, so the lights keep breathing and hover isn't lost.
    // The clocks tick on their own; --rn-sync keeps looping animations in step across rebuilds.
    if (html !== shown) {
      shown = html;
      box().innerHTML = `<div class="rn-in" style="--rn-sync:${-Math.round(performance.now())}ms">${html}</div>`;
      const p = box().querySelector('[data-rn-pre]');
      if (p) {
        const had = seen.get(p.dataset.id);
        if (had != null) [...p.querySelectorAll('.rn-ln')].slice(had).forEach((n) => n.classList.add('is-new'));
        p.scrollTop = stuck ? p.scrollHeight : top || 0;
      }
    }
    const p = box().querySelector('[data-rn-pre]');
    seen.clear(); if (p) seen.set(p.dataset.id, p.querySelectorAll('.rn-ln').length);
    for (const [id, ph] of fresh) {
      byId('.rn-deck, .rn-row', id).forEach((n) => n.classList.add('is-fresh'));
      if (ph === 'live') sfxApproved(); else if (ph === 'failed') sfxError();
    }
    // the warm-up hum plays while anything here is still getting ready
    warmHum((d?.commands || []).some((c) => phaseOf(c, jobOf(c.id)) === 'boot'));
    stamp();
  };
  const beat = setInterval(stamp, 1000);
  // While the panel is open, follow the output: every second when something runs, slower otherwise.
  const tick = async () => { d = (await loadRun(repo)) || d; if (!m.el.isConnected) warmHum(false); if (m.el.isConnected) { paint(); clearTimeout(timer); timer = setTimeout(tick, running(repo).length ? 1000 : 4000); } };
  if (d) paint();
  tick();
  const act = async (fn) => { try { const r = await fn(); if (r?.commands) d.commands = r.commands; } catch (e) { toast(e.message); } d = (await loadRun(repo)) || d; paint(); clearTimeout(timer); timer = setTimeout(tick, 1000); };
  m.el.addEventListener('click', (e) => {
    const t = (s) => e.target.closest(s); let b;
    if ((b = t('[data-rn-go]'))) { const id = b.dataset.rnGo; logOf = id; stuck = true; sfxClunk(); warmHum(true); return act(() => api(`/api/run/start?${q(repo)}`, { id })); }
    if ((b = t('[data-rn-stop]'))) { sfxClunk(true); warmHum(false); return act(() => api(`/api/run/stop?${q(repo)}`, { id: b.dataset.rnStop })); }
    if ((b = t('[data-rn-open]'))) { sfxOpen(); return act(() => api(`/api/run/open?${q(repo)}`, { id: b.dataset.rnOpen })); }
    if ((b = t('[data-rn-copy]'))) {
      const c = d.commands.find((x) => x.id === b.dataset.rnCopy), j = c && jobOf(c.id); if (!j) return;
      const lab = b.querySelector('span'), was = lab.textContent;
      return navigator.clipboard.writeText(report(c, j)).then(() => { sfxCopy(); b.classList.add('is-done'); b.firstElementChild.outerHTML = icon('Tick02', 12); lab.textContent = 'Copied'; setTimeout(() => { if (!b.isConnected) return; b.classList.remove('is-done'); b.firstElementChild.outerHTML = icon('Copy01', 12); lab.textContent = was; }, 1600); }, () => toast("Couldn't copy"));
    }
    if ((b = t('[data-rn-log]'))) { logOf = logOf === b.dataset.rnLog ? null : b.dataset.rnLog; sfxKey(!!logOf); stuck = true; return paint(); }
    if (t('[data-rn-add]')) { adding = true; paint(); return box().querySelector('[name=cmd]')?.focus(); }
    if (t('[data-rn-cancel]')) { adding = false; return paint(); }
    if ((b = t('[data-rn-more]'))) { sfxKey(!menu); return moreMenu(b, d.commands.find((c) => c.id === b.dataset.rnMore), d.commands[0]?.id === b.dataset.rnMore); }
  });
  m.el.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target), cmd = String(f.get('cmd') || '').trim();
    if (!cmd) return e.target.querySelector('[name=cmd]').focus();
    adding = false;
    act(() => api(`/api/run/save?${q(repo)}`, { add: { cmd, label: String(f.get('label') || '').trim(), kind: f.get('serve') ? 'serve' : 'task' } }));
  });
  // Make a command the main button, or take it off the list.
  let menu = null;
  const closeMenu = () => { menu?.opener?.removeAttribute('aria-expanded'); leave(menu); menu = null; removeEventListener('pointerdown', outside, true); removeEventListener('keydown', menuKey, true); };
  // a press on the same "…" is left to its click, which closes the menu; anywhere else closes it now
  const outside = (e) => { if (menu && !menu.contains(e.target) && e.target.closest?.('[data-rn-more]')?.dataset.rnMore !== menu.for) closeMenu(); };
  const menuKey = (e) => { if (e.key === 'Escape' && menu) { e.stopPropagation(); const id = menu.for; closeMenu(); box().querySelector(`[data-rn-more="${CSS.escape(id)}"]`)?.focus(); } };
  function moreMenu(btn, c, isMain) {
    if (menu) { const same = menu.for === btn.dataset.rnMore; closeMenu(); if (same) return; }
    if (!c) return;
    menu = document.createElement('div'); menu.className = 'cm-menu'; menu.setAttribute('role', 'menu'); menu.opener = btn; menu.for = btn.dataset.rnMore; btn.setAttribute('aria-expanded', 'true');
    menu.innerHTML = `${isMain ? '' : `<button role="menuitem" data-m="main"><span class="cm-menu-ic">${icon('Play', 14)}</span><span>Make it the main button</span></button>`}
      <button role="menuitem" data-m="remove" class="is-danger"><span class="cm-menu-ic">${icon('Delete02', 14)}</span><span>${c.custom ? 'Remove' : 'Hide from this list'}</span></button>`;
    document.body.appendChild(menu);
    const r = btn.getBoundingClientRect(), w = 230;
    Object.assign(menu.style, { position: 'fixed', zIndex: 90, width: w + 'px', left: Math.max(12, r.right - w) + 'px', top: r.bottom + 6 + 'px' });
    menu.addEventListener('click', (e) => {
      const b = e.target.closest('[data-m]'); if (!b) return; closeMenu();
      if (b.dataset.m === 'main') return act(() => api(`/api/run/save?${q(repo)}`, { main: c.id }));
      if (live(jobOf(c.id))) return toast('Stop it first');
      act(() => api(`/api/run/save?${q(repo)}`, { remove: c.id }));
    });
    setTimeout(() => { addEventListener('pointerdown', outside, true); addEventListener('keydown', menuKey, true); });
  }
  return m;
}
