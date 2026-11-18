// Commit workspace: read uncommitted changes, suggest commit groups and messages,
// and commit a group, a hand-picked set of files, or everything.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { factsFor, kindOf, isAsset, assetSubject, commonDir, topicOf, thingFor, nameOf, list, aboutOf, contextsOf } from './writer.mjs';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { indexHistory, cochangeFor, buildTermIndex, historyStyle, styleAcrossRepos, repoIdForPath, CONFIDENCE_TARGET } from './feature-index.mjs';

const MAX_DIFF = 12000;        // chars of diff kept per file for the UI

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
  // Ids come from the chunk's lines only: line numbers and the function name git prints after @@ shift
  // when a nearby chunk is committed. Twin chunks get a counter.
  const seen = new Map();
  for (const h of hunks) {
    const base = hid(h.lines.join('\n'));
    const k = seen.get(base) || 0; seen.set(base, k + 1);
    h.id = k ? hid(base + ':' + k) : base;
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
  if (/(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/.test(f.path) && f.status !== 'D') w.push({ level: 'mid', text: 'system file: add it to .gitignore instead' });
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
      if (hunks.length) f.hunks = hunks.map((h) => ({ id: h.id, head: h.head, add: h.add, del: h.del, lines: h.lines.slice(0, 80), all: h.lines }));
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

const GENERIC_EXPORTS = new Set('list words kindof isasset commondir topicof nameof'.split(' '));
function exportsOf(text) {
  const out = new Set();
  const add = (name) => { if (name.length >= 4 && !GENERIC_EXPORTS.has(name.toLowerCase())) out.add(name); };
  for (const m of text.matchAll(/\bexport\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]{3,})/g)) add(m[1]);
  for (const m of text.matchAll(/\bexport\s*\{([^}]+)\}/g)) for (const x of m[1].split(',')) add(x.trim().split(/\s+as\s+/).pop());
  return [...out];
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

