// Updates: a quiet card in the sidebar when a new release of staged is out, a "What's new"
// sheet, and a one-click update that restarts staged in place and lands you back where you were.
import { esc, modal, toast } from './ui.js';
import { icon } from './icons.js';
import { mdView } from './md.js';

const KEY_DONE = 'staged-updated', KEY_LATER = 'staged-later';
const store = {
  get: (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
let info = null, card = null;

export function initUpdates(side) {
  card = document.createElement('div');
  card.className = 'upd';
  card.hidden = true;
  side.insertBefore(card, side.querySelector('.side-links'));
  card.addEventListener('click', (e) => { if (e.target.closest('[data-upd-later]')) return later(); openSheet(); });
  celebrate();
  check();
  setInterval(check, 60 * 60 * 1000);
  addEventListener('focus', () => { if (Date.now() - (check.at || 0) > 10 * 60 * 1000) check(); });
}

export async function check(now = false) {
  check.at = Date.now();
  try {
    info = await fetch('/api/update' + (now ? '?now' : ''), { cache: 'no-store' }).then((r) => r.json());
  } catch { return null; }
  paint();
  return info;
}

// For ⌘K: "Check for updates"
export async function checkNow() {
  toast('Looking for updates…');
  const i = await check(true);
  if (!i) return toast("Couldn't check right now");
  if (i.latest) return openSheet();
  toast(i.offline ? "Couldn't reach the repo. Try again later." : `You're on the latest version (${i.current})`);
}

function paint() {
  const l = info?.latest;
  const snoozed = l && store.get(KEY_LATER)?.version === l.version && Date.now() < store.get(KEY_LATER).until;
  if (!l || snoozed) { card.hidden = true; return; }
  const n = l.groups.reduce((s, g) => s + g.items.length, 0);
  card.innerHTML = `<span class="upd-dot" aria-hidden="true"></span>
    <span class="upd-text"><span><b>staged ${esc(l.version)}</b> is ready</span><span class="upd-sub mono">${n ? `${n} change${n > 1 ? 's' : ''} · ` : ''}see what's new</span></span>
    <button class="upd-x" data-upd-later title="Remind me tomorrow" aria-label="Remind me tomorrow">${icon('Cancel01', 13)}</button>`;
  if (card.hidden) { card.hidden = false; card.classList.remove('is-in'); requestAnimationFrame(() => card.classList.add('is-in')); }
}

function later() {
  store.set(KEY_LATER, { version: info.latest.version, until: Date.now() + 24 * 60 * 60 * 1000 });
  card.classList.remove('is-in');
  setTimeout(() => (card.hidden = true), 200);
}

function notes(l) {
  const when = l.date ? new Date(l.date).toLocaleDateString(undefined, { day: 'numeric', month: 'long' }) : '';
  return `<div class="upd-hero">
      <div class="upd-ver"><span class="mono muted">${esc(info.current)}</span>${icon('ArrowRight01', 14)}<b>${esc(l.version)}</b></div>
      ${when ? `<span class="mono muted">${esc(when)}</span>` : ''}
    </div>
    ${l.note ? `<div class="upd-note">${mdView(l.note)}</div>` : ''}
    ${l.groups.map((g) => `<section class="upd-group"><h4 class="mono">${esc(g.label)}</h4><ul>${g.items.slice(0, 12).map((x) => `<li>${esc(x)}</li>`).join('')}${g.items.length > 12 ? `<li class="muted">and ${g.items.length - 12} more</li>` : ''}</ul></section>`).join('')}
    ${!l.note && !l.groups.length ? '<p class="muted">Small fixes and polish.</p>' : ''}
    ${info.blocked ? `<div class="cm-alert upd-block">${icon('Alert02', 14)}<span>${esc(info.blocked)}</span></div>` : ''}
    <div class="upd-progress" hidden><div class="upd-bar"><span></span></div><span class="upd-step mono">Getting ${esc(l.version)}…</span></div>`;
}

function openSheet() {
  const l = info?.latest;
  if (!l) return;
  const m = modal({
    title: "What's new",
    body: notes(l),
    actions: `<span class="upd-foot muted">Takes a few seconds. You'll stay right where you are.</span>
      <button class="text-btn bordered" data-upd-close>Later</button>
      <button class="btn-primary" data-upd-go ${info.blocked ? 'disabled' : ''} autofocus>Update now</button>`,
  });
  m.el.querySelector('[data-upd-close]').addEventListener('click', () => { later(); m.close(); });
  m.el.querySelector('[data-upd-go]').addEventListener('click', () => run(m, l));
}

async function run(m, l) {
  const go = m.el.querySelector('[data-upd-go]');
  const bar = m.el.querySelector('.upd-progress'), step = m.el.querySelector('.upd-step');
  go.disabled = true; go.textContent = 'Updating…';
  m.el.querySelector('[data-upd-close]').hidden = true;
  m.el.querySelector('.upd-foot').hidden = true;
  bar.hidden = false;
  requestAnimationFrame(() => bar.classList.add('is-on'));
  try {
    const res = await fetch('/api/update', { method: 'POST', headers: { 'x-changes': '1' } });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || 'Update failed');
    store.set(KEY_DONE, { from: out.from, to: out.to, groups: l.groups, at: Date.now() });
    store.set(KEY_LATER, null);
    step.textContent = 'Restarting staged…';
    bar.classList.add('is-late');
    // The page reloads by itself when the new server is up. If it doesn't, wait for it here.
    const until = Date.now() + 30000;
    const wait = async () => {
      if (Date.now() > until) { step.textContent = 'Almost there. Reload the page if it doesn’t refresh.'; return; }
      try {
        const v = await fetch('/api/update', { cache: 'no-store' }).then((r) => r.json());
        if (v.current === out.to) return location.reload();
      } catch {}
      setTimeout(wait, 700);
    };
    setTimeout(wait, 1500);
  } catch (e) {
    bar.hidden = true;
    go.disabled = false; go.textContent = 'Try again';
    m.el.querySelector('[data-upd-close]').hidden = false;
    const msg = m.el.querySelector('.upd-block') || Object.assign(document.createElement('div'), { className: 'cm-alert upd-block' });
    msg.innerHTML = `${icon('Alert02', 14)}<span>${esc(e.message)}</span>`;
    m.el.querySelector('.modal-body').appendChild(msg);
  }
}

// After an update: a small "you're on the new version" moment, once.
async function celebrate() {
  const done = store.get(KEY_DONE);
  if (!done) return;
  store.set(KEY_DONE, null);
  if (Date.now() - done.at > 5 * 60 * 1000) return;
  const first = done.groups?.[0]?.items?.[0];
  const el = document.createElement('div');
  el.className = 'upd-done';
  el.setAttribute('role', 'status');
  el.innerHTML = `<span class="upd-burst" aria-hidden="true">${Array.from({ length: 10 }, (_, i) => `<i style="--a:${i * 36}deg;--d:${(i % 3) * 40}ms"></i>`).join('')}</span>
    <span class="upd-check">${icon('Tick02', 14)}</span>
    <span><b>You're on staged ${esc(done.to)}</b>${first ? `<span class="muted"> · ${esc(first)}</span>` : ''}</span>`;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('is-in'));
  setTimeout(() => { el.classList.remove('is-in'); setTimeout(() => el.remove(), 400); }, 5200);
}
