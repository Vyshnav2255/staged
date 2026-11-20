// Receipts and weekly statements. Both are described once as a "spec" (rows of text), which is
// turned into the paper in the side panel (specHtml) and into the share image (receipt-image.js),
// so the two always match.
import qrcode from './vendor/qrcode.js';
import { esc } from './ui.js';
import { icon } from './icons.js';

export const MARK = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true"><path d="M18 18H6C5.05719 18 4.58579 18 4.29289 17.7071C4 17.4142 4 16.9428 4 16C4 15.0572 4 14.5858 4.29289 14.2929C4.58579 14 5.05719 14 6 14H18C18.9428 14 19.4142 14 19.7071 14.2929C20 14.5858 20 15.0572 20 16C20 16.9428 20 17.4142 19.7071 17.7071C19.4142 18 18.9428 18 18 18Z" fill="#1f9a6a" fill-opacity=".18" stroke="#1f9a6a" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 10H20" stroke="#4cbb6c" stroke-width="1.75" stroke-linecap="round"/><path d="M4 6H20" stroke="#c4e35a" stroke-width="1.75" stroke-linecap="round"/></svg>`;

const day = (t) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const time = (t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : /(s|sh|ch|x)$/.test(w) ? 'es' : 's'}`;
const no4 = (n) => String(n || 1).padStart(4, '0');

// ---------- the log of pushes, for weekly statements ----------
const LOG = 'staged-receipts';
export function logPush(R) {
  try {
    const list = JSON.parse(localStorage.getItem(LOG) || '[]');
    list.push({ at: R.at, repo: R.name, n: R.items.length, files: sum(R.items, 'files'), add: sum(R.items, 'add'), del: sum(R.items, 'del'), no: R.no });
    localStorage.setItem(LOG, JSON.stringify(list.slice(-1000)));
  } catch {}
}
function pushLog() { try { return JSON.parse(localStorage.getItem(LOG) || '[]'); } catch { return []; } }
const sum = (xs, k) => xs.reduce((s, x) => s + (x[k] || 0), 0);

// ISO week: Monday to Sunday.
export function weekOf(t = Date.now()) {
  const d = new Date(t); d.setHours(0, 0, 0, 0);
  const start = new Date(d); start.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  const end = new Date(start); end.setDate(start.getDate() + 7);
  const th = new Date(start); th.setDate(start.getDate() + 3);
  const jan4 = new Date(th.getFullYear(), 0, 4);
  const week = 1 + Math.round(((th - jan4) / 864e5 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
  return { start: +start, end: +end, week };
}

// ---------- specs ----------
// The link a receipt's QR code opens: every change in this push, on the remote's website.
export function compareUrl(remote, provider, base, head) {
  if (!remote || !head) return '';
  if (base && provider === 'github') return `${remote}/compare/${base.slice(0, 12)}...${head.slice(0, 12)}`;
  if (base && provider === 'gitlab') return `${remote}/-/compare/${base.slice(0, 12)}...${head.slice(0, 12)}`;
  return `${remote}${provider === 'gitlab' ? '/-/commit/' : provider === 'bitbucket' ? '/commits/' : '/commit/'}${head}`;
}

export function receiptSpec(R) {
  return {
    kind: 'receipt',
    label: `${R.practice ? 'Practice receipt' : 'Push receipt'} · No. ${no4(R.no)}`,
    meta: [['Repo', R.name], ['Date', `${day(R.at)} · ${time(R.at)}`], ['Branch', `${R.branch} → ${R.upstream}`]],
    // The subject gets the whole line; the code, files and lines sit under it like a receipt's small print.
    head: ['Item', 'Lines'],
    items: R.items.slice().reverse().map((c, i) => ({ l: c.subject, r: '', sl: `${String(i + 1).padStart(2, '0')} · ${c.sha.slice(0, 7)} · ${plural(c.files || 0, 'file')}`, sr: `+${c.add || 0} −${c.del || 0}` })),
    totals: [['Files', String(sum(R.items, 'files'))], ['Total lines', `+${sum(R.items, 'add')} −${sum(R.items, 'del')}`, true]],
    note: R.practice ? 'Practice run. Nothing was pushed.' : 'Thanks for shipping.',
    stamp: ['Shipped', new Date(R.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })],
    qr: R.link || (R.practice ? 'staged · practice receipt' : ''),
    qrLabel: R.link ? 'Scan to see what changed' : R.practice ? 'Your real receipts link to the changes' : '',
    seed: R.items[0]?.sha || '0',
    file: `staged-receipt-${R.name}-${new Date(R.at).toISOString().slice(0, 10)}`,
  };
}

// pushes: from the server (git's reflog of every remote branch); falls back to staged's own log.
export function statementSpec(fromGit, now = Date.now()) {
  const wk = weekOf(now);
  const pushes = (fromGit || pushLog()).filter((p) => p.at >= wk.start && p.at < wk.end).sort((a, b) => a.at - b.at);
  // One line per project: every push to it this week, added up, busiest project first.
  const byRepo = new Map();
  for (const p of pushes) {
    const r = byRepo.get(p.repo) || { repo: p.repo, n: 0, files: 0, add: 0, del: 0, days: new Set(), last: 0 };
    r.n += p.n || 0; r.files += p.files || 0; r.add += p.add || 0; r.del += p.del || 0; r.last = Math.max(r.last, p.at);
    r.days.add(new Date(p.at).toLocaleDateString('en-GB', { weekday: 'short' }));
    byRepo.set(p.repo, r);
  }
  const projects = [...byRepo.values()].sort((a, b) => b.n - a.n || b.add + b.del - (a.add + a.del) || b.last - a.last);
  const range = `${new Date(wk.start).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} – ${new Date(wk.end - 1).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
  return {
    kind: 'statement',
    label: `Weekly statement · Week ${wk.week}`,
    meta: [['Period', range]],
    head: ['Project', 'Commits'],
    items: projects.map((r) => ({ l: r.repo, r: plural(r.n, 'commit'), sl: [...r.days].join(', '), sr: `+${r.add} −${r.del}` })),
    empty: 'No pushes yet this week.',
    totals: [['Pushes', String(pushes.length)], ['Commits', String(sum(pushes, 'n'))], ['Files', String(sum(pushes, 'files'))], ['Total lines', `+${sum(pushes, 'add')} −${sum(pushes, 'del')}`, true]],
    note: pushes.length ? 'Keep shipping.' : 'Your pushes this week will add up here.',
    stamp: ['Settled', `Week ${wk.week}`],
    qr: '',
    seed: String(wk.start),
    file: `staged-statement-week-${wk.week}-${new Date(wk.start).getFullYear()}`,
  };
}

