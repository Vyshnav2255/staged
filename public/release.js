// Releases, changelog and feature stories.
import { icon } from './icons.js';
import { mdView } from './md.js';
import { esc, compact, api, toast, copy, modal, dLong, dShort, dMonth, TYPES, TYPE_LABEL, hostOf } from './ui.js';

const NOTES_LABEL = { feature: 'New', ui: 'Design', fix: 'Fixes', perf: 'Performance', refactor: 'Maintenance', other: 'Other' };

// ---------- notes markdown ----------
function notesMarkdown(title, commits, withRepo) {
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
  const last = sorted[sorted.length - 1];
  const byMonth = new Map();
  for (const c of [...sorted].reverse()) { const k = dMonth.format(new Date(c.t)); if (!byMonth.has(k)) byMonth.set(k, []); byMonth.get(k).push(c); }
  const body = `<div class="story">
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
      <label class="check-row"><input type="checkbox" data-push ${repo.remote ? 'checked' : 'disabled'}> ${repo.provider === 'github' ? 'Publish it on GitHub Releases' : `Push the tag to ${esc(hostOf(repo).name)}`}</label>
      <p class="note" style="margin:0">This tags your latest commit (${esc(repo.commits[0]?.sha.slice(0, 7) || '')}) with an annotated tag${repo.provider === 'github' ? ', then publishes it as a GitHub Release with these notes' : ''}.</p>`,
    actions: `<button class="text-btn bordered" data-copynotes>${icon('Copy01', 14)}Copy notes</button><button class="btn-primary" data-create>${icon('Rocket01', 14)}Create release</button>`,
  });
  const el = m.el;
  el.querySelector('[data-copynotes]').onclick = () => copy(`## ${el.querySelector('[data-ver]').value}\n\n${el.querySelector('[data-notes]').value}`, 'Notes copied');
  el.querySelector('[data-create]').onclick = async (e) => {
    const btn = e.currentTarget;
    const name = el.querySelector('[data-ver]').value.trim();
    btn.disabled = true; btn.textContent = 'Creating…';
    try {
      const r = await api(`/api/x/tag?repo=${encodeURIComponent(repo.name)}`, { name, notes: `${name}\n\n${el.querySelector('[data-notes]').value}`, body: el.querySelector('[data-notes]').value, push: el.querySelector('[data-push]').checked });
      m.close();
      toast(r.published ? `Released ${name} on GitHub` : r.release ? `Tagged ${name}. Hit Publish on GitHub to finish` : `Released ${name}`);
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
      <div class="md-preview scroll-fade">${mdView(md.slice(0, 20000))}</div>`,
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
