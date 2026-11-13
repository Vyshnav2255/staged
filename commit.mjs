// Commit workspace: read uncommitted changes, suggest commit groups and messages,
// and commit a group, a hand-picked set of files, or everything.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';

const MAX_DIFF = 12000;        // chars of diff kept per file for the UI and for Claude
const MAX_PROMPT = 60000;      // chars of diff sent to Claude in one request

// git with env and stdin, for the temporary-index commit
function run(dir, args, { env, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: dir, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim() || `git ${args[0]} failed`))));
    child.stdin.end(input || '');
  });
}

// ---------- hunks ----------
const hid = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 10);
function parseHunks(diff) {
  // returns { header: [...lines before first @@], hunks: [{ id, head, lines }] }
  const lines = diff.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const header = [];
  const hunks = [];
  let cur = null;
  for (const l of lines) {
    if (l.startsWith('@@')) { cur = { head: l, lines: [] }; hunks.push(cur); }
    else if (cur) cur.lines.push(l);
    else header.push(l);
  }
  for (const h of hunks) {
    h.id = hid(h.head.replace(/^@@[^@]*@@/, '') + '\n' + h.lines.join('\n'));
    h.add = h.lines.filter((l) => l.startsWith('+')).length;
    h.del = h.lines.filter((l) => l.startsWith('-')).length;
  }
  return { header, hunks };
}

// ---------- warnings ----------
const SECRET_NAME = /(^|\/)(\.env(\..*)?|.*\.pem|.*\.p12|.*\.key|id_rsa|id_ed25519|credentials(\.json)?|service-account.*\.json|\.npmrc|\.netrc)$/i;
const SECRET_TEXT = [
  [/AKIA[0-9A-Z]{16}/, 'AWS key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/\bsk-(ant-|proj-)?[A-Za-z0-9_-]{20,}/, 'API key'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, 'GitHub token'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/(api[_-]?key|secret|password|token)\s*[:=]\s*["'][^"'\s]{12,}["']/i, 'secret value'],
];
function warningsFor(f) {
  const w = [];
  const bytes = f.bytes || 0;
  if (SECRET_NAME.test(f.path) && f.status !== 'D') w.push({ level: 'high', text: 'looks like a secrets file' });
  const add = (f.diff || '').split('\n').filter((l) => l.startsWith('+')).join('\n');
  for (const [re, name] of SECRET_TEXT) if (re.test(add)) { w.push({ level: 'high', text: `contains what looks like a ${name}` }); break; }
  if (bytes > 5 * 1024 * 1024) w.push({ level: 'high', text: `very large (${(bytes / 1048576).toFixed(1)} MB)` });
  else if (bytes > 1024 * 1024) w.push({ level: 'mid', text: `large (${(bytes / 1048576).toFixed(1)} MB)` });
  if (/\.(m?js|cjs|ts|tsx|jsx|vue|svelte|liquid)$/i.test(f.path)) {
    if (/^\+(?!\s*\/\/).*\bconsole\.(log|debug)\(/m.test(add)) w.push({ level: 'low', text: 'adds console.log' });
    if (/^\+\s*debugger;?\s*$/m.test(add)) w.push({ level: 'mid', text: 'adds debugger' });
  }
  if (/^\+.*(<<<<<<<|>>>>>>>) /m.test(add)) w.push({ level: 'high', text: 'has conflict markers' });
  return w;
}

// ---------- reading changes ----------
function parseStatus(raw) {
  // porcelain v1 -z: "XY path\0" and for renames "XY new\0old\0"
  const out = [];
  const parts = raw.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    const x = p[0], y = p[1], file = p.slice(3);
    let from = null;
    if (x === 'R' || x === 'C') from = parts[++i];
    let status = 'M';
    if (x === '?' && y === '?') status = 'A';
    else if (x === 'A' || y === 'A') status = 'A';
    else if (x === 'D' || y === 'D') status = 'D';
    else if (x === 'R') status = 'R';
    else if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) status = 'U';
    out.push({ path: file, from, status, untracked: x === '?', staged: x !== ' ' && x !== '?' });
  }
  return out;
}

const TEXT_EXT = /\.(md|markdown|html?|liquid|scss|sass|css|less|js|mjs|cjs|jsx|ts|tsx|json|ya?ml|toml|txt|svg|xml|py|rb|go|rs|swift|kt|java|sh|vue|svelte|astro|php|csv|env|gitignore)$/i;

