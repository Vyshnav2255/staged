// staged's web server. Start it with server.mjs, which restarts this file when it changes.
// Zero dependencies. Reads git history only; nothing leaves your machine.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { c, link, card, row, spinner, log, key } from './tui.mjs';
import { commitRoutes } from './commit.mjs';
import { insightRoutes } from './insights.mjs';
import { runRoutes } from './run.mjs';
import { updater } from './updater.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`\n  staged: every change across your git repos, on localhost.\n\n  staged [folder ...]   folders that hold your repos (remembered for next time)\n  --port 4321           port to use (the next free one if taken)\n  --no-open             don't open the browser\n`);
  process.exit(0);
}
const portIdx = args.indexOf('--port');
const PORT = portIdx >= 0 ? Number(args[portIdx + 1]) : Number(process.env.STAGED_PORT) || 4321;
const folderArgs = args.filter((a, i) => !a.startsWith('--') && (portIdx < 0 || i !== portIdx + 1));

// Settings and learned corrections live in your user folder, not in the app or your repos.
const CONFIG_DIR = process.env.STAGED_HOME || (process.platform === 'win32'
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'staged')
  : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'staged'));
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const readConfig = () => { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; } };
const writeConfig = (c) => { try { fs.mkdirSync(CONFIG_DIR, { recursive: true }); fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2)); } catch {} };

const isRepo = (d) => fs.existsSync(path.join(d, '.git'));
// Finds git repos inside a folder, up to three levels down (so ~/code/work/app counts). It doesn't
// look inside a repo, or in hidden, node_modules and vendor folders. Results are kept for a few seconds.
const SKIP = new Set(['node_modules', 'vendor', 'Library', 'Pods', 'dist', 'build']);
const scans = new Map();
function findRepos(root, depth = 3) {
  const hit = scans.get(root);
  if (hit && Date.now() - hit.at < 5000) return hit.dirs;
  const dirs = [];
  const walk = (d, left) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP.has(e.name)) continue;
      const dir = path.join(d, e.name);
      if (isRepo(dir)) dirs.push(dir);
      else if (left > 1) walk(dir, left - 1);
    }
  };
  walk(root, depth);
  dirs.sort((a, b) => a.localeCompare(b));
  scans.set(root, { at: Date.now(), dirs });
  return dirs;
}
const holdsRepos = (d) => findRepos(d).length > 0;
const expand = (p) => path.resolve(p.replace(/^~(?=$|[/\\])/, os.homedir()));

// Where your repos are: folders you pass > STAGED_ROOT > saved folders > a guess.
function findRoots() {
  // Once you've changed folders in Settings, that list wins over everything else.
  if (readConfig().managed) return { roots: (readConfig().roots || []).filter((d) => fs.existsSync(d)), how: 'saved' };
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
let { roots: ROOTS, how: ROOTS_HOW } = findRoots();
if (ROOTS_HOW === 'given' || ROOTS_HOW === 'found') writeConfig({ ...readConfig(), roots: ROOTS });
const tilde = (d) => { const h = os.homedir(); return d === h || d.startsWith(h + path.sep) ? '~' + d.slice(h.length) : d; };
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

// Every repo staged shows: each repo directly inside your folders, plus single repos you added.
// Repos you hid in Settings are left out unless `all` is set.
async function listRepos({ all = false } = {}) {
  const out = [];
  const seen = new Map();
  const cfg = readConfig();
  const hidden = new Set(all ? [] : cfg.hidden || []);
  const add = (dir) => {
    if (hidden.has(dir) || [...seen.values()].includes(dir)) return;
    let name = path.basename(dir);
    if (seen.has(name)) name = `${name} (${path.basename(path.dirname(dir))})`;
    seen.set(name, dir);
    out.push({ name, dir });
  };
  for (const root of ROOTS) {
    if (isRepo(root)) { add(root); continue; }
    for (const dir of findRepos(root)) add(dir);
  }
  for (const dir of cfg.repos || []) if (isRepo(dir)) add(dir);
  return out;
}

// Settings › Repos: the folders staged looks in, single repos, and which ones are hidden.
let lastUngit = null;
function moveDir(from, to) {
  try { fs.renameSync(from, to); }
  catch (e) { if (e.code !== 'EXDEV') throw e; fs.cpSync(from, to, { recursive: true }); fs.rmSync(from, { recursive: true, force: true }); }
}
async function manageRepos(body) {
  const cfg = readConfig();
  cfg.roots = [...ROOTS]; cfg.repos = cfg.repos || []; cfg.hidden = cfg.hidden || [];
  const dir = body.path ? expand(String(body.path).trim()) : '';
  if (body.action === 'add') {
    if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`There's no folder at ${body.path}`);
    if (isRepo(dir)) { if (!cfg.repos.includes(dir) && !cfg.roots.includes(dir)) cfg.repos.push(dir); }
    else {
      // A folder with no repos yet is still worth adding when it has folders in it: they show up
      // under "Not git repos yet", each with a Turn on git button.
      const subs = fs.readdirSync(dir, { withFileTypes: true }).some((e) => e.isDirectory() && !e.name.startsWith('.'));
      if (!holdsRepos(dir) && !subs) throw new Error(`${tilde(dir)} has no folders or git repos in it`);
      if (!cfg.roots.includes(dir)) cfg.roots.push(dir);
    }
    cfg.hidden = cfg.hidden.filter((d) => d !== dir);
  } else if (body.action === 'remove') {
    cfg.roots = cfg.roots.filter((d) => d !== dir);
    cfg.repos = cfg.repos.filter((d) => d !== dir);
  } else if (body.action === 'init') {
    // Turns a plain folder inside one of your folders into a git repo, so staged can show it.
    if (!dir || isRepo(dir) || !ROOTS.some((r) => dir.startsWith(r + path.sep))) throw new Error("staged can only start git in a folder inside your folders");
    await git(dir, ['init']);
  } else if (body.action === 'ungit') {
    // Stops a folder being a git repo by moving its .git folder to the Trash, never deleting it, so
    // the history can come back (Undo in staged, or Put Back from the Trash). The files stay as they are.
    if (!dir || !isRepo(dir) || !fs.existsSync(path.join(dir, '.git'))) throw new Error(`${tilde(dir)} isn't a git repo`);
    if (cfg.roots.includes(dir)) throw new Error('Remove it from your folders first');
    const bin = process.platform === 'darwin' ? path.join(os.homedir(), '.Trash') : path.join(CONFIG_DIR, 'trash');
    fs.mkdirSync(bin, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '.');
    let to = path.join(bin, `${path.basename(dir)} git history (${stamp})`), n = 2;
    while (fs.existsSync(to)) to = path.join(bin, `${path.basename(dir)} git history (${stamp}) ${n++}`);
    moveDir(path.join(dir, '.git'), to);
    fs.writeFileSync(path.join(to, 'FROM.txt'), `This was the git history of ${dir}.\nTo bring it back, rename this folder to .git and move it into that folder.\n`);
    lastUngit = { dir, to };
    log(c.muted('removed git from'), c.bold(path.basename(dir)), c.muted('· history moved to the Trash'));
  } else if (body.action === 'regit') {
    // Undo for the above: puts the .git folder back, as long as nothing has taken its place.
    if (!lastUngit || lastUngit.dir !== dir || !fs.existsSync(lastUngit.to)) throw new Error("That history isn't in the Trash any more");
    if (fs.existsSync(path.join(dir, '.git'))) throw new Error(`${tilde(dir)} is a git repo again already`);
    fs.rmSync(path.join(lastUngit.to, 'FROM.txt'), { force: true });
    moveDir(lastUngit.to, path.join(dir, '.git'));
    lastUngit = null;
  } else if (body.action === 'scan') {
    // Look again from scratch (the scan is otherwise kept for a few seconds).
  } else if (body.action === 'hide') {
    if (!cfg.hidden.includes(dir)) cfg.hidden.push(dir);
  } else if (body.action === 'show') {
    cfg.hidden = cfg.hidden.filter((d) => d !== dir);
  }
  cfg.managed = true;
  writeConfig(cfg);
  scans.clear();
  ROOTS = cfg.roots;
  ROOTS_HOW = 'saved';
  repoCache.clear();
}
// Opens the computer's own folder picker (a web page only ever gets a folder's name, not its path).
function pickFolder(repo) {
  const prompt = repo ? 'Choose a git repo to show in staged' : 'Choose the folder your repos live in';
  const start = ROOTS[0] || os.homedir();
  const run = (cmd, argv) => new Promise((resolve) => execFile(cmd, argv, { timeout: 300000 }, (err, out) => resolve(err ? (err.code === 1 || /cancel/i.test(String(err.message)) ? { cancelled: true } : { error: "Couldn't open the folder picker. Type the path instead." }) : { path: String(out).trim().replace(/\/$/, '') || undefined, cancelled: !String(out).trim() })));
  if (process.platform === 'darwin') {
    const as = `activate
set f to choose folder with prompt ${JSON.stringify(prompt)} default location (POSIX file ${JSON.stringify(start)})
POSIX path of f`;
    return run('osascript', ['-e', as]);
  }
  if (process.platform === 'win32') {
    const ps = `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = '${prompt}'; $d.SelectedPath = '${start.replace(/'/g, "''")}'; if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }`;
    return run('powershell', ['-NoProfile', '-Command', ps]);
  }
  return run('zenity', ['--file-selection', '--directory', `--title=${prompt}`, `--filename=${start}/`]);
}