// ---------- imports and meaning, for grouping ----------
// Paths a piece of code refers to: ES imports, require, new URL (workers), script and link tags,
// CSS @import and url(). Package names (no ./ or /) are skipped: they aren't files in the repo.
function importsIn(text) {
  const out = [];
  const res = [
    /\bimport\s+(?:[\w*{}\s,$]+?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\b(?:import|require)\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bnew\s+(?:URL|Worker)\(\s*['"]([^'"]+)['"]/g,
    /<(?:script|img|source|link|use)\b[^>]*?\b(?:src|href)=["']([^"'#?]+)/gi,
    /@import\s+(?:url\()?\s*['"]?([^'")\s;]+)/g,
    /url\(\s*['"]?([^'")]+?)['"]?\s*\)/g,
  ];
  for (const re of res) for (const m of text.matchAll(re)) if (/^(\.|\/)/.test(m[1]) || /^[\w-]+\.[a-z]{2,5}$/i.test(m[1])) out.push(m[1]);
  return out;
}
function resolveImport(from, spec, byPath) {
  const base = spec.startsWith('/') ? [spec.slice(1), 'public' + spec, 'src' + spec] : [path.posix.join(path.posix.dirname(from), spec)];
  for (const b of base) for (const ext of ['', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.scss', '/index.js', '/index.ts']) {
    const p = path.posix.normalize(b + ext);
    if (byPath.has(p)) return byPath.get(p);
  }
  return null;
}

// What a change is about, for weighing two changes against each other: the names in the lines it adds
// and removes (identifiers, CSS classes, custom properties, data attributes, routes), the plain words
// inside those names, and the words of its path. `kept` holds names seen in unchanged lines around it.
const COMMON_NAMES = new Set('document window console element elements queryselector queryselectorall getelementbyid addeventlistener removeeventlistener createelement appendchild classlist innerhtml textcontent setattribute getattribute removeattribute preventdefault stoppropagation settimeout cleartimeout setinterval clearinterval requestanimationframe disabled hidden include includes endif endfor assign capture content container wrapper section important transparent inherit initial currentcolor uppercase lowercase pointer relative absolute position display opacity visibility transition transform animation background duration function constructor prototype promise response request headers stringify parsefloat parseint tostring tolowercase touppercase startswith endswith foreach indexof contains children parentnode target currenttarget dataset viewbox xmlns stroke-width stroke-linecap stroke-linejoin fill-rule clip-rule evenodd'.split(' '));
// Names every program uses: the language's and the platform's own, which say nothing about a feature.
const BUILTIN = /^(readFile|writeFile|appendFile|exists|mkdir|readdir|stat|unlink|rm|rename|copyFile)(Sync)?$|^(getFullYear|getMonth|getDate|getDay|getHours|getMinutes|getTime|toISOString|toLocale\w+|toFixed|toUpperCase|toLowerCase|startsWith|endsWith|indexOf|lastIndexOf|forEach|flatMap|findIndex|matchAll|replaceAll|padStart|padEnd|localeCompare|fromEntries|isArray|hasOwnProperty|querySelector(All)?|getElementById|addEventListener|removeEventListener|createElement|appendChild|removeChild|insertBefore|classList|innerHTML|innerText|textContent|setAttribute|getAttribute|removeAttribute|preventDefault|stopPropagation|setTimeout|clearTimeout|setInterval|clearInterval|requestAnimationFrame|getBoundingClientRect|matchMedia|cancelAnimationFrame|IntersectionObserver|ResizeObserver|MutationObserver|scrollIntoView|localStorage|sessionStorage|getItem|setItem|removeItem|backgroundColor|fontSize|fontWeight|innerWidth|innerHeight|clientWidth|clientHeight|offsetWidth|offsetHeight|scrollTop|scrollLeft|parentNode|parentElement|firstChild|lastChild|nextSibling|currentTarget|dataset|JSON|stringify|parseInt|parseFloat|isNaN|encodeURIComponent|decodeURIComponent|statusCode|writeHead|setHeader|content-type|user-agent|utf-8|utf8|no-cache|no-store|DS_Store|node_modules|package-lock|use strict)$/i;
const NOISE = /^(font|background|border|margin|padding|text|line|letter|box|flex|grid|align|justify|transition|animation|transform|max|min|overflow|pointer|white|word|object|outline|user|aria|webkit|moz|inline|stroke|fill|list|place|row|column|scroll|will|backdrop|mix|accent|caret|content|items|self|space|ease|cubic|sans|serif|system|apple|blink|segoe|helvetica|no|pre|not|is|has|first|last|nth|only|focus|hover|active|before|after)-/;
function signalsOf(f) {
  const plus = new Map(), minus = new Map(), kept = new Set(), where = new Set(), shown = new Map();
  const bump = (m, k, w = 1) => m.set(k, (m.get(k) || 0) + w);
  const read = (line, into) => {
    for (const m of line.matchAll(/--[a-z][\w-]{3,}|[A-Za-z_$][\w$]*(?:-[A-Za-z0-9_]+)*/g)) {
      const raw = m[0];
      if (raw.length < 4) continue;
      const low = raw.toLowerCase();
      const parts = raw.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
      // A name: something made of parts (camelCase, kebab-case, snake_case), or one long word.
      const named = parts.length >= 2 && !BUILTIN.test(raw);
      if (named && !NOISE.test(low) && !STOPWORDS.has(low) && !COMMON_NAMES.has(low)) { if (into) { bump(into, 'I:' + low); shown.set('I:' + low, raw); } else kept.add('I:' + low); }
      if (into) for (const w of parts) bump(into, 'W:' + w);
    }
  };
  if (f.status === 'A' && f.content) for (const l of f.content.slice(0, 30000).split('\n')) read(l, plus);
  else for (const l of (f.diff || '').split('\n')) {
    if (l.startsWith('@@')) continue;
    if (l[0] === '+') read(l.slice(1), plus); else if (l[0] === '-') read(l.slice(1), minus); else read(l, null);
  }
  for (const w of f.path.replace(/\.[a-z0-9]+$/i, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/)) if (w.length >= 3 && !STOPWORDS.has(w) && !WEAK_STEMS.has(w) && !/^(public|src|assets|includes|sass|pages|test|tests|lib|js|css|scss|html|data)$/.test(w)) where.add('W:' + w);
  return plus.size || minus.size || where.size ? { plus, minus, kept, where, shown } : null;
}
const MEANING_MIN = 0.16;
// Soft semantic edges below this score are useful hints, but too weak to turn two
// independently reviewable changes into one suggested commit. Explicit imports,
// same-file chunks, learned pairs, collections, and strong history links remain intact.
export const MIN_GROUP_LINK_EVIDENCE = 0.83;
const STOPWORDS = new Set(('the and for with from that this are was were not but you your our its into out over then than when what which while also just only more most some any each all can will would should could has have had been being does did done use used uses using via per new old get set let var const function return import export default async await class extends true false null undefined typeof instanceof try catch finally throw case switch break continue else void yield static public private string number object array value values item items list data file files path name names text type types error errors event events options option result results index length push map filter find join split slice replace trim keys entries json html css div span button input src href class style width height left right top bottom px rem var auto none block flex grid ').split(/\s+/));
function wordsOf(f) {
  const out = new Map();
  const add = (s, w = 1) => {
    for (const t of String(s).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/)) {
      if (t.length < 3 || STOPWORDS.has(t) || /^\d+$/.test(t)) continue;
      out.set(t, (out.get(t) || 0) + w);
    }
  };
  add(f.path.replace(/\.[a-z0-9]+$/i, ''), 3);
  const text = (f.status === 'A' && f.content ? f.content : addedText(f)).slice(0, 30000);
  const head = text.split('\n').slice(0, 15).join('\n').match(/(?:\/\/|\/\*+|#|<!--|\*)\s*[^\n]{8,}/g);
  if (head) for (const h of head) add(h, 2);
  for (const m of text.matchAll(/(?:function\*?\s+|const\s+|let\s+|class\s+|def\s+|export\s+(?:async\s+)?function\s+)([A-Za-z_$][\w$]{2,})/g)) add(m[1]);
  for (const m of text.matchAll(/(?:^|\s)\.([a-z][\w-]{2,})\s*[{,:]/gm)) add(m[1]);
  for (const m of text.matchAll(/(?:\/\/|\/\*|\s#)\s*([A-Za-z][^\n*]{10,})/g)) add(m[1]);
  return out.size ? out : null;
}

function normalise(v) { let s = 0; for (const w of v.values()) s += w * w; s = Math.sqrt(s) || 1; for (const [t, w] of v) v.set(t, w / s); return v; }
function cosine(a, b) { if (a.size > b.size) [a, b] = [b, a]; let s = 0; for (const [t, w] of a) { const o = b.get(t); if (o) s += w * o; } return s; }

function suggestGroups(input, learn = {}) {
  // Chunks, not just files: a modified file with a few separate chunks is split into one unit per chunk,
  // so app.js's glance chunk can go with the glance feature and its settings chunk with settings. Rules
  // that only look at the path (names, folders, history, what you taught it) go through one unit per
  // file, the biggest chunk, its "home"; rules that read the change itself (imports, hooks, words) see
  // every chunk. Chunks that find no feature of their own stay with the home chunk.
  const files = [];
  for (const f of input) {
    const hs = f.hunks;
    const splittable = hs && hs.length >= 2 && hs.length <= 40 && !collectionOf(f.path) && !/\.(md|mdx|txt|json|ya?ml|toml|lock)$/i.test(f.path);
    if (!splittable) { files.push(f); continue; }
    const big = hs.reduce((b, h) => (h.add + h.del > b.add + b.del ? h : b), hs[0]);
    for (const [at, h] of hs.entries()) files.push({ ...f, unitOf: f.path, hunk: h.id, at, home: h === big, units: hs.length, diff: h.head + '\n' + (h.all || h.lines).join('\n'), add: h.add, del: h.del, hunks: undefined });
  }
  const whole = (i) => !files[i].unitOf || files[i].home;
  const n = files.length;
  const parent = files.map((_, i) => i);
  const why = files.map(() => new Set());
  const linkEvidence = [];
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const apart = learn.apart || new Set();
  const keyOf = (a, b) => (files[a].path < files[b].path ? files[a].path + '\0' + files[b].path : files[b].path + '\0' + files[a].path);
  const members = (r) => files.map((_, k) => k).filter((k) => find(k) === r);
  const evidenceWeight = (reason) => reason === 'you grouped these before' ? 0.99
    : reason === 'imports new file' ? 0.97
      : reason.startsWith('uses ') ? 0.94
        : reason === 'includes new file' ? 0.90
          : reason === 'same file' ? 0.90
            : reason === 'usually change together' ? 0.88
              : reason === 'recurring co-change pattern' ? 0.76
                : reason.startsWith('both touch ') ? 0.84
                  : reason === 'share rare changed terms' ? 0.72
                    : reason === 'same collection' ? 0.86
                      : reason === 'same font folder' || reason === 'same kind of asset' || reason === 'app icons' ? 0.84
                        : reason === 'one topic' ? 0.68
                            : reason === 'same name' ? 0.86
                            : reason === 'same folder' ? 0.58
                              : reason === 'notes and docs' ? 0.54
                                : reason === 'wires the new parts in' ? 0.60
                                  : 0.60;
  const union = (a, b, reason, confidence = evidenceWeight(reason)) => {
    const ra = find(a), rb = find(b);
    if (ra === rb) return;
    // never join groups that contain a pair you split apart before
    if (apart.size) for (const x of members(ra)) for (const y of members(rb)) if (apart.has(keyOf(x, y))) return;
    parent[rb] = ra; why[a].add(reason); why[b].add(reason);
    linkEvidence.push({ a, b, confidence, reason });
  };
  // What you taught it: files you moved together before.
  if (learn.together) for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (whole(i) && whole(j) && learn.together.has(keyOf(i, j))) union(i, j, 'you grouped these before');

  const stems = files.map((f) => stemOf(f.path));
  const coll = files.map((f) => collectionOf(f.path));
  const top = files.map((f) => f.path.split('/')[0]);

  // Hidden tool folders (.agents, .claude, .github …) travel together.
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const sameDirectory = path.dirname(files[i].path) === path.dirname(files[j].path);
    if (whole(i) && whole(j) && top[i].startsWith('.') && top[i] === top[j] && sameDirectory && files[i].path.includes('/')) union(i, j, 'same folder');
  }
  // Content collections: _books/* with Images/Books/*
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (coll[i] && coll[i] === coll[j]) union(i, j, 'same collection');
  }
  // New assets of one kind in one folder travel together: a font family, a set of icons. Licences go with their fonts.
  const kinds = files.map((f) => kindOf(f.path));
  const dirOf = (p) => p.split('/').slice(0, -1).join('/');
  const fam = (p) => path.basename(p).split(/[-_ .]/)[0].toLowerCase();
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (!whole(i) || !whole(j) || !isAsset(kinds[i]) || !isAsset(kinds[j]) || coll[i] || coll[j]) continue;
    const sameDir = dirOf(files[i].path) === dirOf(files[j].path);
    const licenceFont = (kinds[i] === 'licence' || kinds[j] === 'licence') && [kinds[i], kinds[j]].some((k) => k === 'font' || k === 'licence');
    if (sameDir && (kinds[i] === kinds[j] || licenceFont) && files[i].status === files[j].status) union(i, j, kinds[i] === 'font' || licenceFont ? 'same font folder' : 'same kind of asset');
    else if (kinds[i] === 'app-icon' && kinds[j] === 'app-icon') union(i, j, 'app icons');
  }
  // A web manifest lists the app icons, so it goes with them.
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if (/(^|\/)(manifest\.webmanifest|site\.webmanifest)$/i.test(files[i].path) && kinds[j] === 'app-icon') { union(i, j, 'app icons'); break; }
  }
  // Same file stem: delights.js + _delights.scss, pages/tags.html + post/tags.html
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (whole(i) && whole(j) && (files[i].status === 'A' || files[j].status === 'A') && stems[i].length >= 3 && stems[i] === stems[j] && !WEAK_STEMS.has(stems[i])) union(i, j, 'same name');
  }
  // One topic in the name: update.js and updater.mjs; server.mjs and
  // app-server.mjs. At least one of the two must be new: a shared word in a
  // new file's name is a strong sign of one feature.
  const words = stems.map((st) => st.split(/[-_.]+/).filter((w) => w.length >= 2 && !WEAK_STEMS.has(w)));
  const sameWord = (a, b) => a === b || (Math.min(a.length, b.length) >= 5 && (a.startsWith(b) || b.startsWith(a)));
  const folders = files.map((f) => f.path.split('/').slice(0, -1));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (!whole(i) || !whole(j)) continue;
    const named = (a, b) => folders[a].length && folders[a].at(-1).toLowerCase() === stems[b] && folders[a].slice(0, -1).join('/') === folders[b].join('/');
    if (named(i, j) || named(j, i)) { union(i, j, 'same name'); continue; }
    if ((files[i].status === 'A' || files[j].status === 'A') && !coll[i] && !coll[j] && !isAsset(kinds[i]) && !isAsset(kinds[j]) && words[i].some((a) => words[j].some((b) => sameWord(a, b)))) union(i, j, 'one topic');
  }
  // Connected: a change that imports, includes or hooks into a new file. Real import statements are
  // resolved to paths (import, require, new URL, <script src>, <link href>, @import, url()), which is
  // exact; for anything else (templates, includes) the new file's name showing up in the change counts.
  // Links are collected first so a hub (app.js, a server, index.html: files that wire up three or more
  // new files) can't chain every feature into one giant commit. A new file joins its importer only when
  // that's the one file using it, and the importer isn't a hub.
  const isNew = files.map((f) => f.status === 'A');
  const prose = (p) => /\.(md|mdx|txt|json|ya?ml|toml)$/i.test(p) || /(^|\/)(readme|changelog|licen[cs]e)/i.test(p);
  const byPath = new Map(files.map((f, i) => [f.path, i]));
  const links = [];
  for (let i = 0; i < n; i++) {
    if ((isNew[i] && coll[i]) || prose(files[i].path)) continue;
    const add = addedText(files[i]);
    if (!add) continue;
    const exact = new Set();
    for (const spec of importsIn(add)) { const j = resolveImport(files[i].path, spec, byPath); if (j != null && j !== i && isNew[j] && !coll[j]) exact.add(j); }
    for (const j of exact) links.push([i, j, 'imports new file']);
    const code = /\.(m?js|cjs|jsx?|tsx?|s?css)$/i.test(files[i].path);
    const hooks = isNew[i] ? new Set() : introducedHooks(files[i]);
    for (let j = 0; j < n; j++) {
      if (i === j || exact.has(j) || !isNew[j] || coll[j]) continue;
      // Outside code, a file counts as used when its full name appears ("hero.html", "logo.svg") or it's
      // pulled in by an include or render tag; a bare word could be anything, like the project's name.
      const s = stems[j], esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const base = path.basename(files[j].path);
      if (!code && s.length >= 3 && (new RegExp(`(^|[^\\w.-])${esc(base)}([^\\w.-]|$)`, 'i').test(add) || new RegExp(`\\{%-?\\s*(include|render|section|partial)\\s+['"]?${esc(s)}\\b`, 'i').test(add))) { links.push([i, j, 'includes new file']); continue; }
      const body = files[j].content || '';
      let hit = null;
      for (const h of hooks) if (body.includes(h)) { hit = h; break; }
      // A chunk that calls what a new file exports (glanceRail()), or styles a class only a new file uses.
      if (!hit && code) hit = exportsOf(body).find((x) => new RegExp(`\\b${esc(x)}\\b`).test(add));
      if (!hit && /\.s?css$/i.test(files[i].path)) hit = [...add.matchAll(/\.([a-z][\w]*-[\w-]{2,})/g)].map((m) => m[1]).find((c) => c.length >= 6 && !/^(is|has|no|js|u|with)-/.test(c) && body.includes(c));
      if (hit) links.push([i, j, `uses ${hit}`]);
    }
  }
  const usedBy = new Array(n).fill(0), uses = new Array(n).fill(0);
  // Users are counted by file, so two chunks of app.js using glance.js count once.
  const seenUse = new Set();
  for (const [i, j] of links) { uses[i]++; const k = files[i].path + '\0' + j; if (!seenUse.has(k)) { seenUse.add(k); usedBy[j]++; } }
  const hub = uses.map((u) => u >= 3);
  // A new file using another new file is one feature (fx.js playing sfx.js), unless the second is shared wider.
  // A chunk is small enough to follow what it wires in, even when a few files share it (the import, the
  // call and the style for one new part).
  for (const [i, j, reason] of links) {
    // A hub should not drag every shared module into one commit, but a uniquely used helper
    // still belongs with the importing change even when that hunk also wires in other features.
    if (usedBy[j] === 1 || (!hub[i] && ((isNew[i] && usedBy[j] <= 2) || (files[i].unitOf && usedBy[j] <= 3)))) union(i, j, reason);
  }

  // Evidence, weighed together. Everything above joins on a hard fact (a new file and the line that
  // imports it). What's left is softer and only counts in sum: the names two changes share (a class
  // styled in one chunk and used in another, a function added here and called there), the words they
  // share, how often the two files were committed together before, and sitting next to each other in one
  // file. Names a change brings in or takes out count double: `.report-dialog` appearing in three chunks
  // for the first time is one feature. Groups merge, most alike first, while they're alike enough.
  let sig = [], oldNames = new Set();
  {
    const T = learn.tune || {};
    sig = files.map((f, i) => (isAsset(kinds[i]) || (coll[i] && isNew[i]) ? null : signalsOf(f)));
    // A name seen in unchanged or removed lines already existed; one only ever added is new.
    const old = new Set(), added = new Set(), gone = new Set();
    oldNames = old;
    for (const s of sig) if (s) { for (const t of s.kept) old.add(t); for (const t of s.plus.keys()) added.add(t); for (const t of s.minus.keys()) gone.add(t); }
    const docs = sig.map((s, i) => {
      if (!s) return null;
      const d = new Map();
      const light = prose(files[i].path) ? 0.5 : 1;
      for (const [t, c] of s.plus) d.set(t, (d.get(t) || 0) + c * light * (t[0] === 'I' ? (old.has(t) || gone.has(t) ? 1 : (T.fresh ?? 2.5)) : (T.word ?? 1)));
      for (const [t, c] of s.minus) d.set(t, (d.get(t) || 0) + c * light * (t[0] === 'I' ? (old.has(t) || added.has(t) ? 0.6 : 1.5) : 0.3));
      for (const t of s.where) d.set(t, (d.get(t) || 0) + (T.where ?? 1.5));
      return d.size ? d : null;
    });
    const semanticIndex = buildTermIndex(docs, files.map((f) => f.path));
    const vecs = semanticIndex.vectors;
    const cap = Math.max(8, Math.ceil(n * (T.cap ?? 0.5)));
    const roots = [...new Set(files.map((_, i) => find(i)))];
    let live = roots.map((r) => members(r)).filter((m) => m.some((i) => vecs[i]));
    const centroid = (m) => normalise(m.filter((i) => vecs[i]).reduce((acc, i) => { for (const [t, w] of vecs[i]) acc.set(t, (acc.get(t) || 0) + w); return acc; }, new Map()));
    let cents = live.map(centroid);
    const blocked = new Set();
    const co = (A, B) => { if (!learn.cochange) return 0; let best = 0; for (const i of A) for (const j of B) if (files[i].path !== files[j].path) { const sc = learn.cochange.get(keyOf(i, j)) || 0; if (sc > best) best = sc; } return best; };
    const near = (A, B) => A.some((i) => files[i].unitOf && B.some((j) => files[j].unitOf === files[i].unitOf && Math.abs(files[i].at - files[j].at) === 1));
    const MIN = T.min ?? 0.1, GROW = T.grow ?? 0.15;
    const bigNew = (m) => m.some((i) => isNew[i] && !isAsset(kinds[i]) && files[i].add >= 10);
    for (;;) {
      let best = 0, a = -1, b = -1, bestSemantic = 0, bestRatio = 1;
      for (let x = 0; x < live.length; x++) for (let y = x + 1; y < live.length; y++) {
        if (live[x].length + live[y].length > cap || blocked.has(live[x][0] + ':' + live[y][0])) continue;
        // A small change that mostly talks about what a big one brings in (the two lines that import and
        // call a new module) scores low on likeness alone, so how much of the smaller one the bigger one
        // covers counts too.
        const [sm, bg] = cents[x].size <= cents[y].size ? [cents[x], cents[y]] : [cents[y], cents[x]];
        let inside = 0; for (const [t, w] of sm) if (t[0] === 'I' && bg.has(t)) inside += w * w;
        const history = co(live[x], live[y]);
        const adjacent = near(live[x], live[y]);
        const freshNames = new Set();
        for (const i of live[x]) for (const t of sig[i]?.plus.keys() || []) if (t[0] === "I" && !oldNames.has(t)) freshNames.add(t);
        const sharedFresh = live[y].some((i) => [...(sig[i]?.plus.keys() || [])].some((t) => freshNames.has(t)));
        const indexedOverlap = semanticIndex.mayOverlap(live[x], live[y]);
        const semantic = indexedOverlap ? cosine(cents[x], cents[y]) : 0;
        // Rare terms from the changed code can link a pair even without a shared identifier.
        // The inverted index filters candidates first; the score threshold keeps generic wording out.
        if (!sharedFresh && history < 0.5 && !adjacent && semantic < (T.semanticMin ?? 0.42)) continue;
        const s = Math.max(semantic, (T.inside ?? 0.3) * inside) + (T.co ?? 0.15) * history + (adjacent ? (T.near ?? 0.04) : 0);
        // The bigger a commit already is, the surer staged has to be to add to it.
        // Two new files are each a thing of their own; likeness in wording alone shouldn't fuse them.
        const need = MIN * (1 + GROW * Math.log2(live[x].length + live[y].length - 1)) * (bigNew(live[x]) && bigNew(live[y]) ? (T.newnew ?? 2) : 1);
        if (s >= need && s - need > best) { best = s - need; a = x; b = y; bestSemantic = semantic; bestRatio = s / Math.max(need, 0.001); }
      }
      if (a < 0) break;
      const shared = [...cents[a].keys()].filter((t) => t[0] === 'I' && cents[b].has(t)).sort((p, q) => cents[a].get(q) * cents[b].get(q) - cents[a].get(p) * cents[b].get(p))[0];
      const nameOfTie = (t) => { for (const i of live[a]) { const v = sig[i]?.shown.get(t); if (v) return v; } return t.slice(2); };
      const historyScore = co(live[a], live[b]);
      const historyReason = historyScore >= 0.8 ? 'usually change together' : historyScore >= 0.5 ? 'recurring co-change pattern' : '';
      const reason = shared ? `both touch ${nameOfTie(shared)}` : historyReason || (bestSemantic >= (T.semanticMin ?? 0.42) ? 'share rare changed terms' : 'related code');
      const ratio = bestRatio;
      const softConfidence = Math.max(0.62, Math.min(0.94, 0.62 + Math.max(0, ratio - 1) * 0.16));
      const evidence = reason === 'usually change together' ? Math.max(softConfidence, 0.68 + historyScore * 0.28)
        : reason === 'recurring co-change pattern' ? Math.max(softConfidence, 0.60 + historyScore * 0.24)
          : reason.startsWith('both touch ') ? Math.max(softConfidence, shared ? 0.82 : 0.62)
            : reason === 'share rare changed terms' ? 0.58 + Math.min(0.36, bestSemantic * 0.42)
              : softConfidence;
      union(live[a][0], live[b][0], reason, evidence);
      if (find(live[a][0]) !== find(live[b][0])) { blocked.add(live[a][0] + ':' + live[b][0]); continue; } // kept apart: you split these before
      live[a] = [...live[a], ...live[b]]; cents[a] = centroid(live[a]);
      live.splice(b, 1); cents.splice(b, 1);
    }
  }
  // Chunks that had no feature signal stay with their file's home chunk.
  const alone = (i) => members(find(i)).length === 1;
  const homeOf = new Map(files.map((f, i) => [f, i]).filter(([f]) => f.unitOf && f.home).map(([f, i]) => [f.unitOf, i]));
  for (let i = 0; i < n; i++) if (files[i].unitOf && !files[i].home && alone(i)) union(homeOf.get(files[i].unitOf), i, 'same file');
  // Do not collect unrelated prose files into a catch-all docs commit. Collections,
  // includes, imports, history and content overlap above can still connect related docs.

  const buckets = new Map();
  files.forEach((f, i) => { const r = find(i); if (!buckets.has(r)) buckets.set(r, []); buckets.get(r).push(i); });
  // The merge process can form a large group through a chain of individually weak
  // semantic links. Keep only components connected by sufficiently strong evidence;
  // this prevents one broad file or common phrase from bridging separate commits.
  const splitWeakBridges = (idx) => {
    const membersInGroup = new Set(idx), localParent = new Map(idx.map((i) => [i, i]));
    const localFind = (i) => { const p = localParent.get(i); if (p === i) return i; const r = localFind(p); localParent.set(i, r); return r; };
    // Hunk-level plans may contain several independently parsed chunks from one file.
    // Keep those together by default; only file-to-file links decide whether the
    // larger commit should split.
    const firstByPath = new Map();
    for (const i of idx) {
      const p = files[i].path;
      if (firstByPath.has(p)) localParent.set(localFind(i), localFind(firstByPath.get(p)));
      else firstByPath.set(p, i);
    }
    for (const edge of linkEvidence) {
      if (edge.confidence < MIN_GROUP_LINK_EVIDENCE || !membersInGroup.has(edge.a) || !membersInGroup.has(edge.b)) continue;
      const a = localFind(edge.a), b = localFind(edge.b);
      if (a !== b) localParent.set(b, a);
    }
    const parts = new Map();
    for (const i of idx) { const root = localFind(i); if (!parts.has(root)) parts.set(root, []); parts.get(root).push(i); }
    return [...parts.values()];
  };
  let groups = [...buckets.values()].flatMap((idx) => splitWeakBridges(idx).map((part) => ({ idx: part })));

  // Leave unrelated small edits separate. They only share a commit when another signal connects them.

  return groups.map((g, k) => {
    const byP = new Map();
    for (const i of g.idx) {
      const f = files[i], c = byP.get(f.path);
      if (!c) byP.set(f.path, { ...f, ids: f.unitOf ? [f.hunk] : null });
      else { c.diff += '\n' + f.diff; c.add += f.add; c.del += f.del; c.ids.push(f.hunk); }
    }
    const fs_ = [...byP.values()];
    const hunks = {};
    for (const f of fs_) if (f.ids && f.ids.length < f.units) hunks[f.path] = f.ids;
    const reasons = new Set(g.idx.flatMap((i) => [...why[i]]));
    // The names this commit's changes share across files (new ones first): what it's about, in the code's own words.
    const seenIn = new Map(), shownAs = new Map();
    const onePath = new Set(g.idx.map((i) => files[i].path)).size === 1;
    for (const i of g.idx) if (sig[i]) for (const t of new Set([...sig[i].plus.keys(), ...sig[i].minus.keys()])) if (t[0] === 'I') { if (!seenIn.has(t)) { seenIn.set(t, new Set()); shownAs.set(t, sig[i].shown.get(t) || t.slice(2)); } seenIn.get(t).add(onePath ? i : files[i].path); }
    const isFresh = (t) => !oldNames.has(t);
    const ties = [...seenIn]
      .filter(([t, ps]) => ps.size >= 2 && (isFresh(t) || /[-_]/.test(t)) && !/^I:(z-index|prefers-|min-|max-|data-theme$)/.test(t))
      .sort((a, b) => (isFresh(b[0]) - isFresh(a[0])) || (b[1].size - a[1].size) || (b[0].length - a[0].length))
      .slice(0, 5).map(([t]) => shownAs.get(t));
    const label = labelFor(fs_);
    const msg = messageFor(fs_, label, false, learn.verbs, learn.tense, learn.emojiForType);
    const distinctPaths = new Set(fs_.map((f) => f.path)).size;
    // Score the weakest edge needed to connect the group. A pile of strong links must not hide
    // one speculative attachment; singleton files have no grouping decision to score.
    const confidence = distinctPaths <= 1 ? 1 : (() => {
      const nodes = new Map([...new Set(fs_.map((f) => f.path))].map((p) => [p, p]));
      const root = (p) => { while (nodes.get(p) !== p) { nodes.set(p, nodes.get(nodes.get(p))); p = nodes.get(p); } return p; };
      const edges = linkEvidence.filter((edge) => g.idx.includes(edge.a) && g.idx.includes(edge.b) && files[edge.a].path !== files[edge.b].path)
        .sort((a, b) => b.confidence - a.confidence);
      let used = 0, weakest = 1;
      for (const edge of edges) {
        const a = files[edge.a].path, b = files[edge.b].path, ra = root(a), rb = root(b);
        if (ra === rb) continue;
        nodes.set(rb, ra); weakest = Math.min(weakest, edge.confidence); used++;
        if (used === distinctPaths - 1) break;
      }
      return used === distinctPaths - 1 ? weakest : 0.52;
    })();
    const review = distinctPaths > 1 && confidence < CONFIDENCE_TARGET;
    // The hubs left on their own, and notes on their own, get a message that says what they are.
    const names = list([...new Set(fs_.map((f) => (/index\.html?$/.test(f.path) ? 'the page' : nameOf(f.path).toLowerCase())))].slice(0, 3)) + (fs_.length > 3 ? ' and more' : '');
    if (g.idx.every((i) => hub[i])) Object.assign(msg, { type: 'feat', emoji: '✨', gitmoji: `Wired the new parts into ${names}`, conventional: `wire the new parts into ${names}` });
    else if (g.idx.length > 1 && g.idx.every((i) => prose(files[i].path))) {
      const verb = g.idx.every((i) => isNew[i]) ? 'Added' : 'Updated';
      Object.assign(msg, { type: 'docs', emoji: '📝', gitmoji: `${verb} ${names}`, conventional: `${verb === 'Added' ? 'add' : 'update'} ${names}` });
    }
    if (learn.tense === 'imperative') msg.gitmoji = toImperative(msg.gitmoji);
    return {
      id: 'g' + (k + 1),
      title: label,
      files: fs_.map((f) => f.path),
      ...(Object.keys(hunks).length ? { hunks } : {}),
      size: fs_.reduce((s, f) => s + f.add + f.del, 0),
      why: ([...reasons].slice(0, 3).join('·') || 'one file') + (review ? '· weak links; check this grouping' : ''),
      confidence,
      review,
      ...(ties.length ? { ties } : {}),
      ...msg,
    };
  }).sort((a, b) => b.size - a.size);
}

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
  const t = topicOf(fs_);
  if (t) return t[0].toUpperCase() + t.slice(1);
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

// type, scope, conventional subject (imperative), gitmoji subject (past tense, like the user's history)
const EMOJI = { feat: '✨', fix: '🐛', style: '💄', perf: '⚡️', refactor: '♻️', docs: '📝', chore: '🔧', build: '⬆️', test: '✅', ci: '👷', remove: '🔥', content: '📝' };
const TO_IMP = { Added: 'Add', Fixed: 'Fix', Updated: 'Update', Removed: 'Remove', Refined: 'Refine', Polished: 'Polish', Renamed: 'Rename', Moved: 'Move', Improved: 'Improve', Changed: 'Change', Created: 'Create', Deleted: 'Delete', Cleaned: 'Clean', Made: 'Make', Tweaked: 'Tweak', Replaced: 'Replace', Restyled: 'Restyle', Reworked: 'Rework', Wrote: 'Write', Increased: 'Increase', Reduced: 'Reduce', Bumped: 'Bump', Tidied: 'Tidy', Simplified: 'Simplify', Wired: 'Wire', Hooked: 'Hook' };
export const toImperative = (s) => s
  .replace(/^[A-Z][a-z]+/, (w) => TO_IMP[w] || w)
  .replace(/(\band |, )([a-z]+ed|wrote|made)\b/g, (m, pre, w) => { const k = w[0].toUpperCase() + w.slice(1); return TO_IMP[k] ? pre + TO_IMP[k].toLowerCase() : m; });

function messageFor(fs_, label, tweaks, verbs, tense, emojiForType) {
  const m = messageForPast(fs_, label, tweaks, verbs, emojiForType);
  if (tense === 'imperative') m.gitmoji = toImperative(m.gitmoji);
  return m;
}

const WEAK_CONTEXTS = new Set(['load', 'render', 'draw', 'handle', 'onclick', 'onchange', 'init', 'update', 'main', 'index', 'constructor', 'anonymous', 'default', 'exports']);
function usefulContexts(f) {
  return [...new Set(contextsOf(f))].filter((name) => !WEAK_CONTEXTS.has(name.toLowerCase())).slice(0, 2);
}
function visibleCopy(f) {
  const added = [], removed = [];
  for (const line of (f.diff || '').split('\n')) {
    if (!/^[+-]/.test(line) || /^(\+\+\+|---)/.test(line)) continue;
    const target = line[0] === '+' ? added : removed, text = line.slice(1);
    const add = (value) => {
      const clean = value.replace(/&(?:amp|lt|gt|quot|#39);/g, ' ').replace(/\s+/g, ' ').trim();
      // Words people read, not code that happens to sit between > and < (a.length > 0 && b < 2).
      if (clean.length >= 4 && clean.length <= 88 && /[A-Za-z]{2}/.test(clean) && !/[=&|(){};$\[\]]|=>|\w\.\w|^--|:\s*['"]/.test(clean) && (clean.match(/[\p{L}\s]/gu) || []).length >= clean.length * 0.75 && (/\s/.test(clean) || /^\p{Lu}/u.test(clean)) && !target.includes(clean)) target.push(clean);
    };
    for (const m of text.matchAll(/>([^<>]{3,88})</g)) add(m[1]);
    for (const m of text.matchAll(/(?:aria-label|placeholder|title|textContent|innerText)\s*=\s*(["'`])([^"'`]{3,88})\1/g)) add(m[2]);
    for (const m of text.matchAll(/(?:toast|confirmDialog|alert)\s*\(\s*(["'`])([^"'`]{3,88})\1/g)) add(m[2]);
  }
  // Text that is only moved or re-wrapped is not a wording change.
  const same = new Set(added.filter((x) => removed.includes(x)));
  added.splice(0, added.length, ...added.filter((x) => !same.has(x)));
  removed.splice(0, removed.length, ...removed.filter((x) => !same.has(x)));
  if (added.length === 1 && removed.length === 1) return `Changed visible wording from “${removed[0]}” to “${added[0]}”`;
  if (added.length) return `Added visible wording: “${added.slice(0, 2).join('”; “')}”`;
  if (removed.length) return `Removed visible wording: “${removed.slice(0, 2).join('”; “')}”`;
  return '';
}

function messageForPast(fs_, label, tweaks, verbs, emojiForType) {
  const collName = fs_.map((f) => collectionOf(f.path)).find(Boolean);
  const top = fs_[0].path.split('/')[0];
  const toolFolder = top.startsWith('.') && fs_.every((f) => f.path.startsWith(top + '/'));
  const scope = toolFolder ? top.slice(1) : collName && fs_.every((f) => collectionOf(f.path)) ? collName : slugOf(label);
  const added = fs_.filter((f) => f.status === 'A');
  const deleted = fs_.filter((f) => f.status === 'D');
  const coll = fs_.every((f) => collectionOf(f.path));
  const kinds = fs_.map((f) => kindOf(f.path));
  const onlyStyles = kinds.every((k) => k === 'style');
  const facts = fs_.flatMap(factsFor).sort((x, y) => y.w - x.w);
  const said = facts.filter((x) => x.verb);
  const intentNotes = facts.filter((x) => x.note).map((x) => x.note).join(' ');
  const fixNote = intentNotes.match(/\b(?:fix(?:es|ed)?|bug|broken|crash|regression|prevent(?:s|ed)?)\b[^.!?;]{0,100}/i)?.[0];
  const perfNote = intentNotes.match(/\b(?:performance|faster|speed(?:up)?|slow(?:er|down)?|optim(?:i|iz)(?:e|ed|ation))\b[^.!?;]{0,100}/i)?.[0];
  const where = WEAK_STEMS.has(label.toLowerCase()) || /^(small tweaks|project setup|misc)$/i.test(label) ? '' : label.toLowerCase();
  const onlyTests = fs_.every((f) => /(^|\/)(?:__tests__|tests?|specs?)\/|(^|\/)(?:test|spec)\.[^.]+$|(?:\.|-)(?:test|spec)\.[^.]+$/i.test(f.path));
  const onlyDocs = !coll && fs_.every((f) => ['doc', 'text'].includes(kindOf(f.path)) || /(^|\/)(readme|changelog|contributing)(\.[^/]+)?$/i.test(f.path));
  const onlyCi = fs_.every((f) => /(^|\/)(\.github\/workflows|\.circleci|\.buildkite)(\/|$)|(^|\/)(Jenkinsfile|\.gitlab-ci\.yml)$/i.test(f.path));
  const onlyIgnoreRules = fs_.every((f) => /(^|\/)\.gitignore$|(^|\/)\.dockerignore$/i.test(f.path));
  const onlyReleaseTooling = fs_.every((f) => /(^|\/)(release|publish|version)(\.[cm]?[jt]s|\.sh)?$/i.test(f.path));
  const onlyTerminalTooling = fs_.every((f) => /(^|\/)(tui|cli|terminal)(\.[cm]?[jt]s)?$/i.test(f.path));
  const dependencyFiles = fs_.every((f) => /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.toml|Cargo\.lock|go\.mod|go\.sum|Gemfile|Gemfile\.lock|requirements[^/]*\.txt|Pipfile|Pipfile\.lock)$/i.test(f.path));
  const dependencyChange = dependencyFiles && fs_.some((f) => /dependencies|devDependencies|optionalDependencies|requirements|\brequire\b|gem\s/i.test(f.diff || ''));
  let type, gm, emoji, conv;
  const asset = assetSubject(fs_);

  if (onlyIgnoreRules) {
    type = 'chore'; emoji = '🙈';
    gm = `${deleted.length === fs_.length ? 'Removed' : added.length === fs_.length ? 'Added' : 'Updated'} ignore rules`;
  } else if (onlyCi) {
    type = 'ci'; emoji = '👷';
    gm = `${deleted.length === fs_.length ? 'Removed' : added.length === fs_.length ? 'Added' : 'Updated'} CI workflow${fs_.length > 1 ? 's' : ''}`;
  } else if (onlyTests) {
    type = 'test'; emoji = '✅';
    const target = /^(test|tests|spec|specs)$/i.test(label) ? 'the change' : label.toLowerCase();
    gm = `${deleted.length === fs_.length ? 'Removed' : added.length === fs_.length ? 'Added' : 'Updated'} tests for ${target}`;
  } else if (onlyReleaseTooling) {
    type = 'chore'; emoji = '🔖';
    gm = `${deleted.length === fs_.length ? 'Removed' : added.length === fs_.length ? 'Added' : 'Updated'} release tooling`;
  } else if (onlyTerminalTooling) {
    type = 'chore'; emoji = '🔧';
    gm = `${deleted.length === fs_.length ? 'Removed' : added.length === fs_.length ? 'Added' : 'Updated'} terminal helpers`;
  } else if (toolFolder && !tweaks) {
    const kind = /skills?$/.test(fs_[0].path.split('/')[1] || '') ? ' skill' : '';
    type = 'chore'; emoji = EMOJI.chore;
    gm = (added.length === fs_.length ? 'Added ' : 'Updated ') + label.toLowerCase() + kind;
  } else if (kinds.every((k) => k === 'junk')) {
    type = 'chore'; emoji = '🙈';
    gm = `${deleted.length === fs_.length ? 'Removed' : 'Added'} ${list([...new Set(fs_.map((f) => path.basename(f.path)))])}`;
  } else if (dependencyChange) {
    type = 'build'; emoji = added.length === fs_.length ? '➕' : deleted.length === fs_.length ? '➖' : '⬆️';
    gm = `${added.length === fs_.length ? 'Added' : deleted.length === fs_.length ? 'Removed' : 'Updated'} dependencies`;
    const names = facts.filter((f) => f.kind === 'config' && f.text?.includes('dependenc')).map((f) => f.text.replace(/ dependenc(?:y|ies)$/, ''));
    if (names.length && gm.length + names[0].length < 58) gm += `: ${names[0]}`;
  } else if (fixNote) {
    type = 'fix'; emoji = /security|vulnerab|permission|credential|secret/i.test(fixNote || '') ? '🔒️' : /crash|data loss|urgent|production/i.test(fixNote || '') ? '🚑️' : '🐛';
    const detail = fixNote?.replace(/^(?:fix(?:es|ed)?|bug|broken|crash|regression|prevent(?:s|ed)?)\s*(?:for|when|that|where|if)?\s*/i, '').trim();
    gm = detail ? `Fixed ${detail}` : `Fixed ${where || label.toLowerCase()} edge cases`;
  } else if (perfNote) {
    type = 'perf'; emoji = '⚡️';
    gm = `Improved ${perfNote}`;
  } else if (onlyDocs) {
    type = 'docs'; emoji = '📝';
    const action = deleted.length === fs_.length ? 'Removed' : added.length === fs_.length ? 'Added' : 'Updated';
    const subject = /^(readme|changelog|contributing|docs?)$/i.test(label) ? 'documentation' : label.toLowerCase();
    gm = `${action} ${subject}`;
  } else if (asset) {
    ({ type, emoji } = asset);
    gm = `${asset.verb} ${asset.what}`;
  } else if (coll && !tweaks) {
    const mds = fs_.filter((f) => /\.(md|markdown|html)$/i.test(f.path));
    const newDocs = mds.filter((f) => f.status === 'A');
    const book = label === 'Book notes';
    if (newDocs.length) {
      const names = newDocs.map(titleOf);
      type = 'feat';
      gm = `Added ${names.length > 3 ? `${names.length} ${label.toLowerCase()}` : book ? 'book notes for ' + list(names) : list(names)}`;
      const edited = mds.filter((f) => f.status !== 'A');
      if (edited.length) gm += `, updated ${edited.length} more`;
    } else {
      const names = (mds.length ? mds : fs_).map(titleOf);
      type = 'docs'; emoji = '📝';
      gm = `Updated ${names.length > 3 ? `${names.length} ${label.toLowerCase()}` : book ? 'book notes for ' + list(names) : list(names)}`;
    }
    if (gm.length > 68) {
      const newN = newDocs.length, editN = mds.length - newN, n = label.toLowerCase();
      gm = newN ? `Added ${newN} ${n}${editN ? `, updated ${editN} more` : ''}` : `Updated ${editN} ${n}`;
    }
  } else if (fs_.every((f) => f.status === 'R')) {
    type = 'refactor'; emoji = '🚚';
    gm = `Moved ${label.toLowerCase()}`;
  } else if (fs_.every((f) => f.status === 'M' && /\.(md|markdown|txt)$/i.test(f.path) && f.add && f.del && Math.abs(f.add - f.del) <= 1) && fs_.reduce((s, f) => s + f.add + f.del, 0) <= 6) {
    type = 'docs'; emoji = '✏️';
    gm = `Fixed typos in ${label.toLowerCase()}`;
  } else if (deleted.length === fs_.length) {
    type = 'refactor'; emoji = EMOJI.remove;
    gm = `Removed ${label.toLowerCase()}`;
  } else if (added.some((f) => !isAsset(kindOf(f.path))) && !tweaks) {
    // Something new: name the thing, not the files it touched.
    type = 'feat';
    const fresh = added.filter((f) => !isAsset(kindOf(f.path))).sort((x, y) => y.add - x.add);
    const many = added.length >= 3 && commonDir(added.map((f) => f.path));
    const thing = many ? label.toLowerCase() : thingFor(fresh[0], fs_);
    const about = many ? null : aboutOf(fresh[0], thing);
    gm = `Added ${about?.subject || thing}`;
    const extra = said.find((x) => x.w >= 6 && !gm.includes(x.text) && !sameFact(gm, x));
    if (extra && gm.length + extra.text.length < 60) gm = joinFact(gm, extra);
  } else if (said.length && said[0].w >= 6) {
    // A clear single change: a font swap, a weight change.
    const f0 = said[0];
    type = f0.kind === 'style' ? 'style' : 'feat';
    gm = `${f0.verb} ${f0.text}${where && f0.kind === 'style' && !/ with /.test(f0.text) ? ` for ${where}` : ''}`;
    const next = said.find((x) => x !== f0 && x.w >= 4 && !sameFact(gm, x));
    if (next && gm.length + next.text.length < 60) gm = joinFact(gm, next);
  } else if (onlyStyles || (kinds.every((k) => ['style', 'markup', 'icon', 'graphic'].includes(k)) && !facts.some((x) => x.kind === 'code'))) {
    type = 'style';
    const topics = [...new Set(facts.flatMap((x) => x.topics || []))].slice(0, 2);
    const adds = said.find((x) => x.verb === 'Added');
    if (tweaks) gm = `Polished ${list([...new Set(fs_.map((f) => nameOf(f.path).toLowerCase()))].slice(0, 3))}${fs_.length > 3 ? ' and more' : ''}`;
    else if (adds && !topics.length) gm = `${adds.verb} ${adds.text}`;
    else {
      const place = where || list([...new Set(fs_.flatMap(usefulContexts))].slice(0, 2));
      gm = `Refined ${topics.length ? list(topics) : 'styles'}${place ? ` ${topics.length ? 'in' : 'for'} ${place}` : ''}`;
    }
  } else if (tweaks) {
    type = 'chore';
    const best = said.find((x) => x.w >= 4);
    const names = [...new Set(fs_.map((f) => nameOf(f.path).toLowerCase()))].slice(0, 3);
    gm = best && fs_.length <= 2 ? `${best.verb} ${best.text}` : `Tidied ${list(names)}${fs_.length > 3 ? ' and more' : ''}`;
  } else {
    // Changes to existing code: say what was added or taken out.
    const add = fs_.reduce((s, f) => s + f.add, 0), del = fs_.reduce((s, f) => s + f.del, 0);
    const best = said.find((x) => x.kind === 'code' || x.kind === 'markup' || x.kind === 'doc' || x.kind === 'config') || said[0];
    // A comment you wrote with the change usually says it best: "Updated app server: restart only when …"
    const note = facts.find((x) => x.note && `Updated ${label}: ${x.note}`.length <= 72 && x.note.split(/\s+/).length >= 4 && !/^(a|an|the|this|that|it)\s/i.test(x.note));
    if (note && (!best || best.w < 6) && fs_.length <= 2) { type = 'feat'; gm = `Updated ${where || label.toLowerCase()}: ${/^[A-Z](?![A-Z])/.test(note.note) ? note.note[0].toLowerCase() + note.note.slice(1) : note.note}`; }
    else if (best && best.verb === 'Added') { type = 'feat'; gm = `Added ${best.text}${where && best.kind === 'code' && !best.text.includes(where) ? ` to ${where}` : ''}`; }
    else if (best && best.verb === 'Removed') { type = 'refactor'; emoji = '🔥'; gm = `Removed ${best.text}${where ? ` from ${where}` : ''}`; }
    else if (best) { type = best.kind === 'doc' ? 'docs' : best.kind === 'config' ? 'chore' : 'feat'; gm = `${best.verb} ${best.text}`; }
    else if (del > add * 2 && del > 20) { type = 'refactor'; gm = `Simplified ${label.toLowerCase()}`; }
    else if (facts.some((x) => x.fixy) && add < 40) { type = 'fix'; gm = `Fixed ${label.toLowerCase()} edge cases`; }
    else {
      type = kinds.every((k) => k === 'doc' || k === 'text') ? 'docs' : 'feat';
      const ctx = [...new Set(fs_.flatMap(usefulContexts))].filter((c) => c !== label.toLowerCase()).slice(0, 2);
      gm = ctx.length ? `Updated ${list(ctx)}${where && fs_.length === 1 ? ` in ${where}` : ''}` : `Updated ${label.toLowerCase()}`;
    }
    const next = said.find((x) => x !== best && x.w >= 4 && !gm.includes(x.text) && !sameFact(gm, x));
    if (next && gm.length + next.text.length < 58) gm = joinFact(gm, next);
  }
  const fallbackEmoji = EMOJI[type];
  emoji = emojiForType?.[type] && (!emoji || emoji === fallbackEmoji) ? emojiForType[type] : emoji || fallbackEmoji;
  const emojiSuggestions = recommendEmojis({ type, emoji, files: fs_, facts, subject: gm, emojiForType });
  emoji = emojiSuggestions[0] || emoji;
  // Apply the repository's preferred verb after context selects the emoji.
  const v = verbs && verbs[emoji];
  if (v && !/^(Updated|Added)$/.test(v) && /^(Updated|Refined|Polished)\b/.test(gm) && v !== gm.split(' ')[0]) gm = gm.replace(/^\w+/, v);
  gm = gm.replace(/\s+/g, ' ').trim();
  if (gm.length > 72) gm = gm.slice(0, 71).replace(/\s+\S*$/, '') + '…';
  conv = toImperative(gm).replace(/^\w/, (c) => c.toLowerCase());
  return { type, scope: tweaks ? '' : scope, emoji, emojiSuggestions, conventional: conv, gitmoji: gm, body: bodyFor(fs_, facts, gm), source: 'guess' };
}

// Rank a short, context-aware set. The chosen emoji leads; concrete change evidence
// comes next, then repository style and the familiar category defaults.
function recommendEmojis({ type, emoji, files, facts, subject, emojiForType }) {
  const text = [subject, ...facts.filter((f) => f.w >= 4).flatMap((f) => [f.text, ...(f.topics || [])])]
    .filter(Boolean).join(' ').toLowerCase();
  const ranked = new Map();
  const add = (value, score) => ranked.set(value, Math.max(ranked.get(value) || 0, score));
  const learned = emojiForType?.[type];
  if (learned) add(learned, 95);
  if (emoji) add(emoji, 100);
  const defaults = { feat: ['✨', '🚸', '🎉'], fix: ['🐛', '🩹', '🚑️'], style: ['💄', '💫', '📱'], perf: ['⚡️'], refactor: ['♻️', '🚚', '🔥'], docs: ['📝', '💬', '💡'], chore: ['🔧', '🍱', '🙈'], build: ['📦️', '⬆️', '➕', '➖'], test: ['✅', '🧪'], ci: ['👷', '💚'] };
  for (const [i, value] of (defaults[type] || ['✨']).entries()) add(value, 40 - i);
  const cues = [
    [/accessib|keyboard|screen reader|usability|navigation/i, '🚸', ['feat']],
    [/validat|invalid input|input check/i, '🦺', ['feat', 'fix']],
    [/analytic|telemetry|tracking|metrics/i, '📈', ['feat']],
    [/easter egg|hidden feature|surprise/i, '🥚', ['feat']],
    [/concurren|parallel|thread(?:ing)?/i, '🧵', ['feat', 'perf', 'refactor']],
    [/security|vulnerab|permission|credential|secret/i, '🔒️', ['fix']],
    [/crash|urgent|production hotfix/i, '🚑️', ['fix']],
    [/typo|spelling/i, '✏️', ['docs', 'fix']],
    [/animation|transition|motion/i, '💫', ['style', 'feat']],
    [/responsive|mobile|viewport/i, '📱', ['style', 'feat']],
    [/format|prettier|indentation/i, '🎨', ['style', 'refactor']],
    [/performance|faster|speed|optim(?:i|iz)/i, '⚡️', ['perf']],
    [/dead code|unused|remove code/i, '⚰️', ['refactor']],
    [/rename|renamed|move file|moved file/i, '🚚', ['refactor']],
    [/architecture|module boundary|server split/i, '🏗️', ['refactor', 'chore']],
    [/dependency|package|lockfile/i, '📦️', ['build']],
    [/database|schema|migration/i, '🗃️', ['build', 'chore', 'feat']],
    [/sound|audio|chime/i, '🔊', ['feat']],
    [/workflow|pipeline|continuous integration/i, '👷', ['ci']],
    [/deploy|release|publish/i, '🚀', ['chore']],
    [/font|icon|image|asset|brand/i, '🍱', ['chore', 'style']],
    [/comment|explanation/i, '💡', ['docs']],
    [/copy|wording|text/i, '💬', ['docs', 'feat']],
  ];
  for (const [re, value, types] of cues) if (types.includes(type) && re.test(text)) add(value, 120);
  return [...ranked].sort((a, b) => b[1] - a[1]).map(([value]) => value).slice(0, 6);
}

// "Added sky view" + Added "Akt font" -> "Added sky view and Akt font"
const sameFact = (gm, x) => { const a = x.text.toLowerCase().split(/\s+/).slice(0, 3).join(' '); return gm.toLowerCase().includes(a); };
const joinFact = (gm, x) => gm.split(' ')[0] === x.verb ? `${gm} and ${x.text}` : `${gm} and ${x.verb.toLowerCase()} ${x.text}`;
const slugOf = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Body: what changed, in words, one line each. Files only where nothing better can be said.
function bodyFor(fs_, facts, subject) {
  facts = [...facts];
  const contextFor = usefulContexts;
  const hasDetail = facts.some((x) => x.kind === 'code' && x.verb && x.w >= 4 || x.topics?.length && x.w >= 3)
    || fs_.some((f) => contextFor(f).length || visibleCopy(f));
  if (fs_.length < 2 && facts.filter((x) => x.verb).length < 2 && !hasDetail) return '';
  const out = [];
  const covered = new Set();
  const seen = new Set([subject.toLowerCase()]);
  const push = (line, file) => {
    const k = line.toLowerCase(), core = k.replace(/^- /, '').replace(/ \([^)]*\)$/, '');
    if (seen.has(k) || [...seen].some((x) => x.includes(core))) return;
    seen.add(k); out.push(line); if (file) covered.add(file);
  };
  for (const x of facts) {
    if (x.note) {
      // Source comments explain implementation choices; commit bodies should describe effects.
      continue;
    } else if (x.kind === 'code' && x.verb && x.w >= 4) {
      const f = fs_.find((item) => item.path === x.file), context = f && contextFor(f);
      push(`- ${x.verb} ${x.text}${context?.length ? ` in ${list(context)}` : ''}`, x.file);
    } else if (x.verb && x.w >= 4) push(`- ${x.verb} ${x.text}`, x.file);
    else if (x.topics?.length && x.w >= 3) {
      const f = fs_.find((item) => item.path === x.file), context = f && contextFor(f);
      push(`- Refined ${list(x.topics.slice(0, 3))}${context?.length ? ` in ${list(context)}` : ''}`, x.file);
    }
  }
  for (const f of fs_) if (!covered.has(f.path)) {
    const copy = visibleCopy(f);
    if (copy) push(`- ${copy}`, f.path);
  }
  const hasCode = fs_.some((f) => kindOf(f.path) === 'script' || kindOf(f.path) === 'markup');
  if (hasCode) for (let i = out.length - 1; i >= 0; i--) {
    const source = facts.find((x) => x.kind === 'doc' && out[i].toLowerCase().includes(String(x.text || '').toLowerCase()));
    if (source) out.splice(i, 1);
  }
  const assets = fs_.filter((f) => isAsset(kindOf(f.path)));
  if (assets.length > 1 && assets.length < fs_.length) { const a = assetSubject(assets); if (a) push(`- ${a.verb} ${a.what}`); }
  for (const f of fs_) {
    if (covered.has(f.path) || isAsset(kindOf(f.path)) && assets.length > 1) continue;
    if (f.status === 'A' && WEAK_STEMS.has(stemOf(f.path).toLowerCase())) continue;
    if (f.status === 'M' && !(collectionOf(f.path) && /\.(md|markdown|html)$/i.test(f.path))) continue; // "Updated index.html" adds nothing
    const context = contextFor(f);
    if (context.length) {
      const verb = f.status === 'A' ? 'Added' : f.status === 'D' ? 'Removed' : 'Updated';
      push(`- ${verb} ${list(context)} in ${nameOf(f.path).toLowerCase()}`, f.path);
      continue;
    }
    const what = collectionOf(f.path) && /\.(md|markdown|html)$/i.test(f.path) ? titleOf(f) : f.status === 'A' ? thingFor(f, fs_) : nameOf(f.path).toLowerCase();
    push(`- ${f.status === 'A' ? 'Added' : f.status === 'D' ? 'Removed' : 'Updated'} ${what}`, f.path);
  }
  return out.slice(0, 4).join('\n');
}

// ---------- indexed history (no AI) ----------
async function historyFor(git, dir, indexDir, priorStyle) {
  const indexed = await indexHistory({ git, dir, indexDir });
  return { ...indexed, ...historyStyle(indexed.commits, priorStyle) };
}

function loadLearned(store) { try { return JSON.parse(fs.readFileSync(store, 'utf8')); } catch { return {}; } }
function saveLearned(store, data) { try { fs.writeFileSync(store, JSON.stringify(data, null, 2)); } catch {} }

function correctionFeedback(groups, files, learned) {
  const current = new Set(files.map((f) => f.path));
  const memberships = new Map();
  for (let i = 0; i < groups.length; i++) for (const file of groups[i].files) {
    if (!memberships.has(file)) memberships.set(file, new Set());
    memberships.get(file).add(i);
  }
  const labels = new Map();
  for (const key of learned.together || []) labels.set(key, true);
  for (const key of learned.apart || []) labels.set(key, false);
  let known = 0, matched = 0;
  for (const [key, expected] of labels) {
    const [a, b] = key.split('\0');
    if (!a || !b || a === b || !current.has(a) || !current.has(b)) continue;
    known++;
    const left = memberships.get(a) || new Set(), right = memberships.get(b) || new Set();
    const actual = [...left].some((i) => right.has(i));
    if (actual === expected) matched++;
  }
  return { known, matched, accuracy: known ? matched / known : null };
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

// ---------- discarding ----------
// Throwing changes away, safely: every file is copied to .git/staged-trash/<id>/ first, so the last
// discard can be undone (and the last few are still there by hand if you need them).
const TRASH_KEEP = 12;
async function gitDir(dir) {
  const g = (await run(dir, ['rev-parse', '--git-dir'])).trim();
  return path.isAbsolute(g) ? g : path.join(dir, g);
}
async function discardChanges(dir, byPath, files, partial) {
  const root = path.join(await gitDir(dir), 'staged-trash');
  const id = Date.now().toString(36);
  const trash = path.join(root, id);
  const entries = [];
  const keep = (p) => {
    const full = path.join(dir, p);
    const exists = fs.existsSync(full) && fs.statSync(full).isFile();
    if (exists) { fs.mkdirSync(path.dirname(path.join(trash, p)), { recursive: true }); fs.copyFileSync(full, path.join(trash, p)); }
    entries.push({ path: p, exists });
  };
  let hasHead = true;
  try { await run(dir, ['rev-parse', '--verify', 'HEAD']); } catch { hasHead = false; }
  for (const p of files) {
    const f = byPath.get(p);
    if (!f) continue;
    if (f.status === 'U') throw new Error(`${p} has a merge conflict. Sort that out in your editor first.`);
    keep(p);
    if (f.from) keep(f.from);
    const inHead = hasHead && !f.untracked && f.status !== 'A' && !f.from;
    if (inHead) {
      await run(dir, ['checkout', 'HEAD', '--', p]);
    } else {
      await run(dir, ['rm', '--cached', '-q', '--ignore-unmatch', '--', p]).catch(() => {});
      fs.rmSync(path.join(dir, p), { force: true });
      if (f.from && hasHead) await run(dir, ['checkout', 'HEAD', '--', f.from]).catch(() => {});
    }
  }
  for (const [p, ids] of Object.entries(partial || {})) {
    if (!byPath.has(p) || !ids.length) continue;
    const diff = await run(dir, ['diff', 'HEAD', '--no-color', '-U3', '--', p]);
    const { header, hunks } = parseHunks(diff);
    const want = new Set(ids);
    const chosen = hunks.filter((h) => want.has(h.id));
    if (chosen.length !== want.size) throw new Error(`${p} changed since you looked. Refresh and try again.`);
    keep(p);
    const patch = [...header, ...chosen.flatMap((h) => [h.head, ...h.lines])].join('\n') + '\n';
    await run(dir, ['apply', '-R', '--recount', '-'], { input: patch });
  }
  // Only the newest few discards are kept.
  try {
    const old = fs.readdirSync(root).sort().reverse().slice(TRASH_KEEP);
    for (const o of old) fs.rmSync(path.join(root, o), { recursive: true, force: true });
  } catch {}
  return { id, trash, entries };
}
function restoreDiscard(dir, d) {
  for (const e of d.entries) {
    const full = path.join(dir, e.path);
    if (e.exists) { fs.mkdirSync(path.dirname(full), { recursive: true }); fs.copyFileSync(path.join(d.trash, e.path), full); }
    else fs.rmSync(full, { force: true });
  }
  fs.rmSync(d.trash, { recursive: true, force: true });
}

// ---------- routes ----------
// Commits that are here but not on the remote yet, newest first: what the next push sends.
async function outgoingCommits(git, dir, undoSha) {
  const remotes = (await git(dir, ['remote']).catch(() => '')).trim();
  if (!remotes) return { remote: false, commits: [] };
  const upstream = (await git(dir, ['rev-parse', '--abbrev-ref', '@{u}']).catch(() => '')).trim();
  const range = upstream ? ['@{u}..HEAD'] : ['HEAD', '--not', '--remotes'];
  const raw = await git(dir, ['log', ...range, '-n', '40', '--format=%x1e%H%x1f%s%x1f%ct', '--shortstat']).catch(() => '');
  const commits = raw.split('\x1e').filter((x) => x.trim()).map((block) => {
    const [head, ...rest] = block.split('\n');
    const [sha, subject, at] = head.split('\x1f');
    const stat = rest.join(' ');
    const num = (re) => +((stat.match(re) || [])[1] || 0);
    return { sha, subject, at: +at * 1000, files: num(/(\d+) files? changed/), add: num(/(\d+) insertions?/), del: num(/(\d+) deletions?/), undo: sha === undoSha };
  });
  // where the remote was before this push, so a receipt can link to the whole range of changes
  const base = upstream ? (await git(dir, ['rev-parse', '@{u}']).catch(() => '')).trim() : '';
  return { remote: true, upstream, base, commits };
}

export function commitRoutes({ git, makeAreaFn, repoDir, listRepos, onCommitted, store }) {
  const lastCommitByTool = new Map(); // repo -> sha this tool created most recently
  const lastDiscard = new Map(); // repo -> what the last discard threw away
  let styleCache = { at: 0, profile: null };
  let stylePromise = null;
  let engineStatsCache = { at: 0, value: null };
  async function userStyle() {
    if (styleCache.profile && Date.now() - styleCache.at < 5 * 60_000) return styleCache.profile;
    if (!stylePromise) stylePromise = (async () => {
      const repos = listRepos ? await listRepos().catch(() => []) : [];
      const profile = await styleAcrossRepos({ git, repos, indexDir: path.join(path.dirname(store), 'group-index') });
      styleCache = { at: Date.now(), profile };
      return profile;
    })().finally(() => { stylePromise = null; });
    return stylePromise;
  }

  const readJson = (req) => new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (d) => { b += d; if (b.length > 2e6) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
  });

  async function recentSubjects(dir) {
    return (await git(dir, ['log', '-20', '--no-merges', '--format=%s']).catch(() => '')).split('\n').filter(Boolean);
  }

  async function analyseRepo(name, dir, priorStyle, allLearned = loadLearned(store)) {
    const files = await readChanges(git, dir, makeAreaFn(dir));
    const hist = await historyFor(git, dir, path.join(path.dirname(store), 'group-index'), priorStyle);
    const learned = allLearned[hist.repoId] || allLearned[name] || {};
    const groups = suggestGroups(files, {
      cochange: cochangeFor(hist, files.map((f) => f.path), priorStyle.crossRepoPairs),
      together: new Set(learned.together || []),
      apart: new Set(learned.apart || []),
      verbs: hist.verbs, tense: hist.tense,
      emojiForType: { ...hist.emojiForType, ...(learned.emojiByType || {}) },
    });
    return { files, hist, learned, groups };
  }

  return async function handle(req, res, url, send) {
    if (!url.pathname.startsWith('/api/changes')) return false;
    if (url.pathname === '/api/changes/engine-stats' && req.method === 'GET') {
      if (engineStatsCache.value && Date.now() - engineStatsCache.at < 15000) {
        send(res, 200, JSON.stringify(engineStatsCache.value));
        return true;
      }
      const profile = await userStyle();
      const learned = loadLearned(store);
      let together = 0, apart = 0, emojiMappings = 0;
      for (const value of Object.values(learned)) {
        together += value.together?.length || 0;
        apart += value.apart?.length || 0;
        emojiMappings += Object.keys(value.emojiByType || {}).length;
      }
      const repos = listRepos ? await listRepos().catch(() => []) : [];
      const pending = [];
      let cursor = 0;
      const worker = async () => {
        while (cursor < repos.length) {
          const repo = repos[cursor++], name = repo.name || path.basename(repo.dir || '');
          try {
            const status = await git(repo.dir, ['status', '--porcelain=v1', '-z', '-uall']);
            if (!status) continue;
            const result = await analyseRepo(name, repo.dir, profile, learned);
            const decisions = result.groups.filter((group) => group.files.length > 1);
            const decisionsWeight = decisions.reduce((sum, group) => sum + group.files.length * (group.files.length - 1) / 2, 0);
            pending.push({ repo: name, groups: decisions.length, weight: decisionsWeight,
              weightedConfidence: decisions.reduce((sum, group) => sum + group.confidence * group.files.length * (group.files.length - 1) / 2, 0),
              reviewGroups: decisions.filter((group) => group.review).length });
          } catch {}
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, repos.length) }, worker));
      const currentWeight = pending.reduce((sum, item) => sum + item.weight, 0);
      const stats = {
        engine: 'Commit Compass',
        repositories: profile.indexedRepos, commits: profile.indexedCommits, indexedFiles: profile.indexedFiles,
        messageSamples: profile.commits, recurringPathPairs: profile.crossRepoPairs.size,
        learnedTogether: together, learnedApart: apart, learnedEmojiMappings: emojiMappings,
        style: { format: profile.format, tense: profile.tense, averageSubjectLength: profile.averageSubjectLength },
        currentScore: currentWeight ? pending.reduce((sum, item) => sum + item.weightedConfidence, 0) / currentWeight : null,
        currentScoreDecisions: pending.reduce((sum, item) => sum + item.groups, 0),
        currentScoreRepos: pending.filter((item) => item.groups).length,
        currentScoreReviewGroups: pending.reduce((sum, item) => sum + item.reviewGroups, 0),
      };
      engineStatsCache = { at: Date.now(), value: stats };
      send(res, 200, JSON.stringify(stats));
      return true;
    }
    if (url.pathname === '/api/changes/pushes' && req.method === 'GET') {
      // Every push since a date, across all repos, read from git's own record: each time you push,
      // git moves the remote-tracking branch and writes "update by push" in that branch's reflog.
      const since = Math.floor((+url.searchParams.get('since') || Date.now() - 7 * 864e5) / 1000);
      const repos = listRepos ? await listRepos().catch(() => []) : [];
      const pushes = [];
      await Promise.all(repos.map(async (repo) => {
        const name = repo.name || path.basename(repo.dir || '');
        const refs = (await git(repo.dir, ['for-each-ref', '--format=%(refname)', 'refs/remotes']).catch(() => '')).split('\n').filter((r) => r && !r.endsWith('/HEAD'));
        for (const ref of refs) {
          const log = (await git(repo.dir, ['reflog', 'show', '--date=unix', '--format=%H%x1f%gd%x1f%gs', ref, '--']).catch(() => '')).split('\n').filter(Boolean).map((l) => {
            const [sha, gd, gs] = l.split('\x1f');
            return { sha, at: +((gd.match(/@\{(\d+)\}/) || [])[1] || 0), what: gs || '' };
          });
          for (let i = 0; i < log.length; i++) {
            const e = log[i];
            if (e.at < since || !/update by push/.test(e.what)) continue;
            const prev = log[i + 1]?.sha;
            const range = prev ? `${prev}..${e.sha}` : e.sha;
            const n = +(await git(repo.dir, ['rev-list', '--count', range]).catch(() => '0')).trim() || 0;
            const stat = prev ? await git(repo.dir, ['diff', '--shortstat', prev, e.sha]).catch(() => '') : '';
            const num = (re) => +((stat.match(re) || [])[1] || 0);
            pushes.push({ at: e.at * 1000, repo: name, branch: ref.replace(/^refs\/remotes\//, ''), n, files: num(/(\d+) files? changed/), add: num(/(\d+) insertions?/), del: num(/(\d+) deletions?/), sha: e.sha });
          }
        }
      }));
      pushes.sort((a, b) => a.at - b.at);
      send(res, 200, JSON.stringify({ pushes }));
      return true;
    }
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
        const priorStyle = await userStyle();
        const allLearned = loadLearned(store);
        const { files, hist, learned, groups } = await analyseRepo(name, dir, priorStyle, allLearned);
        const branch = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim();
        return ok({
          repo: name, branch,
          files: files.map(({ content, ...f }) => (f.hunks ? { ...f, hunks: f.hunks.map(({ all, ...h }) => h) } : f)),
          groups,
          grouping: { engine: 'commit-compass', confidenceTarget: CONFIDENCE_TARGET, index: { schema: hist.schema, status: hist.status, commits: hist.commits.length, files: hist.indexedFiles, updatedAt: hist.indexedAt }, style: hist.style, feedback: correctionFeedback(groups, files, learned) },
          canUndo: lastCommitByTool.has(name),
          outgoing: await outgoingCommits(git, dir, lastCommitByTool.get(name)?.sha),
          canUndoDiscard: lastDiscard.has(name),
          verbs: hist.verbs, tense: hist.tense,
        }), true;
      }
      if (sub === '/outgoing' && req.method === 'GET') {
        // Just what the push panel needs, so it can follow you to every view of a repo.
        const branch = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim();
        return ok({ repo: name, branch, canUndo: lastCommitByTool.has(name), outgoing: await outgoingCommits(git, dir, lastCommitByTool.get(name)?.sha) }), true;
      }
      if (sub === '/message-local' && req.method === 'POST') {
        // The built-in writer, for just these files: used by "Rewrite" when no AI is around.
        const body = await readJson(req);
        const want = new Set(body.files || []);
        const files = (await readChanges(git, dir, makeAreaFn(dir))).filter((f) => want.has(f.path));
        if (!files.length) return fail('Pick at least one file', 400), true;
        const hist = await historyFor(git, dir, path.join(path.dirname(store), 'group-index'), await userStyle());
        const learnedAll = loadLearned(store), learned = learnedAll[hist.repoId] || learnedAll[name] || {};
        const tweaks = files.length > 1 && files.every((f) => f.status !== 'A' && f.add + f.del <= 12);
        return ok({ title: labelFor(files), ...messageFor(files, tweaks ? 'Small tweaks' : labelFor(files), tweaks, hist.verbs, hist.tense, { ...hist.emojiForType, ...(learned.emojiByType || {}) }) }), true;
      }
      if (sub === '/context' && req.method === 'GET') {
        // What an on-device model needs to write in your voice: recent subjects and their tense.
        const hist = await historyFor(git, dir, path.join(path.dirname(store), 'group-index'), await userStyle());
        return ok({ recent: await recentSubjects(dir), tense: hist.tense }), true;
      }
      if (sub === '/discard' && req.method === 'POST') {
        const body = await readJson(req);
        const current = parseStatus(await git(dir, ['status', '--porcelain=v1', '-z', '-uall']));
        const byPath = new Map(current.map((f) => [f.path, f]));
        const files = (body.files || []).filter((p) => byPath.has(p));
        const partial = body.partial || {};
        if (!files.length && !Object.keys(partial).length) return fail('Those files have no changes any more.', 409), true;
        const d = await discardChanges(dir, byPath, files, partial);
        lastDiscard.set(name, d);
        onCommitted && onCommitted(name);
        return ok({ discarded: d.entries.length, id: d.id }), true;
      }
      if (sub === '/discard-undo' && req.method === 'POST') {
        const d = lastDiscard.get(name);
        if (!d || !fs.existsSync(d.trash)) return fail('Nothing to bring back.', 409), true;
        restoreDiscard(dir, d);
        lastDiscard.delete(name);
        onCommitted && onCommitted(name);
        return ok({ restored: d.entries.length }), true;
      }
      if (sub === '/learn-style' && req.method === 'POST') {
        const body = await readJson(req);
        const type = String(body.type || ''), emoji = String(body.emoji || '');
        const types = ['feat', 'fix', 'style', 'perf', 'refactor', 'docs', 'chore', 'build', 'test', 'ci'];
        if (!types.includes(type) || emoji.length > 12 || !/\p{Extended_Pictographic}/u.test(emoji)) return fail('Choose a valid commit type and emoji', 400), true;
        const root = (await git(dir, ['rev-parse', '--show-toplevel']).catch(() => dir)).trim() || dir;
        const repoId = repoIdForPath(root), all = loadLearned(store);
        const learned = (all[repoId] ||= {});
        learned.emojiByType ||= {};
        learned.emojiByType[type] = emoji;
        saveLearned(store, all);
        engineStatsCache = { at: 0, value: null };
        return ok({ saved: true }), true;
      }
      if (sub === '/learn' && req.method === 'POST') {
        // { file, from: [paths left behind], to: [paths joined] }
        const body = await readJson(req);
        const all = loadLearned(store);
        const root = (await git(dir, ['rev-parse', '--show-toplevel']).catch(() => dir)).trim() || dir;
        const repoId = repoIdForPath(root), old = all[name] || {};
        const r = (all[repoId] ||= { together: [...(old.together || [])], apart: [...(old.apart || [])] });
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
        styleCache.at = 0;
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
        styleCache.at = 0;
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