async function readChanges(git, dir, areaOf) {
  const raw = await git(dir, ['status', '--porcelain=v1', '-z', '-uall']);
  const files = parseStatus(raw);
  let hasHead = true;
  try { await git(dir, ['rev-parse', '--verify', 'HEAD']); } catch { hasHead = false; }
  const numstat = hasHead ? await git(dir, ['diff', 'HEAD', '--numstat', '-z', '-M']).catch(() => '') : '';
  const stats = new Map();
  // -z numstat: "add\tdel\tpath\0" or for renames "add\tdel\t\0old\0new\0"
  const np = numstat.split('\0');
  for (let i = 0; i < np.length; i++) {
    const m = np[i].match(/^(\d+|-)\t(\d+|-)\t(.*)$/);
    if (!m) continue;
    let p = m[3];
    if (!p) { i += 2; p = np[i]; }
    stats.set(p, { add: m[1] === '-' ? 0 : +m[1], del: m[2] === '-' ? 0 : +m[2], binary: m[1] === '-' });
  }
  for (const f of files) {
    const s = stats.get(f.path);
    f.area = areaOf(f.path) || 'Project setup';
    if (f.untracked || !hasHead) {
      const full = path.join(dir, f.path);
      let text = '';
      try {
        const st = fs.statSync(full);
        f.bytes = st.size;
        if (st.size < 400000 && (TEXT_EXT.test(f.path) || !path.extname(f.path))) {
          text = fs.readFileSync(full, 'utf8');
          if (text.includes('\u0000')) text = '';
        }
      } catch {}
      f.binary = !text;
      f.add = text ? text.split('\n').length : 0;
      f.del = 0;
      f.diff = text ? text.slice(0, MAX_DIFF).split('\n').map((l) => '+' + l).join('\n') : '';
      f.content = text.slice(0, 4000);
    } else {
      f.add = s?.add || 0; f.del = s?.del || 0; f.binary = !!s?.binary;
      f.diff = '';
    }
  }
  // Diffs for tracked files, one git call per file (only for text, capped).
  await Promise.all(files.filter((f) => !f.untracked && hasHead && !f.binary).map(async (f) => {
    const d = await git(dir, ['diff', 'HEAD', '-M', '--no-color', '-U2', '--', ...(f.from ? [f.from] : []), f.path]).catch(() => '');
    f.diff = d.split('\n').filter((l) => !/^(diff --git|index |--- |\+\+\+ )/.test(l)).join('\n').slice(0, MAX_DIFF);
    if (f.status === 'M' && !f.from) {
      const full = await git(dir, ['diff', 'HEAD', '--no-color', '-U3', '--', f.path]).catch(() => '');
      const { hunks } = parseHunks(full);
      if (hunks.length > 1) f.hunks = hunks.map((h) => ({ id: h.id, head: h.head, add: h.add, del: h.del, lines: h.lines.slice(0, 80) }));
    }
  }));
  for (const f of files) {
    if (f.bytes == null) { try { f.bytes = fs.statSync(path.join(dir, f.path)).size; } catch { f.bytes = 0; } }
    f.warnings = warningsFor(f);
  }
  return files;
}

// ---------- grouping ----------
const NOT_COLLECTIONS = new Set(['includes', 'sass', 'layouts', 'data', 'plugins', 'site', 'drafts_unused', 'config']);
const WEAK_STEMS = new Set(['index', 'main', 'style', 'styles', 'app', 'site', 'base', 'readme', 'package', 'config', 'utils', 'helpers', 'types', 'vyshnav', 'global', 'globals', 'theme', 'variables', 'mixins', 'skill']);

const stemOf = (p) => path.basename(p).toLowerCase().replace(/^[_.]+/, '').replace(/(\.[a-z0-9]+)+$/i, '');

function collectionOf(p) {
  const segs = p.split('/');
  if (segs.length > 1 && segs[0].startsWith('_')) {
    const name = segs[0].slice(1).toLowerCase();
    if (!NOT_COLLECTIONS.has(name)) return name;
  }
  if (segs.length > 2 && /^(images?|img|assets)$/i.test(segs[0])) return segs[1].toLowerCase();
  return null;
}

function addedText(f) {
  return (f.diff || '').split('\n').filter((l) => l.startsWith('+')).join('\n');
}
function introducedHooks(f) {
  // data-* attributes and class names a change introduces: these often wire a file to a new script or style.
  const add = addedText(f);
  const del = (f.diff || '').split('\n').filter((l) => l.startsWith('-')).join('\n');
  const hooks = new Set();
  for (const m of add.matchAll(/\bdata-[a-z][a-z0-9-]{2,}/g)) hooks.add(m[0]);
  for (const m of add.matchAll(/class="([^"]+)"/g)) for (const c of m[1].split(/\s+/)) if (c.length >= 6 && c.includes('-')) hooks.add(c);
  for (const h of [...hooks]) if (del.includes(h)) hooks.delete(h);
  return hooks;
}