// ---------- QR ----------
export function qrMatrix(text) {
  const q = qrcode(0, 'M');
  q.addData(unescape(encodeURIComponent(text)));
  q.make();
  const n = q.getModuleCount();
  return { n, dark: (r, c) => q.isDark(r, c) };
}
function qrSvg(text, px = 96) {
  const { n, dark } = qrMatrix(text);
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (dark(r, c)) d += `M${c} ${r}h1v1h-1z`;
  return `<svg class="rcpt-qr" viewBox="-2 -2 ${n + 4} ${n + 4}" width="${px}" height="${px}" shape-rendering="crispEdges" aria-hidden="true"><path d="${d}" fill="currentColor"/></svg>`;
}

// ---------- paper ----------
export function specHtml(s) {
  const row = (l, r, cls = '') => `<div class="rcpt-row ${cls}"><span>${esc(l)}</span><span class="mono">${esc(r)}</span></div>`;
  return `<div class="rcpt is-${s.kind}">
    <div class="rcpt-top"><span class="rcpt-brand">${MARK.replace('<svg ', '<svg class="rcpt-mark" ')}<span>staged</span></span><span class="mono">${esc(s.label)}</span></div>
    <div class="rcpt-meta">${s.meta.map(([l, r]) => `<div class="rcpt-row mono"><span>${esc(l)}</span><span>${esc(r)}</span></div>`).join('')}</div>
    <hr>
    ${s.head && s.items.length ? `<div class="rcpt-row rcpt-head mono"><span>${esc(s.head[0])}</span><span>${esc(s.head[1])}</span></div>` : ''}
    ${s.items.length ? s.items.map((it) => `<div class="rcpt-item">${it.r ? row(it.l, it.r) : `<div class="rcpt-row rcpt-line"><span>${esc(it.l)}</span></div>`}<div class="rcpt-row rcpt-sub mono"><span>${esc(it.sl)}</span><span>${esc(it.sr)}</span></div></div>`).join('') : `<p class="rcpt-empty">${esc(s.empty || '')}</p>`}
    <hr>
    ${s.totals.map(([l, r, b]) => row(l, r, b ? 'rcpt-total' : '')).join('')}
    <hr>
    ${s.ok ? `<div class="rcpt-ok mono">${icon('Tick02', 13)}${esc(s.ok)}</div>` : ''}
    <div class="rcpt-thanks">${esc(s.note)}</div>
    <div class="rcpt-stamp" aria-hidden="true"><span>${esc(s.stamp[0])}</span><small>${esc(s.stamp[1])}</small></div>
    ${s.qr ? `<div class="rcpt-code">${qrSvg(s.qr)}${s.qrLabel ? `<span class="mono">${esc(s.qrLabel)}</span>` : ''}</div>`
      : `<div class="rcpt-bar" aria-hidden="true">${[...String(s.seed).replace(/\D/g, '').padEnd(20, '7').slice(0, 24)].map((ch) => `<i style="width:${1 + (+ch % 3)}px"></i>`).join('')}</div>`}
  </div>`;
}