async function repoList() {
  const cfg = readConfig(), hidden = new Set(cfg.hidden || []);
  return {
    folders: [...ROOTS.map((d) => ({ path: tilde(d), kind: 'folder' })), ...(cfg.repos || []).map((d) => ({ path: tilde(d), kind: 'repo' }))],
    repos: (await listRepos({ all: true })).map((r) => ({ name: r.name, path: tilde(r.dir), hidden: hidden.has(r.dir), logo: !!findLogo(r.dir, r.name) })),
    // Folders right inside your folders that aren't git repos (and hold none), so you can see why they're missing.
    plain: ROOTS.flatMap((root) => { try { return fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name)).map((e) => path.join(root, e.name)).filter((d) => !isRepo(d) && !findRepos(d, 2).length).map((d) => ({ name: path.basename(d), path: tilde(d) })); } catch { return []; } }),
  };
}

async function readRepo(name, dir) {
  let head = '';
  const status = () => git(dir, ['status', '--porcelain']).then((s) => s.split('\n').filter(Boolean).length).catch(() => 0);
  try { head = (await git(dir, ['rev-parse', 'HEAD'])).trim(); } catch {
    // A repo with no commits yet (just after "Turn on git"): show it, so its first commit can be made.
    try { await git(dir, ['rev-parse', '--git-dir']); } catch { return null; }
    const branch = await git(dir, ['symbolic-ref', '--short', 'HEAD']).then((x) => x.trim()).catch(() => 'main');
    return { name, branch, remote: '', provider: '', head: '', commits: [], tags: [], hasWorkflows: false, dirty: await status() };
  }
  const dirty = await status();
  const cached = repoCache.get(name);
  if (cached && cached.head === head) return { ...cached.data, dirty };

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
  // A tag on a merge commit isn't in the log above (it skips merges), so pin it to the newest
  // non-merge commit it contains. That way every tag shows up as a release.
  try {
    const seen = new Set(tags.map((t) => t.name));
    const bySha = new Map(commits.map((c) => [c.sha, c]));
    const refs = (await git(dir, ['for-each-ref', '--format=%(refname:short)', 'refs/tags'])).split('\n').map((x) => x.trim()).filter((x) => x && !seen.has(x));
    for (const t of refs) {
      const sha = (await git(dir, ['rev-list', '-n1', '--no-merges', t + '^{commit}']).catch(() => '')).trim();
      const c = bySha.get(sha);
      if (c && !c.tags.includes(t)) { c.tags.push(t); c.tags.sort((x, y) => y.localeCompare(x, undefined, { numeric: true })); }
    }
    if (refs.length) { tags.length = 0; for (const c of commits) for (const t of c.tags) tags.push({ name: t, sha: c.sha, date: c.date }); }
  } catch {}
  const hasWorkflows = fs.existsSync(path.join(dir, '.github', 'workflows'));
  const web = toWeb(remote);
  const data = { name, branch, remote: web.url, provider: web.provider, head, commits, tags, hasWorkflows };
  repoCache.set(name, { head, data });
  return { ...data, dirty };
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
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

// The picture a project already uses for itself: a logo or app icon in the usual places, else its favicon.
const MIME_IMG = { '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
const logoCache = new Map();
function findLogo(dir, name) {
  const hit = logoCache.get(dir);
  if (hit && Date.now() - hit.at < 300000) return hit.file;
  const slug = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '[-_ ]?');
  const ranks = [
    new RegExp(`^(${slug}[-_ ]?)?(logo|icon|app[-_ ]?icon|mark|logomark)([-_ ]?(mark|icon|square|512|256|192))?\\.(svg|png|webp)$`, 'i'),
    /^favicon\.svg$/i, /^apple-touch-icon(-precomposed)?\.png$/i,
    /^(android-chrome|icon|logo)[-_]?(512|256|192)(x\d+)?\.png$/i, new RegExp(`^${slug}[-_ ]?(512|256|192|128)\\.png$`, 'i'),
    /(logo|icon)[^/]*\.(svg|png|webp)$/i, /^favicon\.(png|ico)$/i,
  ];
  const places = ['', 'public', 'public/brand', 'brand', 'assets', 'assets/brand', 'assets/images', 'assets/img', 'static', 'static/img', 'public/images', 'public/img', 'public/assets', 'images', 'img', 'src/assets', 'app', 'src/app', 'docs', 'docs/assets', '.github', 'resources', 'build', 'src-tauri/icons', 'Images', 'media'];
  let best = null;
  for (const [pi, place] of places.entries()) {
    let names = [];
    try { names = fs.readdirSync(path.join(dir, place), { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name); } catch { continue; }
    for (const n of names) {
      if (!MIME_IMG[path.extname(n).toLowerCase()]) continue;
      const r = ranks.findIndex((re) => re.test(n));
      if (r < 0) continue;
      const score = r * 100 + pi - (/\.svg$/i.test(n) ? 0.5 : 0);
      if (!best || score < best.score) best = { score, file: path.join(dir, place, n) };
    }
  }
  let file = best?.file || null;
  try { if (file && fs.statSync(file).size > 2e6) file = null; } catch { file = null; }
  logoCache.set(dir, { at: Date.now(), file });
  return file;
}

const commits = commitRoutes({
  git,
  makeAreaFn,
  listRepos: async () => listRepos({ all: true }),
  repoDir: async (name) => (await listRepos()).find((r) => r.name === name)?.dir || null,
  onCommitted: (name) => { repoCache.delete(name); log(c.green('✓'), `${c.muted('committed in')} ${c.bold(name)}`); },
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

const runs = runRoutes({
  repoDir: async (name) => (await listRepos()).find((r) => r.name === name)?.dir || null,
  store: path.join(CONFIG_DIR, 'run.json'),
});


const updates = updater({
  dir: HERE,
  git,
  // After an update, hand over to the supervisor (server.mjs) to restart with the new code.
  onUpdated: ({ from, to, changed }) => {
    log(c.lime('★'), `${c.bold(`Updated to ${to}`)} ${c.muted(`from ${from}`)}`);
    setTimeout(() => {
      if (process.send) process.send({ restart: true, self: changed.includes('server.mjs') });
      else broadcast('change', { file: 'index.html' });
    }, 250);
  },
});

// ---------- live reload ----------
// The page keeps one connection open here. When the app's files change it refreshes itself,
// and when the server restarts (new boot id) it reloads too.
const BOOT = String(Date.now());
const listeners = new Set();
const broadcast = (event, data) => { for (const r of listeners) r.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
let changeTimer = null;
// macOS reports events for files that were only read or touched, so reload only when the bytes really change.
const sums = new Map();
const sumOf = (full) => { try { return crypto.createHash('md5').update(fs.readFileSync(full)).digest('hex'); } catch { return null; } };
(function seed(dir) {
  let list = []; try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of list) { const full = path.join(dir, e.name); if (e.isDirectory()) seed(full); else sums.set(full, sumOf(full)); }
})(PUBLIC);
sums.set(path.join(HERE, 'README.md'), sumOf(path.join(HERE, 'README.md')));
const onFileChange = (file, base = PUBLIC) => {
  if (!file || /(^|[/\\])\./.test(file)) return;
  const full = path.join(base, String(file)), sum = sumOf(full);
  if (sums.get(full) === sum) return;
  sums.set(full, sum);
  clearTimeout(changeTimer);
  changeTimer = setTimeout(() => broadcast('change', { file: String(file).replace(/\\/g, '/') }), 120);
};
try { fs.watch(PUBLIC, { recursive: true }, (_, f) => onFileChange(f)); }
catch { try { fs.watch(PUBLIC, (_, f) => onFileChange(f)); } catch {} }
try { fs.watch(path.join(HERE, 'README.md'), () => onFileChange('README.md', HERE)); } catch {}
setInterval(() => { for (const r of listeners) r.write(': keep-alive\n\n'); }, 25000).unref();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  // Only answer to localhost names, so other websites can't reach this server through DNS tricks.
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host || '')) return send(res, 403, 'Forbidden', 'text/plain');
  try {
    const sendJson = (r, code, body) => send(r, code, body, MIME['.json']);
    if (url.pathname === '/api/live') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`retry: 1000\nevent: hello\ndata: ${JSON.stringify(BOOT)}\n\n`);
      listeners.add(res);
      req.on('close', () => listeners.delete(res));
      return;
    }
    if (await updates(req, res, url, sendJson)) return;
    if (await commits(req, res, url, sendJson)) return;
    if (await insights(req, res, url, sendJson)) return;
    if (await runs(req, res, url, sendJson)) return;
    if (url.pathname === '/api/repos/logo') {
      // A repo's own logo or icon, for its tile in Settings. Only for repos staged already lists.
      const want = expand(url.searchParams.get('path') || '');
      const repo = (await listRepos({ all: true })).find((r) => r.dir === want);
      const file = repo && findLogo(repo.dir, repo.name);
      if (!file) return send(res, 404, '', 'text/plain');
      res.writeHead(200, { 'content-type': MIME_IMG[path.extname(file).toLowerCase()], 'cache-control': 'max-age=300', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'", 'x-content-type-options': 'nosniff' });
      return fs.createReadStream(file).pipe(res);
    }
    if (url.pathname === '/api/repos/pick' && req.method === 'POST') {
      if (req.headers['x-changes'] !== '1') return send(res, 403, '{"error":"Forbidden"}', MIME['.json']);
      const body = await new Promise((r) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });
      return send(res, 200, JSON.stringify(await pickFolder(body.kind === 'repo')), MIME['.json']);
    }
    if (url.pathname === '/api/repos/manage') {
      if (req.method === 'POST') {
        if (req.headers['x-changes'] !== '1') return send(res, 403, '{"error":"Forbidden"}', MIME['.json']);
        const body = await new Promise((r) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });
        try { await manageRepos(body); } catch (e) { return send(res, 400, JSON.stringify({ error: e.message }), MIME['.json']); }
      }
      return send(res, 200, JSON.stringify(await repoList()), MIME['.json']);
    }
    if (url.pathname === '/api/repos') {
      const repos = await listRepos();
      const all = (await Promise.all(repos.map((r) => readRepo(r.name, r.dir).catch(() => null)))).filter(Boolean);
      return send(res, 200, JSON.stringify({ root: ROOTS.join(path.delimiter), roots: ROOTS, repos: all }), MIME['.json']);
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
// The card you see when staged starts in a Terminal: where it lives, what it reads, what's waiting.
async function banner(url, where) {
  const none = ROOTS_HOW === 'none';
  const stop = spinner('Reading your repos');
  let repos = [], dirty = 0;
  try {
    repos = await listRepos();
    const st = await Promise.race([
      Promise.all(repos.map((r) => git(r.dir, ['status', '--porcelain']).then((o) => (String(o).trim() ? 1 : 0), () => 0))),
      new Promise((r) => setTimeout(() => r(null), 2500)),
    ]);
    dirty = st ? st.reduce((a, b) => a + b, 0) : 0;
  } catch {}
  stop();
  const lines = [
    `${none ? c.amber('●') : c.green('●')} ${c.bold('staged is running')}`,
    '',
    row('open', link(url)),
    row('reading', `${where}${repos.length ? c.muted(` · ${repos.length} repo${repos.length > 1 ? 's' : ''}`) : ''}`),
  ];
  if (none) lines.push(row('', c.amber('no repos here: run npm start -- ~/your/code')));
  else if (dirty) lines.push(row('waiting', `${c.orange(String(dirty))} ${c.muted(`repo${dirty > 1 ? 's' : ''} with changes to commit`)}`));
  else if (repos.length) lines.push(row('waiting', c.muted('nothing, all committed')));
  console.log('\n' + card(lines));
  console.log(process.env.STAGED_KEYS ? `\n    ${key('o')} ${c.muted('open')}   ${key('r')} ${c.muted('restart')}   ${key('q')} ${c.muted('quit')}   ${c.faint('· edits to staged reload by themselves')}\n` : `\n    ${c.muted('Press')} Ctrl+C ${c.muted('to stop. Edits to staged reload by themselves.')}\n`);
}

server.on('listening', () => {
  const url = `http://localhost:${port}`;
  process.send?.({ port });
  const where = ROOTS.map((r) => r.replace(os.homedir(), '~')).join(', ');
  if (process.env.STAGED_RESTART) { log(c.leaf('↻'), c.muted('restarted with the latest code')); return; }
  if (process.env.STAGED_QUIET_BANNER !== '1') banner(url, where);
  if (!args.includes('--no-open') && !process.env.STAGED_NO_OPEN) {
    const [cmd, cargs] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
    execFile(cmd, cargs, () => {});
  }
});
server.listen(port, '127.0.0.1');