function suggestGroups(files, learn = {}) {
  const n = files.length;
  const parent = files.map((_, i) => i);
  const why = files.map(() => new Set());
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const apart = learn.apart || new Set();
  const keyOf = (a, b) => (files[a].path < files[b].path ? files[a].path + '\0' + files[b].path : files[b].path + '\0' + files[a].path);
  const members = (r) => files.map((_, k) => k).filter((k) => find(k) === r);
  const union = (a, b, reason) => {
    const ra = find(a), rb = find(b);
    if (ra === rb) return;
    // never join groups that contain a pair you split apart before
    if (apart.size) for (const x of members(ra)) for (const y of members(rb)) if (apart.has(keyOf(x, y))) return;
    parent[rb] = ra; why[a].add(reason); why[b].add(reason);
  };
  // What you taught it: files you moved together before.
  if (learn.together) for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (learn.together.has(keyOf(i, j))) union(i, j, 'you grouped these before');

  const stems = files.map((f) => stemOf(f.path));
  const coll = files.map((f) => collectionOf(f.path));
  const top = files.map((f) => f.path.split('/')[0]);

  // Hidden tool folders (.agents, .claude, .github …) travel together.
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (top[i].startsWith('.') && top[i] === top[j] && files[i].path.includes('/') && files[j].path.includes('/')) union(i, j, 'same folder');
  }
  // Content collections: _books/* with Images/Books/*
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (coll[i] && coll[i] === coll[j]) union(i, j, 'same collection');
  }
  // Same file stem: delights.js + _delights.scss, pages/tags.html + post/tags.html
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (stems[i].length >= 3 && stems[i] === stems[j] && !WEAK_STEMS.has(stems[i])) union(i, j, 'same name');
  }
  // Connected: a change that imports, includes or hooks into a new file.
  const isNew = files.map((f) => f.status === 'A');
  for (let i = 0; i < n; i++) {
    if (isNew[i] && coll[i]) continue;
    const add = addedText(files[i]);
    if (!add) continue;
    const hooks = isNew[i] ? new Set() : introducedHooks(files[i]);
    for (let j = 0; j < n; j++) {
      if (i === j || !isNew[j] || coll[j]) continue;
      const s = stems[j];
      if (s.length >= 4 && !WEAK_STEMS.has(s) && new RegExp(`(^|[^a-z0-9])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i').test(add)) { union(i, j, 'imports new file'); continue; }
      const body = files[j].content || '';
      for (const h of hooks) if (body.includes(h)) { union(i, j, `uses ${h}`); break; }
    }
  }

  // History: files that usually change together in past commits.
  if (learn.cochange) for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const sc = learn.cochange.get(keyOf(i, j));
    if (sc) union(i, j, 'usually change together');
  }

  const buckets = new Map();
  files.forEach((f, i) => { const r = find(i); if (!buckets.has(r)) buckets.set(r, []); buckets.get(r).push(i); });
  let groups = [...buckets.values()].map((idx) => ({ idx }));

  // Small, unconnected single-file edits become one "small tweaks" commit.
  const small = groups.filter((g) => g.idx.length === 1 && !coll[g.idx[0]] && files[g.idx[0]].status !== 'A' && files[g.idx[0]].add + files[g.idx[0]].del <= 12);
  if (small.length > 1) {
    groups = groups.filter((g) => !small.includes(g));
    groups.push({ idx: small.flatMap((g) => g.idx), tweaks: true });
  }

  return groups.map((g, k) => {
    const fs_ = g.idx.map((i) => files[i]);
    const reasons = new Set(g.idx.flatMap((i) => [...why[i]]));
    const label = g.tweaks ? 'Small tweaks' : labelFor(fs_);
    const msg = messageFor(fs_, label, g.tweaks, learn.verbs, learn.tense);
    return {
      id: 'g' + (k + 1),
      title: label,
      files: fs_.map((f) => f.path),
      why: g.tweaks ? 'small edits that stand alone' : [...reasons].slice(0, 3).join(' · ') || 'one file',
      ...msg,
    };
  }).sort((a, b) => size(b, files) - size(a, files));
}
const size = (g, files) => g.files.reduce((s, p) => { const f = files.find((x) => x.path === p); return s + (f ? f.add + f.del : 0); }, 0);

const titleCase = (s) => s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const COLLECTION_LABEL = { books: 'Book notes', blogs: 'Blog posts', posts: 'Blog posts', microblogs: 'Microblogs', projects: 'Projects', visuals: 'Visuals', works: 'Work', freebies: 'Freebies', resources: 'Resources' };

function labelFor(fs_) {
  const coll = fs_.map((f) => collectionOf(f.path)).find(Boolean);
  if (coll && fs_.every((f) => collectionOf(f.path))) return COLLECTION_LABEL[coll] || titleCase(coll);
  const tops = new Set(fs_.map((f) => f.path.split('/')[0]));
  if (tops.size === 1 && [...tops][0].startsWith('.')) {
    const second = new Set(fs_.map((f) => f.path.split('/').slice(0, 3).join('/')));
    return second.size === 1 ? titleCase(path.basename([...second][0])) : titleCase([...tops][0].slice(1));
  }
  const fresh = fs_.filter((f) => f.status === 'A').map((f) => stemOf(f.path)).filter((s) => !WEAK_STEMS.has(s));
  if (fresh.length) return titleCase(mode(fresh));
  const biggest = [...fs_].sort((a, b) => b.add + b.del - (a.add + a.del))[0];
  return titleCase(stemOf(biggest.path)) || biggest.area;
}
const mode = (arr) => { const c = {}; for (const a of arr) c[a] = (c[a] || 0) + 1; return Object.entries(c).sort((a, b) => b[1] - a[1])[0][0]; };

function titleOf(f) {
  const m = (f.content || '').match(/^title:\s*["']?(.+?)["']?\s*$/m);
  if (m) return m[1];
  const t = f.diff && f.diff.match(/^[+ ]title:\s*["']?(.+?)["']?\s*$/m);
  return t ? t[1] : titleCase(stemOf(f.path));
}
const list = (xs) => (xs.length <= 2 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

// type, scope, conventional subject (imperative), gitmoji subject (past tense, like the user's history)
const EMOJI = { feat: '✨', fix: '🐛', style: '💄', perf: '⚡️', refactor: '♻️', docs: '📝', chore: '🔧', remove: '🔥', content: '📝' };
const TO_IMP = { Added: 'Add', Fixed: 'Fix', Updated: 'Update', Removed: 'Remove', Refined: 'Refine', Polished: 'Polish', Renamed: 'Rename', Moved: 'Move', Improved: 'Improve', Changed: 'Change', Created: 'Create', Deleted: 'Delete', Cleaned: 'Clean', Made: 'Make', Tweaked: 'Tweak', Replaced: 'Replace', Restyled: 'Restyle', Reworked: 'Rework', Wrote: 'Write' };
export const toImperative = (s) => s.replace(/^[A-Z][a-z]+/, (w) => TO_IMP[w] || w).replace(/\b(updated|added|removed|fixed) (\d)/g, (m, w, d) => `${TO_IMP[w[0].toUpperCase() + w.slice(1)].toLowerCase()} ${d}`);

function messageFor(fs_, label, tweaks, verbs, tense) {
  const m = messageForPast(fs_, label, tweaks, verbs);
  if (tense === 'imperative') m.gitmoji = toImperative(m.gitmoji);
  return m;
}

function messageForPast(fs_, label, tweaks, verbs) {
  const collName = fs_.map((f) => collectionOf(f.path)).find(Boolean);
  const top = fs_[0].path.split('/')[0];
  const toolFolder = top.startsWith('.') && fs_.every((f) => f.path.startsWith(top + '/'));
  const scope = toolFolder ? top.slice(1) : collName && fs_.every((f) => collectionOf(f.path)) ? collName : label.toLowerCase().replace(/\s+/g, '-');
  const added = fs_.filter((f) => f.status === 'A');
  const deleted = fs_.filter((f) => f.status === 'D');
  const coll = fs_.every((f) => collectionOf(f.path));
  const ext = new Set(fs_.map((f) => path.extname(f.path).toLowerCase()));
  const onlyStyles = [...ext].every((e) => /\.(s?css|sass|less)$/.test(e));
  let type, conv, gm, emoji;

  if (toolFolder && !tweaks) {
    const kind = /skills?$/.test(fs_[0].path.split('/')[1] || '') ? ' skill' : '';
    type = 'chore'; emoji = EMOJI.chore;
    const name = label.toLowerCase();
    conv = added.length === fs_.length ? `add ${name}${kind}` : `update ${name}${kind}`;
    gm = (added.length === fs_.length ? 'Added ' : 'Updated ') + name + kind;
  } else if (tweaks) {
    const names = [...new Set(fs_.map((f) => titleCase(stemOf(f.path)).toLowerCase()))].slice(0, 3);
    const more = fs_.length > 3 ? ' and more' : '';
    type = onlyStyles || [...ext].every((e) => /\.(s?css|html|liquid|svg)$/.test(e)) ? 'style' : 'chore';
    conv = `polish ${list(names)}${more}`;
    gm = `Polished ${list(names)}${more}`;
  } else if (coll) {
    const mds = fs_.filter((f) => /\.(md|markdown|html)$/i.test(f.path));
    const newDocs = mds.filter((f) => f.status === 'A');
    const what = label === 'Book notes' ? 'notes for' : '';
    if (newDocs.length) {
      const names = newDocs.map(titleOf);
      type = 'feat';
      const subj = names.length > 3 ? `${names.length} ${label.toLowerCase()}` : `${what ? what + ' ' : ''}${list(names)}`;
      conv = `add ${subj}`;
      gm = `Added ${label === 'Book notes' && names.length <= 3 ? 'book notes for ' + list(names) : subj}`;
      const edited = mds.filter((f) => f.status !== 'A');
      if (edited.length) { conv += `, update ${edited.length} more`; gm += `, updated ${edited.length} more`; }
    } else {
      const names = (mds.length ? mds : fs_).map(titleOf);
      type = 'docs';
      emoji = '📝';
      const subj = names.length > 3 ? `${names.length} ${label.toLowerCase()}` : `${what ? what + ' ' : ''}${list(names)}`;
      conv = `update ${subj}`;
      gm = `Updated ${label === 'Book notes' && names.length <= 3 ? 'book notes for ' + list(names) : subj}`;
    }
  } else if (fs_.every((f) => f.status === 'R')) {
    type = 'refactor'; emoji = '🚚';
    conv = `move ${label.toLowerCase()}`; gm = `Moved ${label.toLowerCase()}`;
  } else if (fs_.every((f) => f.status === 'M' && /\.(md|markdown|txt)$/i.test(f.path)) && fs_.reduce((s, f) => s + f.add + f.del, 0) <= 6) {
    type = 'docs'; emoji = '✏️';
    conv = `fix typos in ${label.toLowerCase()}`; gm = `Fixed typos in ${label.toLowerCase()}`;
  } else if (deleted.length === fs_.length) {
    type = 'refactor'; emoji = EMOJI.remove;
    conv = `remove ${label.toLowerCase()}`; gm = `Removed ${label.toLowerCase()}`;
  } else if (added.length) {
    type = 'feat';
    const wired = fs_.length - added.length;
    conv = `add ${label.toLowerCase()}${wired ? ' and wire it into the site' : ''}`;
    gm = `Added ${label.toLowerCase()}${wired ? ` and wired it into ${wired} existing file${wired > 1 ? 's' : ''}` : ''}`;
  } else if (onlyStyles) {
    type = 'style';
    conv = `refine ${label.toLowerCase()} styles`; gm = `Refined ${label.toLowerCase()} styles`;
  } else {
    type = 'refactor';
    conv = `update ${label.toLowerCase()}`; gm = `Updated ${label.toLowerCase()}`;
  }
  emoji = emoji || EMOJI[type];
  // Speak like the repo: swap generic verbs for the one you use most for this kind of change.
  const v = verbs && verbs[emoji];
  if (v && !/^(Updated|Added)$/.test(v) && /^(Updated|Refined|Polished)\b/.test(gm) && v !== gm.split(' ')[0]) gm = gm.replace(/^\w+/, v);
  // Keep first lines under ~72 chars: fall back to counts when names run long.
  if (coll && !tweaks) {
    const newN = fs_.filter((f) => f.status === 'A' && /\.(md|markdown|html)$/i.test(f.path)).length;
    const editN = fs_.filter((f) => f.status !== 'A' && /\.(md|markdown|html)$/i.test(f.path)).length;
    const noun = label.toLowerCase();
    const prefix = `${type}(${scope}): `;
    if (prefix.length + conv.length > 72) conv = newN ? `add ${newN} ${noun}${editN ? `, update ${editN}` : ''}` : `update ${editN} ${noun}`;
    if (gm.length > 68) gm = newN ? `Added ${newN} ${noun}${editN ? `, updated ${editN} more` : ''}` : `Updated ${editN} ${noun}`;
  }
  const body = fs_.length > 1 ? fs_.map((f) => `- ${f.status === 'A' ? 'Add' : f.status === 'D' ? 'Remove' : 'Update'} ${f.path}`).slice(0, 12).join('\n') : '';
  return { type, scope: tweaks ? '' : scope, emoji, conventional: conv, gitmoji: gm, body, source: 'guess' };
}

// ---------- learning from history (no AI) ----------
const learnCache = new Map(); // dir -> { head, commits }
const LEAD_EMOJI = /^\s*((?:\p{Extended_Pictographic}|\p{Emoji_Component})(?:️|‍|\p{Extended_Pictographic})*)\s*([A-Z][a-z]+)/u;

async function historyFor(git, dir) {
  const head = (await git(dir, ['rev-parse', 'HEAD']).catch(() => '')).trim();
  const c = learnCache.get(dir);
  if (c && c.head === head) return c;
  const raw = head ? await git(dir, ['log', '-n', '2000', '--no-merges', '--name-only', '--format=%x1e%s']).catch(() => '') : '';
  const commits = raw.split('\x1e').filter(Boolean).map((chunk) => {
    const [subject, ...files] = chunk.split('\n');
    return { subject, files: files.filter(Boolean) };
  });
  // Verbs you use after each emoji, e.g. 💄 → "Refined"
  const counts = {};
  for (const cm of commits.slice(0, 600)) {
    const m = cm.subject.match(LEAD_EMOJI);
    if (!m || !/ed$/.test(m[2])) continue;
    const e = m[1].replace(/️/g, '');
    (counts[e] ||= {})[m[2]] = ((counts[e] || {})[m[2]] || 0) + 1;
  }
  const verbs = {};
  for (const [e, vs] of Object.entries(counts)) {
    const best = Object.entries(vs).sort((a, b) => b[1] - a[1])[0];
    if (best && best[1] >= 3) { verbs[e] = best[0]; verbs[e + '️'] = best[0]; }
  }
  // Past tense ("Added …") or imperative ("Add …")? Go with whatever this repo mostly uses.
  let past = 0, imp = 0;
  for (const cm of commits.slice(0, 300)) {
    const w = (cm.subject.replace(/^[^A-Za-z]*(?:\w+(?:\([^)]*\))?!?:\s*)?/, '').match(/^[A-Za-z]+/) || [''])[0].toLowerCase();
    if (/^(added|fixed|updated|removed|refined|polished|renamed|moved|improved|changed|created|deleted|cleaned|made|used|bumped|implemented|replaced|tweaked)$/.test(w)) past++;
    else if (/^(add|fix|update|remove|refine|polish|rename|move|improve|change|create|delete|clean|make|use|bump|implement|replace|tweak|refactor)$/.test(w)) imp++;
  }
  const tense = imp > past ? 'imperative' : 'past';
  const out = { head, commits, verbs, tense };
  learnCache.set(dir, out);
  return out;
}

function cochangeFor(commits, paths) {
  const want = new Set(paths);
  const per = new Map(), pair = new Map();
  for (const cm of commits) {
    if (cm.files.length > 30) continue; // big sweeps say little about what belongs together
    const hit = cm.files.filter((f) => want.has(f));
    for (const f of hit) per.set(f, (per.get(f) || 0) + 1);
    for (let i = 0; i < hit.length; i++) for (let j = i + 1; j < hit.length; j++) {
      const k = hit[i] < hit[j] ? hit[i] + '\0' + hit[j] : hit[j] + '\0' + hit[i];
      pair.set(k, (pair.get(k) || 0) + 1);
    }
  }
  const out = new Map();
  for (const [k, c] of pair) {
    const [a, b] = k.split('\0');
    const score = c / Math.min(per.get(a), per.get(b));
    if (c >= 3 && score >= 0.5) out.set(k, score);
  }
  return out;
}

// Corrections you make by moving files, kept outside your repos.
function loadLearned(store) { try { return JSON.parse(fs.readFileSync(store, 'utf8')); } catch { return {}; } }
function saveLearned(store, data) { try { fs.writeFileSync(store, JSON.stringify(data, null, 2)); } catch {} }

// ---------- Claude Code (optional) ----------
let claudePath;
function findClaude() {
  if (claudePath !== undefined) return Promise.resolve(claudePath);
  const cmd = process.env.CHANGES_CLAUDE || 'claude';
  return new Promise((resolve) => {
    execFile('/bin/sh', ['-lc', `command -v ${cmd}`], (err, out) => {
      const p = (out || '').trim();
      claudePath = !err && p ? p : null;
      resolve(claudePath);
    });
  });
}

function claudeOnce(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(claudePath, args, { cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Claude took too long')); }, 180000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error((err || out).trim() || `claude exited with ${code}`));
      resolve(out);
    });
  });
}

async function runClaude(prompt) {
  const model = process.env.CHANGES_CLAUDE_MODEL ?? 'sonnet';
  let out;
  try {
    out = await claudeOnce(['-p', prompt, '--output-format', 'json', ...(model ? ['--model', model] : [])]);
  } catch (e) {
    out = await claudeOnce(['-p', prompt]); // older or restricted CLIs: plain text answer
  }
  let text = out;
  try { const w = JSON.parse(out); if (typeof w.result === 'string') text = w.result; } catch {}
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  try { return JSON.parse(text.slice(a, b + 1)); } catch { throw new Error('Could not read Claude’s answer'); }
}

function diffBlock(files) {
  let budget = MAX_PROMPT;
  return files.map((f) => {
    const head = `### ${f.status} ${f.path}${f.from ? ` (from ${f.from})` : ''}  +${f.add} -${f.del}${f.binary ? ' (binary)' : ''}`;
    const room = Math.max(0, Math.min(f.diff.length, budget, 4000));
    budget -= room;
    return head + (room ? '\n```diff\n' + f.diff.slice(0, room) + '\n```' : '');
  }).join('\n\n');
}

const STYLE_RULES = `Write two subjects for every commit:
- "conventional": Conventional Commits, imperative, lowercase start, no period, <= 72 chars including the "type(scope): " prefix you choose. Types: feat, fix, style, perf, refactor, docs, chore, build, ci, test.
- "gitmoji": the owner's own style, without the emoji (it is added separately): past tense, capitalised, plain words, e.g. "Added design tips feature with dynamic display in avatar interaction". <= 72 chars.
Pick "emoji" from gitmoji (✨ feature, 🐛 fix, 💄 UI/style, ⚡️ performance, ♻️ refactor, 📝 docs/content, 🔥 remove, 🔧 config, 🎉 big milestone, 💫 animation, 🍱 assets, ✏️ typo, 🚚 move/rename).
"body": optional, up to 4 short "- " lines saying what changed and why; empty string if the subject says it all.
Describe what the change does for the site, not file names.`;

async function claudeSuggest(files, recent) {
  const prompt = `You are splitting a developer's uncommitted changes into clean, separate git commits.
Group files that belong to one logical change: one feature with its styles, scripts and the files that hook it in; content additions (e.g. new book notes with their images) on their own; small unrelated tweaks together. A file appears in exactly one group. Prefer a few meaningful commits over many tiny ones.

${STYLE_RULES}

Recent commit subjects in this repo, for tone:
${recent.map((s) => '- ' + s).join('\n')}

Changes:
${diffBlock(files)}

Answer with JSON only:
{"groups":[{"title":"short name of the change","why":"one short phrase on why these files belong together","type":"feat","scope":"books","emoji":"✨","conventional":"feat(books): add notes for …","gitmoji":"Added …","body":"","files":["path", "..."]}]}`;
  const res = await runClaude(prompt);
  const known = new Set(files.map((f) => f.path));
  const seen = new Set();
  const groups = (res.groups || []).map((g, k) => {
    const fl = (g.files || []).filter((p) => known.has(p) && !seen.has(p));
    fl.forEach((p) => seen.add(p));
    return normaliseAi(g, 'c' + (k + 1), fl);
  }).filter((g) => g.files.length);
  const left = files.map((f) => f.path).filter((p) => !seen.has(p));
  if (left.length) groups.push({ id: 'c-rest', title: 'Not grouped', why: 'Claude left these out', files: left, ...messageFor(files.filter((f) => left.includes(f.path)), 'Misc', true) });
  return groups;
}

async function claudeMessage(files, recent) {
  const prompt = `Write a commit message for exactly these changes, as one commit.

${STYLE_RULES}

Recent commit subjects in this repo, for tone:
${recent.map((s) => '- ' + s).join('\n')}

Changes:
${diffBlock(files)}

Answer with JSON only:
{"title":"short name of the change","type":"feat","scope":"","emoji":"✨","conventional":"feat(scope): …","gitmoji":"Added …","body":""}`;
  return normaliseAi(await runClaude(prompt), null, files.map((f) => f.path));
}

function normaliseAi(g, id, files) {
  let conv = String(g.conventional || '').trim();
  let type = g.type || 'chore', scope = g.scope || '';
  const m = conv.match(/^(\w+)(?:\(([^)]*)\))?!?:\s*(.*)$/);
  if (m) { type = m[1]; scope = m[2] || ''; conv = m[3]; }
  const gm = String(g.gitmoji || '').replace(/^(?:\p{Extended_Pictographic}|️|‍|\s)+/u, '').trim();
  return { ...(id ? { id } : {}), title: g.title || 'Change', why: g.why || '', type, scope, emoji: g.emoji || EMOJI[type] || '✨', conventional: conv, gitmoji: gm, body: g.body || '', files, source: 'claude' };
}

