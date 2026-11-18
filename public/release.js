// Releases, changelog, weekly recap and feature stories.
import { icon } from './icons.js';
import { esc, compact, api, toast, copy, modal, dLong, dShort, dMonth, TYPES, TYPE_LABEL, hostOf } from './ui.js';

const DAY = 86400000;
const NOTES_LABEL = { feature: 'New', ui: 'Design', fix: 'Fixes', perf: 'Performance', refactor: 'Maintenance', other: 'Other' };
const weekStart = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); };
const list = (xs) => (xs.length <= 1 ? xs.join('') : xs.length === 2 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

// ---------- weekly recap ----------
export function recapFor(commits) {
  const thisWeek = weekStart(Date.now());
  let start = thisWeek, label = 'This week';
  let wk = commits.filter((c) => c.t >= start);
  if (wk.length < 3) { start = thisWeek - 7 * DAY; label = 'Last week'; wk = commits.filter((c) => c.t >= start && c.t < thisWeek); }
  if (!wk.length) return null;
  const isBook = (c) => c.areas.some((a) => /^books?$/i.test(a));
  const books = wk.filter(isBook);
  const feats = wk.filter((c) => c.type === 'feature' && !isBook(c));
  const featNames = [];
  for (const c of feats) { const a = c.areas.find((x) => !/^(project setup|root|assets?)$/i.test(x)); if (a && !featNames.includes(a)) featNames.push(a); }
  const ui = wk.filter((c) => c.type === 'ui' && !isBook(c)).length;
  const fix = wk.filter((c) => c.type === 'fix').length;
  const perf = wk.filter((c) => c.type === 'perf').length;
  const repos = new Set(wk.map((c) => c.repo));
  const parts = [];
  if (featNames.length) parts.push(featNames.length > 3 ? `${featNames.slice(0, 3).join(', ')} and ${featNames.length - 3} more features` : `new work on ${list(featNames.slice(0, 3))}`);
  if (books.length) parts.push(plural(books.length, 'book note update'));
  if (ui) parts.push(plural(ui, 'design tweak'));
  if (perf) parts.push(plural(perf, 'speed-up'));
  if (fix) parts.push(plural(fix, 'fix', 'fixes'));
  const text = parts.length
    ? `${label} you shipped ${list(parts)}${repos.size > 1 ? ` across ${repos.size} repos` : ''}, in ${plural(wk.length, 'commit')}.`
    : `${label} you made ${plural(wk.length, 'commit')}${repos.size > 1 ? ` across ${repos.size} repos` : ''}.`;
  return { label, text };
}

export function recapCard(commits) {
  const r = recapFor(commits);
  if (!r) return '';
  return `<section class="recap">
    <div class="recap-label mono">${esc(r.label)}</div>
    <p class="recap-text">${esc(r.text)}</p>
    <div class="recap-tools"><button class="text-btn bordered" data-recapcopy>${icon('Copy01', 14)}Copy</button></div>
  </section>`;
}

// ---------- notes markdown ----------
export function notesMarkdown(title, commits, withRepo) {
  let md = `## ${title}\n`;
  for (const t of TYPES) {
    const cs = commits.filter((c) => c.type === t);
    if (!cs.length) continue;
    md += `\n### ${NOTES_LABEL[t]}\n`;
    for (const c of cs) md += `- ${c.text || c.subject}${withRepo ? ` (${c.repo})` : ''}\n`;
  }
  return md;
}

// ---------- feature story ----------
export function openStory(name, commits, repo) {
  const sorted = [...commits].sort((a, b) => a.t - b.t);
  const first = sorted[0], last = sorted[sorted.length - 1];
  const add = commits.reduce((s, c) => s + c.add, 0), del = commits.reduce((s, c) => s + c.del, 0);
  const byMonth = new Map();
  for (const c of [...sorted].reverse()) { const k = dMonth.format(new Date(c.t)); if (!byMonth.has(k)) byMonth.set(k, []); byMonth.get(k).push(c); }
  const busiest = [...byMonth.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  const body = `<div class="story">
    <div class="story-stats">
      <div><div class="stat-label">Started</div><div class="mono">${dLong.format(new Date(first.t))}</div></div>
      <div><div class="stat-label">Commits</div><div class="mono">${commits.length}</div></div>
      <div><div class="stat-label">Lines</div><div class="mono"><span class="a">+${compact(add)}</span> <span class="d">−${compact(del)}</span></div></div>
      <div><div class="stat-label">Busiest month</div><div class="mono">${esc(busiest[0])}</div></div>
    </div>
    <div class="story-line">
      ${[...byMonth.entries()].map(([m, cs]) => `<div class="story-month mono">${esc(m)}</div>
        ${cs.map((c) => `<div class="story-item">
          <span class="story-dot" style="--c:var(--t-${c.type})"></span>
          <div class="story-text">${esc(c.text || c.subject)}<div class="mono muted">${dShort.format(new Date(c.t))} · ${TYPE_LABEL[c.type]} · <span class="a">+${compact(c.add)}</span> <span class="d">−${compact(c.del)}</span></div></div>
        </div>`).join('')}`).join('')}
      <div class="story-month mono">Where it began</div>
    </div>
  </div>`;
  const m = modal({
    title: `The story of ${name}`, body, side: true,
    actions: `<span class="mono muted" style="margin-right:auto">${esc(repo)} · last change ${dShort.format(new Date(last.t))}</span><button class="text-btn bordered" data-storycopy>${icon('Copy01', 14)}Copy as notes</button>`,
  });
  m.el.querySelector('[data-storycopy]').onclick = () => copy(notesMarkdown(name, commits, false), 'Story copied');
}

// ---------- releases ----------
function nextVersion(last, unreleased) {
  const m = (last || '').match(/^(v?)(\d+)\.(\d+)\.(\d+)/);
  const hasFeature = unreleased.some((c) => c.type === 'feature');
  if (!m) return 'v0.1.0';
  const [, v, a, b, c] = m;
  return hasFeature ? `${v}${a}.${+b + 1}.0` : `${v}${a}.${b}.${+c + 1}`;
}

export function releaseSections(repo) {
  const sections = [];
  let cur = { name: 'Unreleased', date: null, commits: [] };
  for (const c of repo.commits) {
    if (c.tags.length) { if (cur.commits.length || cur.name !== 'Unreleased') sections.push(cur); cur = { name: c.tags[0], date: c.t, commits: [] }; }
    cur.commits.push(c);
  }
  sections.push(cur);
  return sections;
}

export function releasePanel(repo) {
  const sections = releaseSections(repo);
  const unreleased = sections[0].name === 'Unreleased' ? sections[0].commits : [];
  const last = repo.tags[0]?.name || '';
  return `<section class="rel-panel">
    <div>
      <div class="feat-name">${unreleased.length ? `${unreleased.length} commit${unreleased.length > 1 ? 's' : ''} since ${last ? esc(last) : 'the start'}` : `Everything is in ${esc(last)}`}</div>
      <div class="muted">${last ? `Next version would be ${esc(nextVersion(last, unreleased))}.` : 'Your first release tags the latest commit, so everything so far counts as v0.1.0.'}</div>
    </div>
    <div class="rel-tools">
      <button class="text-btn bordered" data-changelog>${icon('FileExport', 14)}Changelog</button>
      <button class="btn-primary" data-release ${unreleased.length ? '' : 'disabled'}>${icon('Rocket01', 14)}New release</button>
    </div>
  </section>`;
}

export function openRelease(repo, onDone) {
  const sections = releaseSections(repo);
  const unreleased = sections[0].name === 'Unreleased' ? sections[0].commits : [];
  const last = repo.tags[0]?.name || '';
  const version = nextVersion(last, unreleased);
  const notes = notesMarkdown(version, unreleased.slice(0, 300), false).replace(/^## .*\n/, '');
  const m = modal({
    title: 'New release',
    body: `<label class="field"><span>Version</span><input class="mono" data-ver value="${esc(version)}" spellcheck="false" autofocus></label>
      <label class="field"><span>Release notes <em class="muted">from ${unreleased.length} commit${unreleased.length > 1 ? 's' : ''}${last ? ' since ' + esc(last) : ''}</em></span><textarea data-notes rows="12" class="mono">${esc(notes.trim())}</textarea></label>
      <label class="check-row"><input type="checkbox" data-push ${repo.remote ? 'checked' : 'disabled'}> Push the tag to ${esc(hostOf(repo).name)}</label>
      <p class="note" style="margin:0">This tags your latest commit (${esc(repo.commits[0]?.sha.slice(0, 7) || '')}) with an annotated tag. Nothing else changes.</p>`,
    actions: `<button class="text-btn bordered" data-copynotes>${icon('Copy01', 14)}Copy notes</button><button class="btn-primary" data-create>${icon('Rocket01', 14)}Create release</button>`,
  });
  const el = m.el;
  el.querySelector('[data-copynotes]').onclick = () => copy(`## ${el.querySelector('[data-ver]').value}\n\n${el.querySelector('[data-notes]').value}`, 'Notes copied');
  el.querySelector('[data-create]').onclick = async (e) => {
    const btn = e.currentTarget;
    const name = el.querySelector('[data-ver]').value.trim();
    btn.disabled = true; btn.textContent = 'Creating…';
    try {
      await api(`/api/x/tag?repo=${encodeURIComponent(repo.name)}`, { name, notes: `${name}\n\n${el.querySelector('[data-notes]').value}`, push: el.querySelector('[data-push]').checked });
      m.close();
      toast(`Released ${name}`);
      celebrate();
      onDone && onDone();
    } catch (err) {
      btn.disabled = false; btn.innerHTML = `${icon('Rocket01', 14)}Create release`;
      toast(err.message);
    }
  };
}

export function changelogMarkdown(repo) {
  let md = `# Changelog\n\nAll notable changes to ${repo.name}.\n`;
  if (repo.tags.length) {
    for (const s of releaseSections(repo)) {
      if (!s.commits.length) continue;
      md += `\n${notesMarkdown(s.date ? `${s.name} · ${dLong.format(new Date(s.date))}` : s.name, s.commits, false).replace(/^## /, '## ')}`;
    }
  } else {
    const months = new Map();
    for (const c of repo.commits.slice(0, 1500)) { const k = dMonth.format(new Date(c.t)); if (!months.has(k)) months.set(k, []); months.get(k).push(c); }
    for (const [k, cs] of [...months].slice(0, 18)) md += `\n${notesMarkdown(k, cs, false)}`;
  }
  return md;
}

export function openChangelog(repo, onDone) {
  const md = changelogMarkdown(repo);
  const m = modal({
    title: 'Changelog', wide: true,
    body: `<p class="note" style="margin:0 0 10px">${repo.tags.length ? 'Grouped by release.' : 'No tags yet, so this groups by month.'} Writing it creates <code class="mono">CHANGELOG.md</code> in ${esc(repo.name)}; it shows up in the Commit tab for you to review and commit.</p>
      <pre class="md-preview mono scroll-fade">${esc(md.slice(0, 20000))}${md.length > 20000 ? '\n…' : ''}</pre>`,
    actions: `<button class="text-btn bordered" data-copymd>${icon('Copy01', 14)}Copy Markdown</button><button class="btn-primary" data-write>${icon('FileExport', 14)}Write CHANGELOG.md</button>`,
  });
  m.el.querySelector('[data-copymd]').onclick = () => copy(md, 'Changelog copied');
  m.el.querySelector('[data-write]').onclick = async () => {
    try { await api(`/api/x/changelog?repo=${encodeURIComponent(repo.name)}`, { file: 'CHANGELOG.md', markdown: md }); m.close(); toast('Wrote CHANGELOG.md'); onDone && onDone(); }
    catch (err) { toast(err.message); }
  };
}

// A small burst of confetti-like dots when you ship. Quiet, brief, and skipped for reduced motion.
export function celebrate() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const box = document.createElement('div');
  box.className = 'burst';
  const colors = ['var(--t-feature)', 'var(--t-ui)', 'var(--t-fix)', 'var(--t-perf)', 'var(--t-refactor)'];
  for (let i = 0; i < 28; i++) {
    const s = document.createElement('i');
    const a = (Math.PI * 2 * i) / 28 + Math.random() * 0.3;
    const r = 80 + Math.random() * 90;
    s.style.cssText = `--x:${Math.cos(a) * r}px;--y:${Math.sin(a) * r - 40}px;background:${colors[i % colors.length]};animation-delay:${Math.random() * 60}ms`;
    box.appendChild(s);
  }
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 1200);
}
