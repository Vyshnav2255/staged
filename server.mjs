#!/usr/bin/env node
// staged — a local dashboard for every git repo in a folder.
// Usage: staged [folder ...] [--port 4321] [--no-open]
//   or:  node server.mjs [folder ...]
// Zero dependencies. Reads git history only; nothing leaves your machine.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { commitRoutes } from './commit.mjs';
import { insightRoutes } from './insights.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`\n  staged: every change across your git repos, on localhost.\n\n  staged [folder ...]   folders that hold your repos (remembered for next time)\n  --port 4321           port to use (the next free one if taken)\n  --no-open             don't open the browser\n`);
  process.exit(0);
}
const portIdx = args.indexOf('--port');
const PORT = portIdx >= 0 ? Number(args[portIdx + 1]) : Number(process.env.STAGED_PORT) || 4321;
const folderArgs = args.filter((a, i) => !a.startsWith('--') && i !== portIdx + 1);

// Settings and learned corrections live in your user folder, not in the app or your repos.
const CONFIG_DIR = process.env.STAGED_HOME || (process.platform === 'win32'
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'staged')
  : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'staged'));
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const readConfig = () => { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; } };
const writeConfig = (c) => { try { fs.mkdirSync(CONFIG_DIR, { recursive: true }); fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2)); } catch {} };

const isRepo = (d) => fs.existsSync(path.join(d, '.git'));
const holdsRepos = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).some((e) => e.isDirectory() && !e.name.startsWith('.') && isRepo(path.join(d, e.name))); } catch { return false; } };
const expand = (p) => path.resolve(p.replace(/^~(?=$|[/\\])/, os.homedir()));

// Where your repos are: folders you pass > STAGED_ROOT > saved folders > a guess.
function findRoots() {
  if (folderArgs.length) return { roots: folderArgs.map(expand), how: 'given' };
  if (process.env.STAGED_ROOT) return { roots: process.env.STAGED_ROOT.split(path.delimiter).map(expand), how: 'env' };
  const saved = (readConfig().roots || []).filter((d) => fs.existsSync(d));
  if (saved.length) return { roots: saved, how: 'saved' };
  const home = os.homedir();
  const parent = path.join(HERE, '..');
  const guesses = [
    ...(HERE.includes('node_modules') || HERE.includes('_npx') ? [] : [parent]),
    process.cwd(),
    ...['GitHub', 'Developer', 'Projects', 'projects', 'code', 'Code', 'dev', 'src', 'repos', 'Sites', 'work', 'Documents/GitHub', 'Documents/GitLab'].map((d) => path.join(home, d)),
  ];
  const found = [...new Set(guesses.map((d) => path.resolve(d)))].filter((d) => holdsRepos(d) || (d === path.resolve(process.cwd()) && isRepo(d)));
  return { roots: found.length ? found : [process.cwd()], how: found.length ? 'found' : 'none' };
}
const { roots: ROOTS, how: ROOTS_HOW } = findRoots();
if (ROOTS_HOW === 'given' || ROOTS_HOW === 'found') writeConfig({ ...readConfig(), roots: ROOTS });
const ROOT = ROOTS.join(path.delimiter);
const PUBLIC = path.join(HERE, 'public');

const git = (cwd, argv, max = 512 * 1024 * 1024) =>
  new Promise((resolve, reject) =>
    execFile('git', argv, { cwd, maxBuffer: max, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, out, stderr) => {
      if (err) { err.stderr = stderr; if (stderr) err.message = String(stderr).trim(); return reject(err); }
      resolve(out);
    }));

// ---------- commit types (gitmoji + conventional commits) ----------
const TYPES = [
  ['feature', ['✨', '🎉', '🚀', ':sparkles:', ':tada:', ':rocket:'], /^(feat|feature)(\(.+\))?!?:/i],
  ['ui', ['💄', '💫', '🎨', '🍱', '🚸', '📱', ':lipstick:', ':dizzy:', ':art:', ':bento:', ':iphone:'], /^(style|ui)(\(.+\))?:/i],
  ['fix', ['🐛', '🚑', '🩹', '🚨', '✏️', ':bug:', ':ambulance:', ':adhesive_bandage:', ':pencil2:'], /^(fix|hotfix)(\(.+\))?:/i],
  ['perf', ['⚡', ':zap:'], /^perf(\(.+\))?:/i],
  ['refactor', ['♻️', '🔥', '🚚', '🏗', '⏪', '🗑', '🔧', '🔨', '📦', '⬆️', '⬇️', '➕', '➖', '🙈', ':recycle:', ':fire:', ':truck:', ':wrench:', ':package:'], /^(refactor|chore|build|ci)(\(.+\))?:/i],
];
// Fallback for commits without a gitmoji: guess from the words.
const WORDS = [
  ['fix', /\b(fix(es|ed)?|bug|broken|typo|hotfix|patch)\b/i],
  ['perf', /\b(perf|performance|optimi[sz]e[ds]?|faster|speed up|lazy.?load)\b/i],
  ['refactor', /\b(refactor|clean ?up|remove[ds]?|delete[ds]?|rename[ds]?|bump|upgrade|deps?)\b/i],
  ['ui', /\b(ui|style[ds]?|css|font|colou?rs?|design|layout|spacing|icons?|theme|animation)\b/i],
  ['feature', /^(add(s|ed)?|new|feature|implement(s|ed)?|introduc(e|ed)|support)\b/i],
];
const LEAD = /^\s*(?:(?:\p{Extended_Pictographic}|\p{Emoji_Component})️?‍?)+\s*|^\s*:[a-z0-9_+-]+:\s*/u;

function classify(subject) {
  const s = subject.trim();
  for (const [type, marks, re] of TYPES) {
    if (marks.some((m) => s.startsWith(m))) return { type, mark: marks.find((m) => s.startsWith(m)), text: s.replace(LEAD, '') };
    if (re.test(s)) return { type, mark: '', text: s.replace(re, '').trim() };
  }
  const m = s.match(LEAD);
  const text = s.replace(LEAD, '');
  for (const [type, re] of WORDS) if (re.test(text)) return { type, mark: m ? m[0].trim() : '', text, guessed: true };
  return { type: 'other', mark: m ? m[0].trim() : '', text };
}

// ---------- areas ("features") from touched paths ----------
const GENERIC = new Set(('assets images image img imgs src lib libs js ts css scss sass styles style includes include layouts layout ' +
  'elements element components component svg svgs icons icon fonts font audio video media public static scripts script data app ' +
  'pages page index main utils util helpers dist build vendor base ui content docs doc posts post partials partial views view ' +
  'common shared core modules module packages pkg resources res web site www client frontend').split(' '));
const PROJECT_FILES = /^(\.|_config|package(-lock)?\.json|yarn\.lock|pnpm-lock|gemfile|readme|license|tsconfig|vite\.config|netlify|vercel|cname|robots|sitemap|favicon)/i;

function normalise(seg, isFile) {
  let s = seg.toLowerCase().replace(/^[_.]+/, '');
  if (isFile) s = s.replace(/\.[a-z0-9]+$/i, '').replace(/\.(min|module|test|spec)$/, '');
  if (isFile) s = s.split(/[-_.]/)[0];
  return s.replace(/[-_]+/g, ' ').replace(/\bv?\d+$/, '').trim();
}

function globToRe(g) {
  const re = g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*');
  return new RegExp('^' + re + (g.endsWith('/') ? '.*' : '') + '$', 'i');
}

function makeAreaFn(repoDir) {
  let rules = [];
  let ignore = [];
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(repoDir, '.changes.json'), 'utf8'));
    rules = Object.entries(cfg.areas || {}).map(([name, globs]) => [name, [].concat(globs).map(globToRe)]);
    ignore = [].concat(cfg.ignore || []).map(globToRe);
  } catch {}
  const cache = new Map();
  return (file) => {
    if (cache.has(file)) return cache.get(file);
    let area = null;
    if (ignore.some((r) => r.test(file))) area = '';
    for (const [name, res] of rules) if (area === null && res.some((r) => r.test(file))) area = name;
    if (area === null) {
      const segs = file.split('/');
      if (segs.length === 1 && PROJECT_FILES.test(segs[0])) area = 'Project setup';
      else {
        for (let i = 0; i < segs.length; i++) {
          const n = normalise(segs[i], i === segs.length - 1);
          if (n && !GENERIC.has(n) && n.length > 1) { area = n; break; }
        }
        if (!area) area = normalise(segs[segs.length - 1], true) || normalise(segs[0], false) || 'root';
        area = area.charAt(0).toUpperCase() + area.slice(1);
      }
    }
    cache.set(file, area);
    return area;
  };
}

// ---------- repo reading ----------
const repoCache = new Map(); // name -> { head, data }

async function listRepos() {
  const out = [];
  const seen = new Map();
  const add = (dir) => {
    let name = path.basename(dir);
    if (seen.has(name)) name = `${name} (${path.basename(path.dirname(dir))})`;
    seen.set(name, dir);
    out.push({ name, dir });
  };
  for (const root of ROOTS) {
    if (isRepo(root)) { add(root); continue; }
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const dir = path.join(root, e.name);
      if (path.resolve(dir) === HERE || !isRepo(dir)) continue;
      add(dir);
    }
  }
  return out;
}

async function readRepo(name, dir) {
  let head = '';
  try { head = (await git(dir, ['rev-parse', 'HEAD'])).trim(); } catch { return null; }
  const status = (await git(dir, ['status', '--porcelain']).catch(() => '')).split('\n').filter(Boolean).length;
  const cached = repoCache.get(name);
  if (cached && cached.head === head) return { ...cached.data, dirty: status };

  const [branch, remote, logRaw] = await Promise.all([
    git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).then((s) => s.trim()).catch(() => ''),
    git(dir, ['remote', 'get-url', 'origin']).then((s) => s.trim()).catch(() => ''),
    git(dir, ['log', '--no-merges', '--numstat', '--date=iso-strict', '--format=%x1e%H%x1f%an%x1f%ad%x1f%D%x1f%s']),
  ]);
  const areaOf = makeAreaFn(dir);
  const commits = [];
  const tags = [];
  for (const chunk of logRaw.split('\x1e')) {
    if (!chunk.trim()) continue;
    const nl = chunk.indexOf('\n');
    const header = nl < 0 ? chunk : chunk.slice(0, nl);
    const [sha, author, date, refs, subject = ''] = header.split('\x1f');
    let add = 0, del = 0, files = 0;
    const areaLines = {};
    for (const line of (nl < 0 ? '' : chunk.slice(nl + 1)).split('\n')) {
      const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (!m) continue;
      let file = m[3];
      if (file.includes(' => ')) file = file.replace(/\{([^}]*) => ([^}]*)\}/, '$2').replace(/^.* => /, '');
      const a = m[1] === '-' ? 0 : +m[1], d = m[2] === '-' ? 0 : +m[2];
      add += a; del += d; files++;
      const area = areaOf(file);
      if (area) areaLines[area] = (areaLines[area] || 0) + a + d + 1;
    }
    const areas = Object.entries(areaLines).sort((x, y) => y[1] - x[1]).map(([a]) => a);
    const c = classify(subject);
    const tagNames = (refs || '').split(', ').filter((r) => r.startsWith('tag: ')).map((r) => r.slice(5));
    for (const t of tagNames) tags.push({ name: t, sha, date });
    commits.push({ sha, author, date, subject, type: c.type, guessed: !!c.guessed, mark: c.mark, text: c.text, add, del, files, areas, tags: tagNames });
  }
  const hasWorkflows = fs.existsSync(path.join(dir, '.github', 'workflows'));
  const web = toWeb(remote);
  const data = { name, branch, remote: web.url, provider: web.provider, head, commits, tags, hasWorkflows };
  repoCache.set(name, { head, data });
  return { ...data, dirty: status };
}

// Turn any origin URL (https, ssh, scp-style, ssh host aliases) into a web page and a provider.
function toWeb(remote) {
  if (!remote) return { url: '', provider: '' };
  let host = '', p = '';
  let m;
  if ((m = remote.match(/^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i))) [, host, p] = m;      // https://, ssh://
  else if ((m = remote.match(/^(?:[^@]+@)?([^:/]+):(.+)$/))) [, host, p] = m;                             // git@host:owner/repo
  else return { url: '', provider: '' };
  p = p.replace(/\.git$/, '').replace(/\/$/, '');
  const h = host.toLowerCase();
  const provider = h.includes('gitlab') ? 'gitlab' : h.includes('github') ? 'github' : h.includes('bitbucket') ? 'bitbucket' : 'git';
  // ssh aliases like "github-work" have no dot: map them to the public site
  if (!h.includes('.')) host = provider === 'gitlab' ? 'gitlab.com' : provider === 'bitbucket' ? 'bitbucket.org' : provider === 'github' ? 'github.com' : host;
  return { url: `https://${host}/${p}`, provider };
}