// ---------- committing ----------
// Builds the commit in a temporary index, so whatever you staged elsewhere stays exactly as it was,
// and single chunks of a file can be committed while the rest stays in your working copy.
async function commitWithTempIndex(dir, picked, byPath, partial, message) {
  const tmp = path.join(os.tmpdir(), `changes-index-${process.pid}-${Date.now()}`);
  const env = { GIT_INDEX_FILE: tmp };
  let parent = '';
  try { parent = (await run(dir, ['rev-parse', '--verify', 'HEAD'])).trim(); } catch {}
  try {
    await run(dir, parent ? ['read-tree', parent] : ['read-tree', '--empty'], { env });
    const whole = [], parts = [];
    for (const p of picked) (partial[p] && partial[p].length ? parts : whole).push(p);
    const wholePaths = whole.flatMap((p) => [p, ...(byPath.get(p).from ? [byPath.get(p).from] : [])]);
    if (wholePaths.length) await run(dir, ['add', '-A', '--', ...wholePaths], { env });
    for (const p of parts) {
      const diff = await run(dir, ['diff', 'HEAD', '--no-color', '-U3', '--', p]);
      const { header, hunks } = parseHunks(diff);
      const want = new Set(partial[p]);
      const chosen = hunks.filter((h) => want.has(h.id));
      if (chosen.length !== want.size) throw new Error(`${p} changed since you picked its chunks. Refresh and pick again.`);
      const patch = [...header, ...chosen.flatMap((h) => [h.head, ...h.lines])].join('\n') + '\n';
      await run(dir, ['apply', '--cached', '--recount', '-'], { env, input: patch });
    }
    const tree = (await run(dir, ['write-tree'], { env })).trim();
    if (parent) {
      const parentTree = (await run(dir, ['rev-parse', `${parent}^{tree}`])).trim();
      if (parentTree === tree) throw new Error('Nothing to commit in that selection.');
    }
    const sha = (await run(dir, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-F', '-'], { input: message + '\n' })).trim();
    await run(dir, ['update-ref', '-m', `commit: ${message.split('\n')[0]}`, 'HEAD', sha, ...(parent ? [parent] : [])]);
    // Point your real index at the new commit for these paths; the rest of your staging is untouched.
    const allPaths = picked.flatMap((p) => [p, ...(byPath.get(p).from ? [byPath.get(p).from] : [])]);
    await run(dir, ['reset', '-q', '--', ...allPaths]).catch(() => {});
    return sha;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// ---------- routes ----------
export function commitRoutes({ git, makeAreaFn, repoDir, onCommitted, store }) {
  const lastCommitByTool = new Map(); // repo -> sha this tool created most recently

  const readJson = (req) => new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (d) => { b += d; if (b.length > 2e6) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
  });

  async function recentSubjects(dir) {
    return (await git(dir, ['log', '-20', '--no-merges', '--format=%s']).catch(() => '')).split('\n').filter(Boolean);
  }

  return async function handle(req, res, url, send) {
    if (!url.pathname.startsWith('/api/changes')) return false;
    const name = url.searchParams.get('repo') || '';
    const dir = await repoDir(name);
    if (!dir) { send(res, 404, JSON.stringify({ error: 'No such repo' })); return true; }

    // Writes must come from our own page: a custom header forces a CORS preflight that we never approve.
    if (req.method !== 'GET' && req.headers['x-changes'] !== '1') { send(res, 403, JSON.stringify({ error: 'Forbidden' })); return true; }

    const sub = url.pathname.slice('/api/changes'.length) || '/';
    const ok = (obj) => send(res, 200, JSON.stringify(obj));
    const fail = (e, code = 500) => send(res, code, JSON.stringify({ error: String(e && e.message || e) }));

    try {
      if (sub === '/' && req.method === 'GET') {
        const files = await readChanges(git, dir, makeAreaFn(dir));
        const hist = await historyFor(git, dir);
        const learned = loadLearned(store)[name] || {};
        const groups = suggestGroups(files, {
          cochange: cochangeFor(hist.commits, files.map((f) => f.path)),
          together: new Set(learned.together || []),
          apart: new Set(learned.apart || []),
          verbs: hist.verbs, tense: hist.tense,
        });
        const branch = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim();
        return ok({
          repo: name, branch,
          files: files.map(({ content, ...f }) => f),
          groups,
          claude: !!(await findClaude()),
          canUndo: lastCommitByTool.has(name),
          verbs: hist.verbs, tense: hist.tense,
        }), true;
      }
      if (sub === '/suggest' && req.method === 'POST') {
        if (!(await findClaude())) return fail('Claude Code is not installed on this Mac', 400), true;
        const files = await readChanges(git, dir, makeAreaFn(dir));
        return ok({ groups: await claudeSuggest(files, await recentSubjects(dir)) }), true;
      }
      if (sub === '/message' && req.method === 'POST') {
        if (!(await findClaude())) return fail('Claude Code is not installed on this Mac', 400), true;
        const body = await readJson(req);
        const want = new Set(body.files || []);
        const files = (await readChanges(git, dir, makeAreaFn(dir))).filter((f) => want.has(f.path));
        if (!files.length) return fail('Pick at least one file', 400), true;
        return ok(await claudeMessage(files, await recentSubjects(dir))), true;
      }
      if (sub === '/learn' && req.method === 'POST') {
        // { file, from: [paths left behind], to: [paths joined] }
        const body = await readJson(req);
        const all = loadLearned(store);
        const r = (all[name] ||= { together: [], apart: [] });
        const k = (a, b) => (a < b ? a + '\0' + b : b + '\0' + a);
        const tog = new Set(r.together), ap = new Set(r.apart);
        for (const o of body.from || []) { const key = k(body.file, o); ap.add(key); tog.delete(key); }
        for (const o of body.to || []) { const key = k(body.file, o); tog.add(key); ap.delete(key); }
        r.together = [...tog].slice(-2000); r.apart = [...ap].slice(-2000);
        saveLearned(store, all);
        return ok({ saved: true }), true;
      }
      if (sub === '/commit' && req.method === 'POST') {
        const body = await readJson(req);
        const message = String(body.message || '').trim();
        if (!message) return fail('Write a commit message first', 400), true;
        const current = parseStatus(await git(dir, ['status', '--porcelain=v1', '-z', '-uall']));
        const byPath = new Map(current.map((f) => [f.path, f]));
        const partial = body.partial || {}; // { path: [hunk ids] }
        const picked = [...new Set([...(body.files || []), ...Object.keys(partial)])].filter((p) => byPath.has(p));
        if (!picked.length) return fail('Those files have no changes any more. Refresh and try again.', 409), true;
        const sha = await commitWithTempIndex(dir, picked, byPath, partial, message);
        const paths = picked.flatMap((p) => [p, ...(byPath.get(p).from ? [byPath.get(p).from] : [])]);
        lastCommitByTool.set(name, { sha, paths });
        onCommitted && onCommitted(name);
        return ok({ sha, files: picked.length }), true;
      }
      if (sub === '/undo' && req.method === 'POST') {
        const last = lastCommitByTool.get(name);
        const head = (await git(dir, ['rev-parse', 'HEAD'])).trim();
        if (!last || last.sha !== head) return fail('The last commit wasn’t made here, so it’s left alone.', 409), true;
        await git(dir, ['reset', '--soft', 'HEAD~1']);
        await git(dir, ['reset', '-q', '--', ...last.paths]).catch(() => {}); // back to unstaged, as before
        lastCommitByTool.delete(name);
        onCommitted && onCommitted(name);
        return ok({ undone: last.sha }), true;
      }
      return fail('Not found', 404), true;
    } catch (e) {
      return fail(e), true;
    }
  };
}

export { suggestGroups, readChanges, parseStatus };