// ---------- http ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

const commits = commitRoutes({
  git,
  makeAreaFn,
  repoDir: async (name) => (await listRepos()).find((r) => r.name === name)?.dir || null,
  onCommitted: (name) => repoCache.delete(name),
  store: (() => {
    const f = path.join(CONFIG_DIR, 'learned.json'), old = path.join(HERE, '.learned.json');
    try { if (!fs.existsSync(f) && fs.existsSync(old)) { fs.mkdirSync(CONFIG_DIR, { recursive: true }); fs.copyFileSync(old, f); } } catch {}
    return f;
  })(),
});
const insights = insightRoutes({
  git,
  listRepos,
  repoDir: async (name) => (await listRepos()).find((r) => r.name === name)?.dir || null,
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  // Only answer to localhost names, so other websites can't reach this server through DNS tricks.
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host || '')) return send(res, 403, 'Forbidden', 'text/plain');
  try {
    const sendJson = (r, code, body) => send(r, code, body, MIME['.json']);
    if (await commits(req, res, url, sendJson)) return;
    if (await insights(req, res, url, sendJson)) return;
    if (url.pathname === '/api/repos') {
      const repos = await listRepos();
      const all = (await Promise.all(repos.map((r) => readRepo(r.name, r.dir).catch(() => null)))).filter(Boolean);
      return send(res, 200, JSON.stringify({ root: ROOT, roots: ROOTS, repos: all }), MIME['.json']);
    }
    if (url.pathname === '/README.md') return send(res, 200, fs.readFileSync(path.join(HERE, 'README.md')), 'text/markdown; charset=utf-8');
    let p = decodeURIComponent(url.pathname);
    if (p === '/') p = '/index.html';
    const file = path.join(PUBLIC, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) return send(res, 404, 'Not found', 'text/plain');
    send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
  } catch (err) {
    send(res, 500, String(err && err.message || err), 'text/plain');
  }
});
const send = (res, code, body, type) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };

// Use the next free port if this one is taken, then open the browser.
let port = PORT;
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && port < PORT + 20) { port++; server.listen(port, '127.0.0.1'); }
  else { console.error(`  Couldn't start: ${err.message}`); process.exit(1); }
});
server.on('listening', () => {
  const url = `http://localhost:${port}`;
  const where = ROOTS.map((r) => r.replace(os.homedir(), '~')).join(', ');
  console.log(`\n  staged is reading ${where}${ROOTS_HOW === 'none' ? ' (no repos found here: run `staged ~/your/code/folder`)' : ''}\n  Open ${url}\n`);
  if (!args.includes('--no-open') && !process.env.STAGED_NO_OPEN) {
    const [cmd, cargs] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
    execFile(cmd, cargs, () => {});
  }
});
server.listen(port, '127.0.0.1');
