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
    // git can exit before reading stdin (EPIPE); without this handler that error would crash the server
    child.stdin.on('error', () => {});
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
// Defined here, used there. A chunk that brings in a brand-new name (a function, a constant, a CSS
// class, a custom property, a keyframes) and the chunks that start using that name are one change,
// the way a person reads a diff: `exitFallbackMs` added in motion.js and first called in ui.js.
// A name counts only when it is fresh (never in unchanged or removed lines), specific (made of parts
// or long) and defined in at most two places. Each using chunk joins the one definer it leans on most,
// so a chunk that touches three features can't chain them all together.
const NAME_TOKEN = /--[a-z][\w-]+|[A-Za-z_$][\w$]*(?:-[A-Za-z0-9_]+)*/g;
function specificName(raw) {
  if (raw.length < 5 || BUILTIN.test(raw) || /^[A-Za-z0-9]{1,2}(?:-[A-Za-z0-9]{1,2})+$/.test(raw)) return false;
  const low = raw.toLowerCase();
  if (STOPWORDS.has(low) || COMMON_NAMES.has(low)) return false;
  const parts = raw.replace(/^--/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean);
  return parts.length >= 2 || raw.length >= 8;
}
function definitionsIn(line, css) {
  const out = [];
  if (css) {
    const sel = line.includes('{') ? line.slice(0, line.indexOf('{')) : /,\s*$/.test(line) && /^\s*[.#&:>*\[\w\s-]/.test(line) && !/:\s+\S/.test(line) ? line : '';
    if (sel) for (const m of sel.matchAll(/\.([a-z][\w-]*)/gi)) out.push(m[1]);
    for (const m of line.matchAll(/(--[a-z][\w-]+)\s*:/gi)) out.push(m[1]);
    for (const m of line.matchAll(/@keyframes\s+([\w-]+)/g)) out.push(m[1]);
  } else {
    for (const m of line.matchAll(/(?:function\*?\s+|\b(?:const|let|var|class)\s+)([A-Za-z_$][\w$]*)/g)) out.push(m[1]);
    for (const m of line.matchAll(/\b(?:const|let|var)\s*\{([^}=]+)\}\s*=/g)) for (const x of m[1].split(',')) { const k = x.split(':').pop().trim(); if (k) out.push(k); }
    const key = line.match(/^\s*(?:async\s+)?([a-z][a-z0-9]*[A-Z][\w$]*)\s*(?::|\([^)]*\)\s*\{)/);
    if (key) out.push(key[1]);
    for (const m of line.matchAll(/[{,]\s*([a-z][a-z0-9]*[A-Z][\w$]*)\s*:(?!:)/g)) out.push(m[1]);
    // A custom property set from code with a template (`--motion-${tier}-duration`) defines a family.
    for (const m of line.matchAll(/setProperty\(\s*`(--[a-z][\w-]*\$\{[^}]+\}[\w-]*)`/g)) out.push('~' + m[1]);
    for (const m of line.matchAll(/(--[a-z][\w-]+)['"]?\s*[:,]/gi)) out.push(m[1]);
  }
  return out.filter(specificName);
}
function defineUseLinks(files, kinds, coll, isNew, union, hint = () => {}) {
  const n = files.length;
  const plus = [], minus = [], keptIn = [], kept = new Set(), defs = [], size = [], props = [];
  const tokens = (line, into) => { for (const m of line.matchAll(NAME_TOKEN)) into.add(m[0]); };
  const keptByPath = new Map(), importOnly = [], addedLines = [], styleNames = [];
  for (let i = 0; i < n; i++) {
    const f = files[i], p = new Set(), m = new Set(), d = new Set(), k = new Set(), pr = { add: new Set(), del: new Set() };
    plus.push(p); minus.push(m); defs.push(d); keptIn.push(k); props.push(pr); styleNames.push(new Set());
    if (isAsset(kinds[i]) || (coll[i] && isNew[i])) { size.push(0); continue; }
    const css = /\.(s?css|less|sass)$/i.test(f.path), html = /\.(html?|svelte|vue)$/i.test(f.path);
    const lines = f.status === 'A' && f.content ? f.content.slice(0, 60000).split('\n').map((l) => '+' + l) : (f.diff || '').split('\n');
    let changed = 0, inStyle = false, inComment = false;
    addedLines[i] = lines.filter((l) => l[0] === '+' && !l.startsWith('+++')).length;
    importOnly[i] = lines.some((l) => l[0] === '+' && !l.startsWith('+++')) && lines.every((l) => l[0] !== '+' || l.startsWith('+++') || /^\+\s*(import\b|export\s*\{|(const|let|var)\s.*=\s*require\(|\s*$)/.test(l));
    for (const l of lines) {
      if (l.startsWith('@@') || l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ')) continue;
      const styled = css || inStyle;
      // Words in comments are prose, not uses: a comment saying "one shared highlight" doesn't use
      // the `highlight` variable another chunk declares.
      let body = l.slice(1);
      if (inComment) { const end = body.indexOf('*/'); if (end < 0) body = ''; else { body = body.slice(end + 2); inComment = false; } }
      body = body.replace(/\/\*.*?\*\//g, ' ');
      if (body.includes('/*')) { body = body.slice(0, body.indexOf('/*')); inComment = true; }
      if (!styled) body = body.replace(/(^|[\s;{}(),])\/\/.*$/, '$1');
      if (/^\s*\*/.test(body) && !styled) body = '';
      if (html && /<style\b/i.test(body)) inStyle = true;
      if (l[0] === '+') { changed++; tokens(body, p); for (const x of definitionsIn(body, styled)) d.add(x); if (styled) for (const x of body.matchAll(/[.#]([a-z][\w-]*)|(--[a-z][\w-]+)/gi)) styleNames[i].add(x[1] || x[2]); }
      else if (l[0] === '-') { changed++; tokens(body, m); }
      else tokens(body, k);
      // Style properties a chunk adds or drops (mask-image, scrollbar-width, ::-webkit-scrollbar).
      if (styled && (l[0] === '+' || l[0] === '-')) for (const x of body.matchAll(/(?:^|[;{\s])(-?[a-z]+(?:-[a-z]+)+)\s*:(?!:)|::?(-webkit-[a-z-]+)/g)) (l[0] === '+' ? pr.add : pr.del).add(x[1] || x[2]);
      if (html && /<\/style>/i.test(body)) inStyle = false;
    }
    for (const x of k) kept.add(x);
    if (!keptByPath.has(f.path)) keptByPath.set(f.path, new Set());
    for (const x of k) keptByPath.get(f.path).add(x);
    size.push(changed);
  }
  // Fresh names only: one already in the code (unchanged or removed lines anywhere) says nothing.
  const definers = new Map(), families = [];
  for (let i = 0; i < n; i++) for (const x of defs[i]) {
    if (x[0] === '~') { families.push([new RegExp('^' + x.slice(1).replace(/[.*+?^()|[\]\\]/g, '\\$&').replace(/\$\{[^}]+\}/g, '[\\w-]+') + '$'), i]); continue; }
    if (kept.has(x) || minus.some((m) => m.has(x))) continue;
    if (!definers.has(x)) definers.set(x, []);
    definers.get(x).push(i);
  }
  for (const [x, ds] of definers) for (const [re, i] of families) if (re.test(x) && !ds.includes(i)) ds.push(i);
  for (const [x, ds] of definers) if (ds.length > 2) definers.delete(x);
  // The same custom property declared in two places (CSS and the code that sets it) is one system.
  for (const [x, ds] of definers) if (x.startsWith('--') && ds.length === 2) union(ds[0], ds[1], `defines ${x}`);
  const users = new Map();
  for (const [x, ds] of definers) users.set(x, plus.map((p, i) => (p.has(x) && !ds.includes(i) ? i : -1)).filter((i) => i >= 0));
  const totalUsers = new Array(n).fill(0);
  for (const [x, ds] of definers) for (const d of ds) totalUsers[d] += users.get(x).length;
  // A big chunk that brings in names for several features at once (a long block of new styles at the
  // end of a stylesheet) is a hub: its users spread over many files, so pulling each of them in would
  // fuse every feature it serves into one commit. Users then join their feature some other way.
  const userFiles = defs.map(() => new Set());
  for (const [x, ds] of definers) for (const d of ds) for (const u of users.get(x)) if (files[u].path !== files[d].path) userFiles[d].add(files[u].path);
  const hubDef = size.map((sz, d) => sz >= 120 && userFiles[d].size >= 3);
  const bothAdd = [], own = new Array(n).fill(false);
  // A name two chunks of one file both bring in (a button added to markup, its click handler).
  const addedIn = new Map();
  for (let i = 0; i < n; i++) if (files[i].unitOf) for (const x of plus[i]) if (specificName(x) && /[-_A-Z]/.test(x.slice(1))) (addedIn.get(x) || addedIn.set(x, []).get(x)).push(i);
  // CSS pseudo-classes (:last-child, :focus-visible) are syntax every stylesheet chunk may add, not a name.
  const PSEUDO = /^((first|last|only|nth)(-last)?-(child|of-type)|focus-(visible|within)|placeholder-shown)$/;
  for (const [x, is] of addedIn) {
    // In styles only a class, id or custom property is a name; a value (ui-monospace) is just a value.
    if (is.length !== 2 || PSEUDO.test(x) || is.some((i) => /\.(s?css|less|sass)$/i.test(files[i].path) && !styleNames[i].has(x)) || files[is[0]].path !== files[is[1]].path || definers.has(x) || props.some((pr) => pr.add.has(x) || pr.del.has(x))) continue;
    if (minus.some((m) => m.has(x)) || keptByPath.get(files[is[0]].path).has(x)) continue;
    bothAdd.push([is[0], is[1], x]); own[is[0]] = own[is[1]] = true;
  }
  for (const [a, b, x] of bothAdd) union(a, b, `both add ${x}`);
  // Names that leave the code together: a panel's markup goes from one file and its styles from
  // another, and nothing anywhere still mentions them. Taking a feature out is one change.
  const droppedIn = new Map();
  for (let i = 0; i < n; i++) if (size[i] && minus[i].size && addedLines[i] * 3 <= size[i]) for (const x of minus[i]) if (specificName(x) && /[-_A-Z]/.test(x.slice(1)) && !kept.has(x) && !plus.some((p) => p.has(x))) (droppedIn.get(x) || droppedIn.set(x, []).get(x)).push(i);
  const dropPairs = new Map();
  for (const [x, is] of droppedIn) {
    if (is.length < 2 || is.length > 3 || new Set(is.map((i) => files[i].path)).size !== is.length) continue;
    for (const j of is.slice(1)) { const key = is[0] + ':' + j; if (!dropPairs.has(key)) dropPairs.set(key, { a: is[0], b: j, x, c: 0 }); dropPairs.get(key).c++; }
  }
  // One shared word could be chance; three dropped together is a feature leaving.
  for (const { a, b, x, c } of dropPairs.values()) if (c >= 3) union(a, b, `both drop ${x}`);
  for (let u = 0; u < n; u++) {
    const score = new Map(), named = new Map(), narrow = new Map();
    for (const [x, ds] of definers) {
      const us = users.get(x);
      if (!us.includes(u)) continue;
      // A chunk that starts a feature of its own and also uses a widely shared new token (a motion
      // duration, a colour) belongs to its own feature, not to the token's.
      if (us.length > 3 && (size[u] > 8 || totalUsers[u] > 0 || own[u])) continue;
      if (x.startsWith('--') && (totalUsers[u] > 0 || own[u])) continue;
      for (const d of ds) {
        // Only other files are kept off a hub: callers inside the hub's own file are its feature (closedRepos).
        if (hubDef[d] && files[u].path !== files[d].path) { hint(u, d, x); continue; }
        score.set(d, (score.get(d) || 0) + 1 / us.length);
        if (!named.has(d) || x.length > named.get(d).length) named.set(d, x);
        if (us.length <= 2) narrow.set(d, x);
      }
    }
    let best = -1;
    for (const [d, s] of score) if (best < 0 || s > score.get(best) + 1e-9 || (Math.abs(s - score.get(best)) < 1e-9 && totalUsers[d] > totalUsers[best])) best = d;
    if (best >= 0) union(u, best, `uses ${named.get(best)}`);
    // A one-line chunk is small enough to wire two parts together (a template line that renders the
    // new list with the new class), when each name it uses is shared by at most one other chunk.
    if (best >= 0 && addedLines[u] === 1 && !importOnly[u]) for (const [d, x] of narrow) if (d !== best) union(u, d, `uses ${x}`);
    // A chunk whose new names only this chunk uses (besides the import line) serves it alone: fx.js's
    // foldRepaint, called only by the view's draw, goes with draw even when draw found a better match.
    // Not for a line or two that starts two features (initMotion(); initRepoHover();): that's wiring.
    if (addedLines[u] > 2) for (const [d, x] of narrow) if (d !== best && !hubDef[d] && files[d].path !== files[u].path && [...definers].every(([y, ds]) => !ds.includes(d) || users.get(y).every((v) => v === u || (importOnly[v] && files[v].path === files[u].path)))) union(u, d, `uses ${x}`);
  }
  // A chunk that edits a function (named in its hunk header) and a chunk elsewhere that starts calling it.
  for (let i = 0; i < n; i++) {
    const head = (files[i].unitOf || files[i].hunks?.length === 1) && (files[i].diff || '').split('\n').find((l) => l.startsWith('@@'));
    const fn = head && head.match(/@@[^@]*@@.*?\b(?:function\*?\s+|(?:const|let)\s+)([A-Za-z_$][\w$]{4,})/)?.[1];
    if (!fn || !specificName(fn)) continue;
    const callers = [];
    for (let j = 0; j < n; j++) if (j !== i && files[j].path !== files[i].path && plus[j].has(fn) && !minus[j].has(fn)) callers.push(j);
    if (callers.length && callers.length <= 2) for (const j of callers) union(i, j, `changes ${fn}`);
  }
  // Clean-up chunks: a chunk that only drops styling (mask-image: none, scrollbar-width: none) which a
  // new rule elsewhere in the same file now provides goes with that rule.
  for (let u = 0; u < n; u++) {
    if (!files[u].unitOf || size[u] > 4 || [...defs[u]].some((x) => definers.has(x)) || !props[u].del.size) continue;
    const gone = [...props[u].del].filter((x) => !props[u].add.has(x));
    if (!gone.length) continue;
    let best = -1, bestN = 0;
    for (let d = 0; d < n; d++) {
      if (d === u || hubDef[d] || files[d].path !== files[u].path || ![...defs[d]].some((x) => definers.has(x))) continue;
      const hit = gone.filter((x) => props[d].add.has(x) && !props[d].del.has(x)).length;
      if (hit > bestN) { best = d; bestN = hit; }
    }
    if (best >= 0) union(u, best, `replaced by ${[...defs[best]].find((x) => definers.has(x))}`);
  }
}
// A code name read as words: initMotionSystem -> motion system, suggestMerges -> merge suggestions,
// scroll-fade -> scroll fade, --motion-fast-duration -> motion durations.
const NOUN_OF = { suggest: 'suggestions', update: 'updates', preview: 'previews', render: '', get: '', compute: '', calc: '', append: '', allow: '', init: '', setup: '', build: '', make: '', create: '', handle: '', apply: '', mount: '', open: '', show: '', draw: '', wire: '' };
const TWO_VERBS = /^(define|use|read|write|load|save|find|link|split|join|group|sort|match|build|parse|send|fetch|open|close|show|hide|add|remove|move|copy|drag|drop|undo|redo)$/;
// Names that tie chunks together but aren't things a person would name a commit after: a regex
// class (A-Za-z_), a CSS pseudo-class (focus-visible), a data- or aria- attribute, a git flag.
const VENDOR = /(^|\/)(vendor|vendors|third[-_]party|node_modules|lib\/ext)\//i;
const DOM_API = /^(exec|execFile|execSync|execFileSync|spawn|spawnSync|fork|readFile|writeFile|readFileSync|writeFileSync|readdir|readdirSync|mkdir|mkdirSync|existsSync|statSync|promisify|createServer|fetch|structuredClone|AbortController|URLSearchParams|TextDecoder|TextEncoder|documentElement|querySelector(All)?|(add|remove)EventListener|classList|innerHTML|outerHTML|textContent|innerText|getBoundingClientRect|requestAnimationFrame|cancelAnimationFrame|set(Timeout|Interval)|clear(Timeout|Interval)|localStorage|sessionStorage|dataset|scroll(Top|Left|IntoView|Height|Width)|offset(Width|Height|Top|Left)|client(Width|Height)|matchMedia|getComputedStyle|createElement|appendChild|insertAdjacentHTML|preventDefault|stopPropagation|currentTarget|getAttribute|setAttribute|removeAttribute|toggleAttribute|closest|contains|setProperty|getPropertyValue)$/;
const NOT_A_THING = /^(A-Za-z|a-z|A-Z|0-9)|^(Extended_Pictographic|Emoji_Presentation|Emoji_Modifier|Regional_Indicator|White_Space|Alphabetic)$|^(focus|focus-visible|focus-within|first-child|last-child|nth-child|hover|active|checked|disabled|placeholder-shown|not)$|^(data|aria)-|^--(abbrev|format|no-|porcelain|numstat|shortstat|name-only|pretty|oneline|since|until|author|grep|follow|cached|staged|verify|quiet|force|all|tags|depth|unified)/;
function featureName(name) {
  if (NOT_A_THING.test(name) || DOM_API.test(name)) return '';
  // Code abbreviations as a word of the name (eng-pulse, btnRow, cfgPath) name code, not a feature.
  if (name.replace(/^--/, '').split(/[-_]|(?<=[a-z0-9])(?=[A-Z])/).some((w) => /^(eng|btn|cfg|pkg|msg|img|src|ctx|evt|err|str|num|obj|arr|tmp|idx|cnt|val|req|res|elem|util|utils|impl|dlg|hdr|ftr|cmp|rl|rp)$/i.test(w))) return '';
  // gh is GitHub's own CLI: ghRelease -> GitHub release.
  if (/^gh[A-Z][a-z]/.test(name)) { const rest = featureName(name[2].toLowerCase() + name.slice(3)); return rest ? `GitHub ${rest}` : ''; }
  // State flags and shorthand (justMoved, rl-badge, cm-head) name a variable, not a feature.
  if (/^(just|is|has|was|did|can|should|last|prev|next|cur|tmp|old)[A-Z_-]/.test(name) || name.replace(/^--/, '').replace(/^(cm|js|is|has|el|my|u)[-_]/, '').split(/[-_]|(?<=[a-z0-9])(?=[A-Z])/).some((w) => w.length > 0 && w.length <= 2 && !/^(ui|ux|qr|id|os|ai|db|on|in|up|to|by|of|at|go|do|no|it|or|as|be)$/i.test(w))) return '';
  // A product or brand written as one PascalCase word (GitHub, JavaScript) stays as written.
  if (/^[A-Z][a-z]+[A-Z][a-z]+$/.test(name) && /^(GitHub|GitLab|JavaScript|TypeScript|WebKit|YouTube|LinkedIn|PayPal|WordPress|MacBook|iPhone)$/.test(name)) return name;
  let words = name.replace(/^--/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (name.startsWith('--')) words = words.filter((w) => !/^(fast|moderate|slow|exit|sm|md|lg|xl|\d+)$/.test(w));
  while (words.length > 1 && /^(is|has|cm|js|u|el|my|the)$/.test(words[0])) words.shift();
  words = words.filter((w, i) => w.length > 1 || i === 0);
  while (words.length > 1 && /^(ms|px|el|fn|cb|id|ids|list|state|value|min|max|file|files|key|url|path|by|for|of|to|from|with)$/.test(words.at(-1))) words.pop();
  if (words.length > 1 && words[0] in NOUN_OF) {
    const noun = NOUN_OF[words.shift()];
    if (noun) words = [...words.map((w, i) => (i === words.length - 1 ? w.replace(/s$/, '') : w)), noun];
  }
  // Two verbs in a row name what the thing links or does: defineUseLinks -> define-and-use links.
  if (words.length >= 3 && TWO_VERBS.test(words[0]) && TWO_VERBS.test(words[1])) words = [`${words[0]}-and-${words[1]}`, ...words.slice(2)];
  if (name.startsWith('--') && words.length && !/s$/.test(words.at(-1))) words[words.length - 1] += 's';
  const out = words.join(' ');
  return out.length >= 4 && words.length <= 4 && !STOPWORDS.has(out) ? out : '';
}
// A tiny function that only picks a value out of a string (githubRepo: one .match and a return)
// is plumbing, not the feature the group is about.
function parserHelper(name, fs_) {
  for (const f of fs_) {
    const ls = (f.diff || '').split('\n'), at = ls.findIndex((l) => new RegExp(`^\\+\\s*(export\\s+)?(async\\s+)?function\\s+${name.replace(/[$]/g, '\\$')}\\s*\\(|^\\+\\s*(export\\s+)?const\\s+${name.replace(/[$]/g, '\\$')}\\s*=\\s*(async\\s*)?\\(`).test(l));
    if (at < 0) continue;
    const body = [];
    for (let k = at + 1; k < ls.length && body.length < 6; k++) { if (/^\+\}\s*;?\s*$/.test(ls[k])) break; body.push(ls[k]); }
    return body.length <= 3 && body.some((l) => /\.(match|exec|replace|split)\(/.test(l)) && body.some((l) => /\breturn\b/.test(l));
  }
  return false;
}
// The comment you wrote above a new name usually says what it is better than the name does:
// "/* Low-profile scrollbar treatment. */" -> low-profile scrollbar treatment; "One shared highlight
// glides between repository rows." -> a shared highlight that glides between repository rows.
const COMMENT_VERBS = new Set('glides slides fades shows keeps holds lives opens closes moves stays sits follows runs reads writes uses makes lets gives takes picks sorts groups tracks marks turns wraps fills draws renders appears steps hides lifts springs eases snaps scrolls points tells lists checks catches finds saves loads sends handles covers mirrors'.split(' '));
const COMMENT_IMPERATIVE = /^(find|keep|make|use|show|let|give|take|pick|sort|group|track|mark|turn|wrap|fill|draw|render|hide|check|catch|save|load|send|handle|return|get|set|add|remove|skip|try|only|don't|do|note|todo|fixme|hack|see|when|if|this|these|it|we|i)\b/i;
function commentPhrase(name, fs_) {
  for (const f of fs_) {
    const lines = (f.status === 'A' && f.content ? f.content.split('\n').map((l) => '+' + l) : (f.diff || '').split('\n'));
    const defines = (l) => l[0] === '+' && (name == null ? /^\+\s*(export\s+)?(async\s+)?(function|class|const|let|[.#][\w-]|--)/.test(l) : definitionsIn(l.slice(1), /\.(s?css|less|sass)$/i.test(f.path) || /^\s*[.#-]/.test(l.slice(1))).includes(name));
    for (let at = lines.findIndex(defines), tries = 0; at >= 0 && tries < 1; at = -1, tries++) {
    if (at < 1) continue;
    const said = [];
    let inBlock = false;
    for (let k = at - 1; k >= 0 && k >= at - 6; k--) {
      const t = lines[k].slice(1).trim();
      if (lines[k][0] !== '+') break;
      if (!inBlock && /\*\/$/.test(t) && !/\/\*/.test(t)) inBlock = true;
      if (!inBlock && !/^(\/\/|\/\*|\*|#(?!\{))/.test(t)) break;
      said.unshift(t.replace(/^(\/\/+|\/\*+|\*+|#+)\s*/, '').replace(/\s*\*+\/\s*$/, ''));
      if (inBlock && /\/\*/.test(t)) inBlock = false;
    }
    const sentences = said.join(' ').replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s/);
    // A short motto first ("Defined here, used there.") is a title, not a description: read on.
    const first = (sentences.length > 1 && sentences[0].split(' ').length <= 6 && /,/.test(sentences[0]) ? sentences[1] : sentences[0]).replace(/[.!?:]$/, '').replace(/^.*\s[›»>]\s/, '');
    if (!first || COMMENT_IMPERATIVE.test(first) || /[`(){}=<>\[\]]/.test(first) || /^(shown|kept|used|made|done|given|taken|seen|known|found|held|left|set|put|read|built|sent|written|drawn|called)\b/i.test(first)) continue;
    let words = first.split(' ');
    const cut = words.findIndex((w, i) => i >= 2 && /^(for|so|because|since|unless|but)$/i.test(w) || /[,;—]$/.test(w));
    if (cut > 0) words = words.slice(0, /[,;—]$/.test(words[cut]) ? cut + 1 : cut).map((w) => w.replace(/[,;—]$/, ''));
    const verbAt = words.findIndex((w, i) => i >= 1 && i <= 4 && COMMENT_VERBS.has(w.toLowerCase()));
    const lower = (ws) => { const out = []; ws.forEach((w, i) => out.push(/^[A-Z](?:[a-z]|$)/.test(w) && (i === 0 || (!/^[A-Z]/.test(out[i - 1] || '') && !/^[A-Z][a-z]/.test(ws[i + 1] || ''))) ? w.toLowerCase() : w)); return out; };
    let phrase;
    if (verbAt > 0) {
      const np = lower(words.slice(0, verbAt));
      if (/^(both|each|all|these|those|they|it|we|you|there|here|then|so|and|or|but)$/i.test(np[0])) continue;
      if (!np.some((w) => w.replace(/[^a-z]/gi, '').length >= 3)) continue; // "gh lives in ..." is about a tool, not the thing
      if (/^(one|the)$/i.test(np[0])) np[0] = 'a';
      phrase = /^(that|which|who)$/i.test(np.at(-1)) ? `${np.join(' ')} ${words.slice(verbAt).join(' ')}` : `${np.join(' ')} that ${words.slice(verbAt).join(' ')}`;
    } else if (words.length <= 5 && !words.some((w) => /^(is|are|was|were|be|been|being|has|have|had|can|could|will|would|should|must|may|might|does|do|did|blocks|crosses|means|needs|gets)$/i.test(w))) phrase = lower(words).join(' ');
    // "Bundle metadata only" is a caveat and "one observer serves every option" a sentence, not a name.
    if (phrase && /\sonly$/i.test(phrase)) continue;
    if (phrase && verbAt <= 0 && /\b\w{3,}s (every|each|all|the|a|an|its|their|our|your|this|that)\b/i.test(phrase)) continue;
    if (phrase && phrase.length >= 8 && phrase.length <= 64 && phrase.split(' ').length >= 2) return phrase;
    }
  }
  return '';
}
// Small style edits, read declaration by declaration: which rule, which property, which way.
const CSS_ELEMENT = { a: 'links', img: 'images', p: 'paragraphs', h1: 'headings', h2: 'headings', h3: 'headings', h4: 'headings', ul: 'lists', ol: 'lists', li: 'list items', button: 'buttons', input: 'inputs', body: 'the page', html: 'the page', nav: 'navigation', footer: 'footer', header: 'header', svg: 'icons', table: 'tables', code: 'code', pre: 'code blocks', blockquote: 'quotes', hr: 'dividers', ':root': 'theme' };
const CSS_PROP = { 'font-size': 'font size', 'font-weight': 'font weight', 'font-family': 'font', 'line-height': 'line height', 'letter-spacing': 'letter spacing', 'border-radius': 'corner radius', 'background-color': 'background', background: 'background', color: 'text color', 'box-shadow': 'shadow', 'z-index': 'stacking', 'max-width': 'max width', 'min-width': 'min width', 'max-height': 'max height', 'min-height': 'min height', 'grid-template-columns': 'columns', gap: 'spacing', 'row-gap': 'row spacing', 'column-gap': 'column spacing', fill: 'fill color', stroke: 'stroke color', 'stroke-width': 'stroke width', 'text-decoration': 'underline', transition: 'transition', opacity: 'opacity' };
function selectorWords(sel) {
  const last = sel.split(',')[0].trim().split(/\s+|>|\+|~/).filter(Boolean);
  const words = [];
  for (const part of last.slice(-2)) {
    const bare = part.replace(/::?[a-z-]+(\([^)]*\))?/g, '').replace(/\[[^\]]*\]/g, '');
    const cls = bare.match(/[.#]([a-z][\w-]*)/gi);
    if (cls) words.push(cls.map((c) => c.slice(1).replace(/^(is|has|js|u)-/, '').replace(/^[a-z]{1,2}-(?=[a-z]{3})/, '').replace(/[-_]+/g, ' ')).join(' '));
    else if (CSS_ELEMENT[bare.toLowerCase()]) words.push(CSS_ELEMENT[bare.toLowerCase()]);
    else if (bare) words.push(bare.toLowerCase());
  }
  const hover = /:hover|:focus/.test(sel) ? ' on hover' : '';
  return (words.at(-1) || '').replace(/\bbtn\b/g, 'button').replace(/\bnav\b/g, 'navigation').replace(/\bimg\b/g, 'image').trim() + hover;
}
// A rule inside a media query only holds there: (hover: none) is touch screens.
const MEDIA_PHRASE = [[/hover:\s*none|pointer:\s*coarse/, 'on touch screens'], [/hover:\s*hover|pointer:\s*fine/, 'on mouse devices'], [/prefers-reduced-motion/, 'with reduced motion'], [/prefers-color-scheme:\s*dark/, 'in dark mode'], [/^\s*print\b/, 'in print'], [/max-width/, 'on narrow screens'], [/min-width/, 'on wide screens']];
function cssSubject(fs_) {
  const edits = [], mediaOf = new Map();
  for (const f of fs_) {
    let sel = '', media = '', depth = 0;
    const rem = new Map(), add = new Map();
    const flush = () => {
      for (const [k, v] of rem) { const [s2, prop] = k.split('\0'); if (!add.has(k)) edits.push({ sel: s2, prop, from: v, to: null, f }); else if (add.get(k) !== v) edits.push({ sel: s2, prop, from: v, to: add.get(k), f }); }
      for (const [k, v] of add) if (!rem.has(k)) { const [s2, prop] = k.split('\0'); edits.push({ sel: s2, prop, from: null, to: v, f }); }
      rem.clear(); add.clear();
    };
    for (const l of (f.diff || '').split('\n')) {
      if (l.startsWith('@@')) { flush(); const h = l.match(/@@[^@]*@@\s*(.*\{)?/); sel = h?.[1] ? h[1].replace(/\{\s*$/, '').trim() : ''; continue; }
      if (l.startsWith('+++') || l.startsWith('---')) continue;
      const body = l.slice(1);
      let text = body;
      const mq = body.match(/@media\s*([^{]+)\{/);
      if (mq) { media = mq[1].trim(); depth = 0; }
      if (media) depth += (body.match(/\{/g) || []).length - (body.match(/\}/g) || []).length;
      const here = media;
      if (media && depth <= 0) media = '';
      const open = body.lastIndexOf('{');
      // A nested Sass rule (&:hover, &.active) belongs to the rule it sits in.
      if (open >= 0) { const s2 = body.slice(0, open).trim(); sel = s2.startsWith('&') && sel && !sel.startsWith('&') ? sel.split(',')[0].trim() + s2.slice(1) : s2 || sel; text = body.slice(open + 1); }
      if (l[0] !== '+' && l[0] !== '-') { if (body.includes('}')) { flush(); } continue; }
      // A Sass mixin that sets a property counts as setting it: @include themed(color, $dark-700, $dark-300).
      const mixin = text.match(/^\s*@include\s+[\w-]+\(\s*([a-z][a-z-]*)\s*,\s*([^;{}]+)\)\s*;?\s*$/);
      if (mixin) { (l[0] === '+' ? add : rem).set(sel + '\0' + mixin[1], mixin[2].trim()); continue; }
      for (const m of text.matchAll(/(?:^|;)\s*(-?[a-z][a-z-]*)\s*:\s*([^;{}]+)/g)) {
        if (m[1].startsWith('--') || /^(-webkit|-moz)/.test(m[1])) continue;
        (l[0] === '+' ? add : rem).set(sel + '\0' + m[1], m[2].trim());
        mediaOf.set(sel, here);
      }
    }
    flush();
  }
  if (!edits.length || edits.length > 3) return '';
  // A hunk deep inside a rule shows no selector: the stylesheet's own name says where (_articles.scss -> articles).
  const fileWords = (f) => { const n = stemOf(f.path).replace(/[-_]+/g, ' '); return /^(style|styles|main|base|index|global|globals|app|site|variables|theme)$/.test(n) ? '' : n; };
  let sels = [...new Set(edits.map((e) => selectorWords(e.sel) || fileWords(e.f)).filter(Boolean))];
  // "links and links on hover" is just links.
  sels = sels.filter((x) => !(x.endsWith(' on hover') && sels.includes(x.slice(0, -9))));
  if (!sels.length || sels.length > 2 || sels.some((x) => x.length > 28)) return '';
  const num = (v) => { const m = String(v || '').match(/^(-?[\d.]+)(px|rem|em|%|vh|vw)?$/); return m ? parseFloat(m[1]) : null; };
  const verbOf = (e) => (e.to == null ? 'Removed' : e.from == null ? 'Added' : num(e.from) != null && num(e.to) != null ? (num(e.to) < num(e.from) ? 'Reduced' : 'Increased') : 'Changed');
  const props = edits.map((e) => ({ v: verbOf(e), p: CSS_PROP[e.prop] || e.prop.replace(/-/g, ' ') }));
  const verbs = [...new Set(props.map((x) => x.v))];
  const verb = verbs.length === 1 ? verbs[0] : 'Adjusted';
  const what = list([...new Set(props.map((x) => x.p))]);
  const where = list(sels);
  const prep = verb === 'Removed' ? 'from' : verb === 'Added' ? 'to' : 'for';
  const medias = [...new Set(edits.map((e) => mediaOf.get(e.sel) || ''))];
  const onlyIn = medias.length === 1 && medias[0] ? MEDIA_PHRASE.find(([re]) => re.test(medias[0]))?.[1] || '' : '';
  // Full opacity under a media query is "always shown there": Stopped always showing discard on touch screens.
  if (onlyIn && edits.length === 1 && edits[0].prop === 'opacity' && (edits[0].to ?? edits[0].from) === '1' && (edits[0].to == null || edits[0].from == null)) return edits[0].to == null ? `Stopped always showing ${where} ${onlyIn}` : `Kept ${where} visible ${onlyIn}`;
  const gm = `${verb} ${what} ${prep} ${where}${onlyIn ? ' ' + onlyIn : ''}`;
  return gm.length <= 70 ? gm : '';
}
// The label people see on a new element is its name: <button class="modal-handle" aria-label="Close
// sheet"> is a close sheet button, not a modal handle.
function labelPhrase(name, fs_) {
  if (name.startsWith('--')) return '';
  const esc_ = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const f of fs_) for (const l of (f.diff || '').split('\n')) {
    if (l[0] !== '+') continue;
    const m = l.match(new RegExp(`<(\\w+)[^>]*class="[^"]*\\b${esc_}\\b[^"]*"[^>]*>`));
    if (!m) continue;
    const label = m[0].match(/(?:aria-label|title)="([^"]{3,40})"/)?.[1] || l.slice(l.indexOf(m[0]) + m[0].length).match(/^([A-Za-z][^<]{2,30})</)?.[1];
    if (!label || /\$\{/.test(label)) continue;
    const tag = { button: 'button', a: 'link', input: 'field', select: 'menu', nav: 'menu' }[m[1].toLowerCase()] || '';
    if (!tag && !/\s/.test(label.trim())) continue;
    const words_ = label.trim().replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase());
    return `${/s$/.test(words_) ? '' : /^[aeiou]/i.test(words_) ? 'an ' : 'a '}${words_}${tag && !new RegExp(`\\b${tag}$`, 'i').test(words_) ? ' ' + tag : ''}`;
  }
  return '';
}
// A view renamed in place: exports and the header both swap one word for another.
function renameOf(f) {
  const d = f.diff || '';
  const gone = [...d.matchAll(/^-\s*export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
  const came = [...d.matchAll(/^\+\s*export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
  for (const a of gone) for (const b of came) {
    if (a === b) continue;
    let k = 0; while (k < a.length && a[k] === b[k]) k++;
    const pre = a.slice(0, k);
    const oldW = a.slice(k), newW = b.slice(k);
    if (pre.length >= 3 && /^[A-Z][a-z]+$/.test(oldW) && /^[A-Z][a-z]+$/.test(newW) && came.length <= 6) {
      // The header should agree: the old word leaves it, the new one arrives.
      const head = (sign) => (d.split('\n').find((l) => l[0] === sign && /^.\s*(\/\/|\/\*|\*)/.test(l)) || '');
      if (head('-').includes(oldW) && head('+').includes(newW)) return [oldW, newW];
      if (!head('-') && !head('+')) return [oldW, newW];
    }
  }
  return null;
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
    const splittable = hs && hs.length >= 2 && hs.length <= 120 && !collectionOf(f.path) && !/\.(md|mdx|txt|json|ya?ml|toml|lock)$/i.test(f.path);
    if (!splittable) { files.push(f); continue; }
    const big = hs.reduce((b, h) => (h.add + h.del > b.add + b.del ? h : b), hs[0]);
    for (const [at, h] of hs.entries()) files.push({ ...f, unitOf: f.path, hunk: h.id, at, home: h === big, units: hs.length, diff: h.head + '\n' + (h.all || h.lines).join('\n'), add: h.add, del: h.del, hunks: undefined });
  }
  const whole = (i) => !files[i].unitOf || files[i].home;
  const n = files.length;
  const parent = files.map((_, i) => i);
  const why = files.map(() => new Set());
  const linkEvidence = [], heldEvidence = [];
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const apart = learn.apart || new Set();
  const keyOf = (a, b) => (files[a].path < files[b].path ? files[a].path + '\0' + files[b].path : files[b].path + '\0' + files[a].path);
  const members = (r) => files.map((_, k) => k).filter((k) => find(k) === r);
  const evidenceWeight = (reason) => reason === 'you grouped these before' ? 0.99
    : reason === 'imports new file' ? 0.97
      : reason.startsWith('uses ') ? 0.94
        : reason.startsWith('drops ') || reason === 'manifest and lock' ? 0.90
        : reason.startsWith('changes ') || reason.startsWith('defines ') || reason === 'same edit' ? 0.88
          : reason.startsWith('both add ') || reason.startsWith('replaced by ') || reason.startsWith('both drop ') ? 0.86
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
    // Already joined, maybe only by a weak link that the bridge split will cut: keep a stronger fact
    // on record so it still holds the pair (about.md including skills.html after "one topic" joined them).
    if (ra === rb) { if (a !== b && confidence >= MIN_GROUP_LINK_EVIDENCE) heldEvidence.push({ a, b, confidence, reason }); return; }
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
  // A dependency manifest and its lock file move together: package.json with package-lock.json, Gemfile with Gemfile.lock.
  const LOCKS = { 'package.json': /^(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/, Gemfile: /^Gemfile\.lock$/, 'Cargo.toml': /^Cargo\.lock$/, 'composer.json': /^composer\.lock$/, 'pyproject.toml': /^(poetry|uv|pdm)\.lock$/, Pipfile: /^Pipfile\.lock$/, 'go.mod': /^go\.sum$/ };
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const lock = LOCKS[path.basename(files[i].path)];
    if (i !== j && whole(i) && whole(j) && lock && lock.test(path.basename(files[j].path)) && path.dirname(files[i].path) === path.dirname(files[j].path)) union(i, j, 'manifest and lock');
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
  // Both gone counts too: deleting _data/programs.yml and _includes/about/programs.html takes one part out.
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (whole(i) && whole(j) && (files[i].status === 'A' || files[j].status === 'A' || (files[i].status === 'D' && files[j].status === 'D')) && stems[i].length >= 3 && stems[i] === stems[j] && !WEAK_STEMS.has(stems[i])) union(i, j, 'same name');
  }
  // New sibling files named on one pattern are one set: raycast/busy-lamp-focus.sh with
  // raycast/busy-lamp-free.sh, .githooks/pre-commit with .githooks/pre-push.
  const nameParts = (p) => path.basename(p, path.extname(p)).toLowerCase().split(/(?<=[-_.])/);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (!whole(i) || !whole(j) || files[i].status !== 'A' || files[j].status !== 'A' || coll[i] || coll[j]) continue;
    if (dirOf(files[i].path) !== dirOf(files[j].path) || path.extname(files[i].path) !== path.extname(files[j].path)) continue;
    const a = nameParts(files[i].path), b = nameParts(files[j].path);
    let shared = ''; for (let k = 0; k < Math.min(a.length, b.length) - 1 && a[k] === b[k] && /[-_.]$/.test(a[k]); k++) shared += a[k];
    if (shared.length >= 4 && !/^(index|main|test|spec)[-_.]$/.test(shared)) union(i, j, 'same name');
  }
  // Two new files where one's whole name starts the other's (receipt.js, receipt-image.js) are one
  // feature as surely as a shared stem, so that counts as the same name, not a weak shared topic.
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
    if ((files[i].status === 'A' || files[j].status === 'A') && !coll[i] && !coll[j] && !isAsset(kinds[i]) && !isAsset(kinds[j]) && words[i].some((a) => words[j].some((b) => sameWord(a, b)))) union(i, j, files[i].status === 'A' && files[j].status === 'A' && [[i, j], [j, i]].some(([x, y]) => words[x].length === 1 && words[y].length > 1 && words[y][0] === words[x][0]) ? 'same name' : 'one topic');
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
    if (isNew[i] && coll[i]) continue;
    // A page written in Markdown still pulls in parts with a template tag: {% include about/skills.html %}.
    if (prose(files[i].path)) {
      if (!/\.(md|markdown|mdx)$/i.test(files[i].path)) continue;
      const tags = addedText(files[i]).match(/\{%-?\s*(?:include|render)\s+[^%]+%\}/g) || [];
      for (let j = 0; j < n; j++) if (j !== i && isNew[j] && !coll[j] && tags.some((t) => t.includes(files[j].path.replace(/^_includes\//, '')))) links.push([i, j, 'includes new file']);
      continue;
    }
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
      if (!hit && code) hit = exportsOf(body).find((x) => specificName(x) && new RegExp(`\\b${esc(x)}\\b`).test(add));
      if (!hit && /\.s?css$/i.test(files[i].path)) hit = [...add.matchAll(/\.([a-z][\w]*-[\w-]{2,})/g)].map((m) => m[1]).find((c) => c.length >= 6 && !/^(is|has|no|js|u|with)-/.test(c) && body.includes(c));
      if (hit) links.push([i, j, `uses ${hit}`]);
    }
  }
  // A new image or video named by its path in a string or a data file is that file's: app.js gaining
  // icon: 'assets/globe.svg', or portfolio-data.json listing "videoUrl": "assets/videos/2113…-0.mp4".
  // Code naming a new data file counts too (server.js reading "hidden-book-notes.json"). Data files are
  // read in full (their shown diff is cut short), so a long list still finds its media.
  for (let i = 0; i < n; i++) {
    const p = files[i].path, data = /\.(json|ya?ml)$/i.test(p) && !coll[i];
    if (!data && !/\.(m?js|cjs|jsx?|tsx?)$/i.test(p)) continue;
    const add = (files[i].hunks ? files[i].hunks.flatMap((h) => h.all || h.lines) : (files[i].diff || '').split('\n')).filter((l) => l[0] === '+').join('\n');
    for (let j = 0; j < n; j++) {
      if (i === j || !isNew[j] || !(isAsset(kinds[j]) || (!data && /\.(json|ya?ml|csv)$/i.test(files[j].path))) || links.some(([a, b]) => a === i && b === j)) continue;
      const base = path.basename(files[j].path).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Code must quote the path; YAML leaves it bare (logo: /Images/Skills/blender.png).
      const named = data ? new RegExp(`(^|[\\s'"\`:/])${base}(['"\`,]|\\s|$)`, 'm') : new RegExp(`['"\`]([^'"\`\\s]*/)?${base}['"\`]`);
      // Code says what the file is for by its name ("uses arrow-down"); a data list just includes it.
      if (named.test(add)) links.push([i, j, data ? 'includes new file' : `uses ${stems[j]}`]);
    }
  }
  // A Sass import list grows one line at a time: `"now",` -> `"now", "delights";` pulls in the new _delights.scss.
  for (let i = 0; i < n; i++) {
    if (!/\.s[ac]ss$/i.test(files[i].path)) continue;
    const dir = path.posix.dirname(files[i].path), found = new Set();
    for (const m of addedText(files[i]).matchAll(/^\+\s*(?:@(?:import|use|forward)\s+)?["']([\w/-]+)["']\s*[,;]?\s*$/gm)) {
      const name = m[1].split('/'), last = name.pop();
      for (const cand of [[...name, '_' + last], [...name, last]]) for (const ext of ['.scss', '.sass']) {
        const j = byPath.get(path.posix.join(dir, ...cand) + ext);
        if (j != null && j !== i && isNew[j] && !links.some(([a, b]) => a === i && b === j)) found.add(j);
      }
    }
    // The main sheet pulling in two unrelated partials (experience-summary, image-lightbox) is shared by
    // both features, so it joins neither; partials of one name (theme, theme-dark) are one feature.
    const parts = [...found].map((j) => stems[j].split(/[-_]+/));
    if (found.size && parts[0].some((w) => parts.every((ws) => ws.includes(w)))) for (const j of found) links.push([i, j, 'imports new file']);
  }
  // A file taken out goes with the change that stops pointing at it: app.js dropping <img src="assets/info.svg">
  // and the deleted info.svg are one change.
  for (let j = 0; j < n; j++) {
    if (files[j].status !== 'D' || coll[j]) continue;
    const base = path.basename(files[j].path), esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|[^\\w.-])${esc}([^\\w.-]|$)`);
    const who = [];
    for (let i = 0; i < n; i++) if (i !== j && files[i].status !== 'D' && (files[i].diff || '').split('\n').some((l) => l[0] === '-' && !l.startsWith('---') && re.test(l) && (!prose(files[i].path) || /\{%-?\s*(include|render)\b/.test(l)))) who.push(i);
    // Only when one file let go of it; a name dropped in many places is a sweep of its own.
    if (who.length && new Set(who.map((i) => files[i].path)).size === 1) for (const i of who) union(i, j, `drops ${stems[j]}`);
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
  // Uses of a hub chunk's names don't join anything, but they still say what a group is about.
  const nameHints = [];
  defineUseLinks(files, kinds, coll, isNew, union, (a, b, x) => nameHints.push({ a, b, reason: `uses ${x}` }));
  // A hub whose names mostly (60%+) go to one feature is that feature's own big chunk (the cart's 370
  // lines of styles: 50 of its names used by the cart's view, a few by the cards). Joining it to
  // that one feature fuses nothing else. Run again once the softer evidence below has gathered a
  // hub's scattered users (an import line, a menu item, a settings button) into one group.
  const joinHubs = () => {
    const hubVotes = new Map();
    for (const h of nameHints) { const m = hubVotes.get(h.b) || hubVotes.set(h.b, new Map()).get(h.b), r = find(h.a); m.set(r, [...(m.get(r) || []), h.reason]); }
    for (const [d, m] of hubVotes) {
      const total = [...m.values()].reduce((s, v) => s + v.length, 0), [r, rs] = [...m].sort((x, y) => y[1].length - x[1].length)[0];
      if (rs.length >= 3 && rs.length >= 0.6 * total && find(d) !== r) union(r, d, rs[0]);
    }
  };
  joinHubs();
  const editSigs = new Map();
  // The same edit made in many places (every 1px divider turned into a hairline, 600 weights to 500)
  // is one change, even with no new name to tie it together. Each chunk still on its own is read as
  // line pairs; what a pair takes out and puts in is its edit, and chunks whose main edit is the same
  // go together.
  {
    const editTokens = (t) => t.match(/--[\w-]+|[\w.#%-]+|[^\s\w]/g) || [];
    const mainEdit = (f) => {
      const minus = [], plus = [], seen = new Map();
      for (const l of (f.diff || '').split('\n')) { if (l[0] === '-' && !l.startsWith('---')) minus.push(l.slice(1)); else if (l[0] === '+' && !l.startsWith('+++')) plus.push(l.slice(1)); }
      if (!minus.length || minus.length !== plus.length || minus.length > 6) return '';
      for (let k = 0; k < minus.length; k++) {
        const a = editTokens(minus[k]), b = editTokens(plus[k]), ca = new Map(), cb = new Map();
        for (const t of a) ca.set(t, (ca.get(t) || 0) + 1);
        for (const t of b) cb.set(t, (cb.get(t) || 0) + 1);
        const out = [...ca].filter(([t, c]) => c > (cb.get(t) || 0)).map(([t]) => '-' + t);
        const inn = [...cb].filter(([t, c]) => c > (ca.get(t) || 0)).map(([t]) => '+' + t);
        if (!out.length && !inn.length || out.length + inn.length > 8) continue;
        const sig = out.join(' ') + ' | ' + inn.join(' ');
        seen.set(sig, (seen.get(sig) || 0) + 1);
      }
      return [...seen].sort((x, y) => y[1] - x[1])[0]?.[0] || '';
    };
    const lone = (i) => members(find(i)).length === 1;
    const bySig = editSigs;
    for (let i = 0; i < n; i++) {
      if (!files[i].unitOf && files[i].status !== 'M' || !lone(i)) continue;
      const sig = mainEdit(files[i]);
      if (sig) { if (!bySig.has(sig)) bySig.set(sig, []); bySig.get(sig).push(i); }
    }
    for (const [sig, is] of bySig) if (is.length >= 2) for (const j of is.slice(1)) union(is[0], j, 'same edit');
  }

  // Two data files of one name with nothing else to read: portfolio-data.json and portfolio.config.json
  // went in together every time new posts were synced. Data has no shared code names, so history decides.
  if (learn.cochange) for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const data = (k) => !files[k].unitOf && files[k].status !== 'D' && !coll[k] && /\.(json|ya?ml|toml)$/i.test(files[k].path) && !/(^|\/)package(-lock)?\.json$/.test(files[k].path);
    // They must share a name too: _config.yml changes alongside everything, so history alone over-joins it.
    const w = (k) => stems[k].split(/[-_.]+/).filter((x) => x.length >= 4);
    if (data(i) && data(j) && w(i).some((x) => w(j).includes(x)) && (learn.cochange.get(keyOf(i, j)) || 0) >= 0.5) union(i, j, 'usually change together');
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
  joinHubs();
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
    // Chunks of one file are held together only by their own evidence (a shared name, the
    // home-chunk fallback), never by the path alone: that would let style.css glue every feature
    // it touches into one commit.
    for (const edge of [...linkEvidence, ...heldEvidence]) {
      if (edge.confidence < MIN_GROUP_LINK_EVIDENCE || !membersInGroup.has(edge.a) || !membersInGroup.has(edge.b)) continue;
      const a = localFind(edge.a), b = localFind(edge.b);
      if (a !== b) localParent.set(b, a);
    }
    // A chunk left on its own found no feature of its own: it
    // goes back with the rest of that file, the way people mostly commit whole files.
    let pieces = new Map();
    for (const i of idx) { const root = localFind(i); if (!pieces.has(root)) pieces.set(root, []); pieces.get(root).push(i); }
    for (const piece of pieces.values()) {
      const p = files[piece[0]].path;
      if (!piece.every((i) => files[i].path === p) || piece.some((i) => files[i].home)) continue;
      const inside = new Set(piece);
      if ([...linkEvidence, ...heldEvidence].some((e) => inside.has(e.a) && inside.has(e.b) && e.confidence >= MIN_GROUP_LINK_EVIDENCE && /^(uses|both add|both drop|defines|changes|replaced by) |^same edit$/.test(e.reason))) continue;
      const mate = [...pieces.values()].filter((q) => q !== piece && q.some((i) => files[i].path === p))
        .sort((x, y) => Number(y.some((i) => files[i].path === p && files[i].home)) - Number(x.some((i) => files[i].path === p && files[i].home)) || y.length - x.length)[0];
      if (mate) localParent.set(localFind(piece[0]), localFind(mate[0]));
    }
    const parts = new Map();
    for (const i of idx) { const root = localFind(i); if (!parts.has(root)) parts.set(root, []); parts.get(root).push(i); }
    return [...parts.values()];
  };
  let groups = [...buckets.values()].flatMap((idx) => splitWeakBridges(idx).map((part) => ({ idx: part })));
  // Groups decided elsewhere (you moved a file, or a test replays real commits): keep them as given
  // and only write their messages. Each group lists paths, or "path#chunk" for single chunks.
  if (Array.isArray(learn.fixed)) {
    const keyOf_ = (f) => (f.unitOf ? f.path + '#' + f.hunk : f.path);
    groups = learn.fixed.map((keys) => ({ idx: files.map((f, i) => (keys.includes(keyOf_(f)) || keys.includes(f.path) || (!f.unitOf && keys.some((k) => k.startsWith(f.path + '#'))) ? i : -1)).filter((i) => i >= 0) }));
    groups.forEach((g, k) => { g.at = k; });
    groups = groups.filter((g) => g.idx.length);
  }

  // Leave unrelated small edits separate. They only share a commit when another signal connects them.

  const build = (g, k) => {
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
    // What the group is built around: the new name its chunks are tied together by (scroll-fade used
    // in nine places, a modal-handle added to markup and wired up). That is what a person would name.
    const plain = !['fix', 'perf', 'docs', 'test', 'ci', 'chore', 'build'].includes(msg.type) && !/^Updated [^:]+: /.test(msg.gitmoji) && !msg.fromHeader;
    if (plain && g.idx.length >= 2) {
      const inside = new Set(g.idx), count = new Map();
      for (const pass of [linkEvidence, nameHints]) {
        if ([...count].some(([x, c]) => featureName(x) && (c >= 2 || featureName(x).includes(' ')))) break;
        for (const e of pass) {
          if (!inside.has(e.a) || !inside.has(e.b)) continue;
          const m = e.reason.match(/^(?:uses|both add|defines|replaced by) (.+)$/);
          if (m) count.set(m[1], (count.get(m[1]) || 0) + 1);
        }
      }
      // A name scores by how many ties it makes, plus the ties of names sharing a word with it
      // (initMotionSystem next to --motion-fast-duration), and a name of several parts beats one word.
      const wordsOf_ = (x) => new Set(featureName(x).split(' ').filter((w) => w.length >= 4));
      const scored = [...count].map(([x, c]) => {
        const ws = wordsOf_(x);
        let bonus = 0;
        for (const [y, d] of count) if (y !== x && [...wordsOf_(y)].some((w) => ws.has(w))) bonus += d;
        return [x, c + bonus * 0.5 + (ws.size >= 2 ? 0.75 : 0), c];
      }).filter(([x, , c]) => featureName(x) && !parserHelper(x, g.idx.map((i) => files[i])) && (c >= 2 || g.idx.length <= 3 || featureName(x).includes(' ')));
      // Every tie was plumbing: try the other new functions, defined in one chunk and called in another.
      if (!scored.length && [...count].length) {
        const units = g.idx.map((i) => files[i]);
        for (const u of units) for (const m of (u.diff || '').matchAll(/^\+\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) {
          const x = m[1], call = new RegExp(`(^|[^\\w$.])${x.replace(/[$]/g, '\\$')}\\s*\\(`);
          if (featureName(x) && !parserHelper(x, units) && units.some((v) => v !== u && (v.diff || '').split('\n').some((l) => l[0] === '+' && call.test(l.slice(1))))) scored.push([x, 1, 1]);
        }
      }
      const multi = (x) => (featureName(x).includes(' ') ? 1 : 0);
      const top = scored.sort((a, b) => multi(b[0]) - multi(a[0]) || b[1] - a[1] || featureName(b[0]).split(/[ -]/).length - featureName(a[0]).split(/[ -]/).length || a[0].length - b[0].length)[0];
      // A comment that titles what it sits on ("// The side panel: reviewing a batch ...") names the group;
      // one that is a sentence ("// The header should agree: ...") does not.
      const titled = (() => {
        for (const i of g.idx) { const ls = (files[i].diff || '').split('\n');
          for (let k = 0; k < ls.length - 1; k++) { const m = ls[k].match(/^\+\s*(?:\/\/+|\/\*+|#)\s*(the|a|an)\s+([a-z][a-z-]*(?: [a-z][a-z-]*){0,2}):\s+\S/i);
            if (m && /^\+\s*(?:export\s+)?(?:async\s+)?(?:function\b|class\b|const\b|let\b|[\w$]+\s*[:=(])/.test(ls[k + 1]) && !NOT_A_THING.test(m[2]) && !/\b(should|must|can|will|is|are|was|does|has)\b/.test(m[2])) return `${m[1].toLowerCase() === 'the' ? 'the' : 'a'} ${m[2].toLowerCase()}`; } }
        return '';
      })();
      const thing = titled || top && (scored.slice(0, 3).map(([x]) => commentPhrase(x, g.idx.map((i) => files[i])) || labelPhrase(x, g.idx.map((i) => files[i]))).find(Boolean) || commentPhrase(null, g.idx.map((i) => files[i]).sort((a, b) => b.add - a.add).slice(0, 1)) || featureName(top[0]));
      if (thing) {
        const spots = [...new Set(fs_.map((f) => (/index\.html?$/.test(f.path) ? 'the page' : nameOf(f.path).toLowerCase())))];
        const place = spots.length >= 4 && !/\bacross\b/.test(thing) ? ` across ${spots.length} files` : '';
        const add = fs_.reduce((s2, f) => s2 + f.add, 0), del = fs_.reduce((s2, f) => s2 + f.del, 0);
        const verb = del > add * 1.5 && del >= 8 ? 'Simplified' : del >= add * 0.6 && add >= 20 ? 'Reworked' : 'Added';
        const gm = (`${verb} ${thing}${place}`.length <= 72 ? `${verb} ${thing}${place}` : `${verb} ${thing}`).replace(/^Added (a|an|one) (?=[a-z])/i, (m, art) => m);
        const conv = msg.conventional?.match(/^([a-z]+(?:\([^)]*\))?!?: )/)?.[1] || '';
        Object.assign(msg, { type: msg.type === 'style' ? 'style' : 'feat', gitmoji: gm, conventional: conv + (gm[0].toLowerCase() + gm.slice(1)).replace(/^added /, 'add ').replace(/^simplified /, 'simplify ').replace(/^reworked /, 'rework ') });
        msg.emoji = verb === 'Simplified' || verb === 'Reworked' ? '♻️' : msg.type === 'style' ? '💄' : '✨';
        if (!titled && thing === featureName(top?.[0] || '')) msg.fromIdent = true;
        if (verb === 'Simplified' || verb === 'Reworked') msg.type = 'refactor';
      }
    }
    // The same edit in many places says itself: "Changed border from 1px --line to .5px --line-strong in 24 places".
    if (g.idx.length >= 2 && reasons.has('same edit')) {
      const sig = [...editSigs].find(([, is]) => g.idx.every((i) => is.includes(i)) || is.filter((i) => g.idx.includes(i)).length >= g.idx.length * 0.8)?.[0];
      if (sig) {
        const [out, inn] = sig.split(' | ').map((side) => side.split(' ').filter(Boolean).map((t) => t.slice(1).replace(/^--/, '')).filter((t) => !/^[^\w-]$/.test(t)).join(' '));
        const props = new Map();
        for (const i of g.idx) for (const l of (files[i].diff || '').split('\n')) if (l[0] === '+') for (const m of l.matchAll(/([a-z-]+)\s*:[^;:]*?(?=;|}|$)/g)) if (inn.split(' ').some((t) => t && new RegExp(`(^|[\\s:(,'"])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[\\s;,)'"]|$)`).test(m[0]))) props.set(m[1], (props.get(m[1]) || 0) + 1);
        const most = Math.max(0, ...props.values());
        const names = [...props].filter(([, c]) => c >= most * 0.3).map(([x]) => x);
        let prop = names.length === 1 ? names[0] : '';
        if (names.length > 1) { const head = names.map((x) => x.split('-')[0]); if (head.every((x) => x === head[0])) prop = head[0]; }
        if (out && inn && out.length <= 32 && inn.length <= 32) {
          // A custom property reads as words: --font-body -> body font.
          // A property reads as words too (font-weight -> font weight), and a number says which way it went:
          // "Increased font weight from 500 to 600 in 25 places".
          const said = prop.startsWith('--') ? (([a, ...b]) => (/^(font|color|colour|space|spacing|radius|shadow|size|weight|line)$/.test(a) && b.length ? [...b, a] : [a, ...b]).join(' '))(prop.slice(2).split('-')) : prop.replace(/-/g, ' ');
          const num = (v) => (/^-?\d*\.?\d+(px|rem|em|%)?$/.test(v) ? parseFloat(v) : null);
          const way = said && num(out) != null && num(inn) != null && num(out) !== num(inn) ? (num(inn) > num(out) ? 'Increased' : 'Reduced') : 'Changed';
          // Words in quotes that changed everywhere are a rename, said in their own order:
          // 'Commit Compass' -> 'staged engine' is Renamed “Commit Compass” to “staged engine”.
          const quoted = (sign, toks) => {
            const want = toks.split(' ').sort().join(' ');
            for (const i of g.idx) for (const l of (files[i].diff || '').split('\n')) if (l[0] === sign) for (const m of l.matchAll(/(["'`])([A-Za-z][\w ]{2,40}?)\1/g)) if (m[2].split(/\s+/).sort().join(' ') === want) return m[2];
            return '';
          };
          const qa = !g.idx.some((i) => /\.(s?css|less|sass|styl)$/i.test(files[i].path)) && /[a-z]{3}/i.test(out) && /[a-z]{3}/i.test(inn) && num(out) == null ? quoted('-', out) : '', qb = qa ? quoted('+', inn) : '';
          const gm = qa && qb ? `Renamed “${qa}” to “${qb}”${g.idx.length > 2 ? ` in ${g.idx.length} places` : ''}` : `${way} ${said ? said + ' ' : ''}from ${out} to ${inn} in ${g.idx.length} places`;
          Object.assign(msg, { type: 'style', emoji: '💄', gitmoji: gm, conventional: (msg.conventional?.match(/^([a-z]+(?:\([^)]*\))?!?: )/)?.[1] || '') + gm[0].toLowerCase() + gm.slice(1).replace(/^renamed /, 'rename ').replace(/^changed /, 'change ').replace(/^increased /, 'increase ').replace(/^reduced /, 'reduce ') });
        }
      }
    }
    // A function that gained options: toast(msg) -> toast(msg, { action, onAction, ms }).
    if (plain && fs_.length === 1 && /^(Updated|Refined|Tidied) /.test(msg.gitmoji)) {
      const d = fs_[0].diff || '', sigRe = /^([-+])\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/gm;
      const before = new Map(), after = new Map();
      for (const m of d.matchAll(sigRe)) (m[1] === '-' ? before : after).set(m[2], m[3]);
      for (const [fn, args] of after) {
        if (!before.has(fn)) continue;
        const names = (s2) => new Set([...s2.matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => m[0]));
        const was = names(before.get(fn)), gained = [...names(args)].filter((x) => !was.has(x) && !/^(true|false|null|undefined)$/.test(x));
        if (!gained.length || !featureName(fn)) continue; // "a timeout option to bounded" names no function
        const what = featureName(gained[0]) || gained[0];
        const gm = `Added ${/^[aeiou]/.test(what) ? 'an' : 'a'} ${what} option to ${featureName(fn) || fn}`;
        Object.assign(msg, { type: 'feat', emoji: '✨', gitmoji: gm, conventional: (msg.conventional?.match(/^([a-z]+(?:\([^)]*\))?!?: )/)?.[1] || '') + 'add ' + gm.slice(6) });
        break;
      }
    }
    // Mostly taking things out: the section heading you wrote over what left says what it was
    // ("/* ---- Settings › AI: engine picker and its panel ---- */" -> "Removed the AI engine picker and its panel").
    {
      const add = fs_.reduce((s2, f) => s2 + f.add, 0), del = fs_.reduce((s2, f) => s2 + f.del, 0);
      if (del >= 20 && del >= add * 3) {
        const heads = [];
        for (const f of fs_) for (const l of (f.diff || '').split('\n')) {
          const m = l.match(/^-\s*(?:\/\/+|\/\*+|#+|<!--)\s*[-=*#~]{3,}\s*(.+?)\s*[-=*#~]{3,}\s*(?:\*+\/|-->)?\s*$/);
          if (m) heads.push(m[1].replace(/^.*\s[›»>]\s/, '').replace(/:\s+/, ' ').replace(/[.:]$/, ''));
        }
        const head = heads.filter((h) => h.split(' ').length >= 2 && h.length <= 56 && !/[`(){}=<>\[\]]/.test(h)).sort((a, b) => b.length - a.length)[0];
        if (head) {
          const gm = `Removed ${/^(a|an|the|its|our|my)\s/i.test(head) ? '' : 'the '}${head}`;
          // Conventional commits have no "remove" type: taking a feature out is a refactor, shown with 🔥.
          Object.assign(msg, { type: 'refactor', emoji: learn.emojiForType?.remove || '🔥', gitmoji: gm, conventional: 'remove ' + gm.slice(8) });
        }
      }
    }
    // A subject built only from a code name or a function's name ("Simplified closed repos", "Updated
    // updater") gives way to what the diff itself says it does.
    if (msg.fromIdent || weakSubject(msg.gitmoji) || /^(Handled errors in|Updated) [\w .-]+$/.test(msg.gitmoji) && msg.gitmoji !== 'Updated dependencies') {
      const said = storyOf(fs_);
      if (said) Object.assign(msg, { gitmoji: said, conventional: (msg.conventional?.match(/^([a-z]+(?:\([^)]*\))?!?: )/)?.[1] || '') + toImperative(said).replace(/^\w/, (c) => c.toLowerCase()) });
    }
    delete msg.fromIdent;
    // In-house intent reader for subjects that still say little. No model: it reads what the change
    // itself says, a new file's opening comment or the request fields a handler starts accepting.
    if (weakSubject(msg.gitmoji)) {
      const said = readIntent(fs_) || recordsSubject(fs_) || configSubject(fs_) || (fs_.some((f) => f.status === 'A' && !isAsset(kindOf(f.path))) ? '' : metaSubject(fs_)); // a new page's own meta tags are not its story
      if (said) Object.assign(msg, { gitmoji: said, conventional: (msg.conventional?.match(/^([a-z]+(?:\([^)]*\))?!?: )/)?.[1] || '') + said[0].toLowerCase() + said.slice(1) });
    }
    // A weak subject borrows the user's own words for this part of the code: past commits that
    // touched the same files, when two of them agree on a phrase ("repo list", "sheet").
    if (Array.isArray(learn.history) && learn.history.length && weakSubject(msg.gitmoji)) {
      const changed = fs_.map((f) => (f.diff || '').split('\n').filter((l) => /^[-+@]/.test(l)).join('\n')).join('\n').toLowerCase();
      const phrase = pastPhrase(learn.history, [...new Set(fs_.map((f) => f.path))], (w) => changed.includes(w.slice(0, Math.max(4, w.length - 2))));
      if (phrase) {
        const gm = `Updated ${phrase}`;
        Object.assign(msg, { gitmoji: gm, conventional: (msg.conventional?.match(/^([a-z]+(?:\([^)]*\))?!?: )/)?.[1] || '') + 'update ' + phrase });
      }
    }
    // A bare name says what kind of thing it is, read from where its file lives: pages/now.md is the now
    // page, _includes/about/desk.html a section, vercel.json a config: "Updated now" -> "Updated the now page".
    {
      const m = msg.gitmoji.match(/^(Added|Updated|Removed|Simplified) ([\w.-]+)$/);
      const kindAt = (p) => (/(^|\/)_?pages?\/[^/]+\.(html?|md|markdown)$/i.test(p) || /^[^/]+\.html?$/i.test(p)) && !/^index$/i.test(m[2]) ? ' page'
        : /(^|\/)_layouts\//.test(p) ? ' layout' : /(^|\/)_?(includes|partials|components)\//.test(p) ? ' section'
        : ['config', 'data'].includes(kindOf(p)) && !/\//.test(p) ? ' config' : '';
      const named = m ? fs_.filter((x) => stemOf(x.path) === m[2].toLowerCase()) : [];
      const kind = named.length && !/^(dependencies|package)$/.test(m[2]) ? (named.map((x) => kindAt(x.path)).find(Boolean) || '').replace(new RegExp(`^ ${m[2]}$`, 'i'), '') : '';
      if (kind) {
        const gm = `${m[1]} the ${m[2].toLowerCase()}${kind}`;
        Object.assign(msg, { gitmoji: gm, conventional: (msg.conventional?.match(/^([a-z]+(?:\([^)]*\))?!?: )/)?.[1] || '') + (TO_IMP[m[1]] || m[1]).toLowerCase() + gm.slice(m[1].length) });
      }
    }
    // Conventional subjects are imperative whatever path wrote them: "change border", "turn Today into Home".
    if (msg.conventional) msg.conventional = msg.conventional.replace(/^((?:[a-z]+(?:\([^)]*\))?!?: )?)([a-z]+)\b/, (m, pre, w) => { const imp = TO_IMP[w[0].toUpperCase() + w.slice(1)]; return pre + (imp ? imp.toLowerCase() : w); });
    // "Added Akt font for fonts" says the same thing twice.
    msg.gitmoji = msg.gitmoji.replace(/\b(\w{3,}) for (?:the )?\1s$/i, '$1');
    if (learn.tense === 'imperative') msg.gitmoji = toImperative(msg.gitmoji);
    return {
      id: 'g' + (k + 1), ...(g.at != null ? { fixedAt: g.at } : {}),
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
  };
  let out = groups.map(build);
  // Pieces of one file that read the same ("Refined colours and shadows" three times in styles.css)
  // found nothing to tell them apart: people commit those as one change, so they become one.
  if (!Array.isArray(learn.fixed)) {
    // Nameless style touch-ups in one stylesheet ("Refined spacing and layout") count as the same too.
    const nameless = (o) => /\.(s?css|less)$/i.test(o.files[0]) && /^Refined (styles|((colours|spacing|layout|type|animations|corners|shadows)( and |, )?)+)$/.test(o.gitmoji);
    const key = (o) => (new Set(o.files).size === 1 ? o.files[0] + '\0' + (nameless(o) ? 'refined' : o.gitmoji) : '');
    const seen = new Map();
    groups.forEach((g, k) => { const s = key(out[k]); if (!s) return; if (!seen.has(s)) seen.set(s, []); seen.get(s).push(k); });
    const twins = [...seen.values()].filter((ks) => ks.length > 1);
    if (twins.length) {
      const drop = new Set(twins.flatMap((ks) => ks.slice(1)));
      for (const ks of twins) groups[ks[0]] = { ...groups[ks[0]], idx: ks.flatMap((k) => groups[k].idx) };
      groups = groups.filter((_, k) => !drop.has(k));
      out = groups.map(build);
    }
  }
  return out.sort((a, b) => b.size - a.size);
}


// What a change says about itself, read without any model.
// Sentences from the comments written with a change: consecutive "+ // ..." lines read as one block.
function addedComments(fs_) {
  const out = [];
  for (const f of fs_) {
    let cur = [];
    const done = () => { if (cur.length) out.push(...cur.join(' ').replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/)); cur = []; };
    for (const l of (f.diff || '').split('\n')) {
      const c = l[0] === '+' && !l.startsWith('+++') ? l.slice(1).trim().match(/^(?:\/\/+|\/\*+|\*(?!\/)|#(?![{!\w]))\s*(.*?)\s*(?:\*+\/)?$/) : null;
      if (c) cur.push(c[1]); else done();
    }
    done();
  }
  return out.map((s) => s.replace(/[.!?:]+$/, '').trim()).filter((s) => s.length >= 8 && !/[`{}=<>\[\]]/.test(s));
}
// "every tag shows up as a release" -> "every tag show up as a release", for "Made ..." subjects.
const baseVerb = (w) => /(ss|sh|ch|x|o)es$/.test(w) ? w.slice(0, -2) : /ies$/.test(w) ? w.slice(0, -3) + 'y' : /[^s]s$/.test(w) ? w.slice(0, -1) : w;
// What a change does, read from the diff itself when its name came only from code: the comment's
// purpose, a rule that moved, Markdown no longer stripped, one piece of state swapped for another.
function storyOf(fs_) {
  const says = addedComments(fs_);
  for (const s of says) {
    // "Pushing happens in the side panel (hold to push)" -> Moved pushing to the side panel.
    const mv = s.replace(/\s*\([^)]*\)/g, '').match(/^([A-Z][a-z]+ing(?: [a-z]+){0,2}) (?:now )?(?:happens|lives|runs) (?:in|on) (the [a-z]+(?: [a-z]+)?)$/);
    if (mv) return `Moved ${mv[1].toLowerCase()} to ${mv[2]}`;
  }
  for (const s of says) {
    // "That way every tag shows up as a release" -> Made every tag show up as a release.
    const tw = s.match(/^(?:that|this) way,?\s+((?:every|each|the|a|an|all|any) [a-z]+(?: [a-z]+)?) ([a-z]+s) ([^,;—()]{3,40})$/i);
    if (tw && !/^(is|has|was|does)$/.test(tw[2])) { const gm = `Made ${tw[1].toLowerCase()} ${baseVerb(tw[2])} ${tw[3]}`; if (gm.length <= 64) return gm; }
    // "Releases always show every release, so ..." -> Made releases always show every release.
    const pl = s.match(/^([A-Z][a-z]{3,}s) (always|never|only|now) ([a-z]+ [^,;—()]{3,40}?)(?:,|$)/);
    if (pl && !/(ss|us|is)$/.test(pl[1]) && !/^(Always|Perhaps|Sometimes|Unless|Whereas|Besides|Otherwise|Thus)$/.test(pl[1]) && !/^(is|are|has|have|was|were|does)\b/.test(pl[3])) { const gm = `Made ${pl[1].toLowerCase()} ${pl[2]} ${pl[3]}`; if (gm.length <= 64) return gm; }
  }
  const lines = fs_.flatMap((f) => (f.diff || '').split('\n'));
  const plus = lines.filter((l) => l[0] === '+' && !l.startsWith('+++')), minus = lines.filter((l) => l[0] === '-' && !l.startsWith('---'));
  // A .replace() chain that strips Markdown (headings, **bold**) going or coming: Stopped stripping
  // Markdown from release notes. Without a noun nearby, the file's own name says where.
  const MD = /\.replace\(\/(?:\^#\+|\\\*\\\*|\\\[|`)[^/]*\/[gmi]*\s*,\s*(['"`])\1\)/g;
  const mdIn = (ls) => ls.reduce((n, l) => n + (l.match(MD) || []).length, 0);
  const mdGone = mdIn(minus) - mdIn(plus);
  if (mdGone) {
    const near = lines.join(' ').toLowerCase();
    const nouns = { release: 'release notes', commit: 'commit messages', issue: 'issues', comment: 'comments', post: 'posts', message: 'messages', readme: 'the readme', changelog: 'the changelog' };
    const hit = Object.keys(nouns).map((n) => [n, (near.match(new RegExp(`\\b${n}s?\\b`, 'g')) || []).length]).filter(([, c]) => c).sort((a, b) => b[1] - a[1])[0];
    const stem = fs_.length === 1 ? nameOf(fs_[0].path).toLowerCase() : '';
    const what = hit ? nouns[hit[0]] : stem && !WEAK_STEMS.has(stem) ? `the ${stem}` : '';
    if (what) return mdGone > 0 ? `Stopped stripping Markdown from ${what}` : `Stripped Markdown from ${what}`;
  }
  // One piece of state taken out and another put in its place on the same object (cs.banner gone,
  // cs.panel new): Replaced the banner with the panel.
  {
    const props = (ls) => { const m = new Map(); for (const l of ls) for (const x of new Set([...l.matchAll(/\b([a-z]\w*)\.([a-z][a-z]{3,})\b(?!\s*\()/g)].map((y) => y[1] + '.' + y[2]))) m.set(x, (m.get(x) || 0) + 1); return m; };
    const was = props(minus), now = props(plus);
    const only = (a, b) => [...a].filter(([x]) => !b.has(x)).sort((p, q) => q[1] - p[1]);
    const gone = only(was, now), came = only(now, was);
    for (const [x, n] of gone.slice(0, 1)) {
      const obj = x.split('.')[0];
      const mine = came.filter(([y]) => y.startsWith(obj + '.'));
      const gone2 = gone.filter(([y]) => y.startsWith(obj + '.'));
      if (n < 3 || !mine.length || mine[0][1] < 3 || (mine[1] && mine[1][1] * 1.5 > mine[0][1]) || (gone2[1] && gone2[1][1] * 1.5 > n)) break;
      const a = featureName(x.split('.')[1]), b = featureName(mine[0][0].split('.')[1]);
      if (a && b && !/\s/.test(a + b)) return `Replaced the ${a} with the ${b}`;
    }
  }
  // A modifier class put on every mapped item but the first: class="area${i ? ' is-more' : ''}".
  for (const l of plus) {
    const m = l.match(/class="([a-z][\w-]*)\$\{\s*i\s*\?\s*'\s*(?:is|has)-([a-z]+)'\s*:\s*''\s*\}"/);
    if (m && /\.map\(\(\w+,\s*i\)/.test(l) && !minus.some((x) => x.includes(`'${m[0].split("'")[1]}'`))) { const item = m[1].replace(/^[a-z]{1,2}-(?=[a-z]{3})/, '').replace(/[-_]+/g, ' '); return `Marked every ${item} after the first as “${m[2]}”`; }
  }
  return '';
}

// A YAML settings file says which settings moved, key by key: "analytics: enabled: true -> false" is
// "Turned off analytics", a new "umami:" block is "Added umami settings". Top-level keys of a site
// config (_config.yml) are the site's: "role" -> "site role".
function configSubject(fs_) {
  const facts = [];
  for (const f of fs_) {
    if (!/\.ya?ml$/i.test(f.path) || collectionOf(f.path) || /(^|\/)(pnpm-lock|\.github\/|docker-compose)/i.test(f.path)) continue;
    // A list of records (- title: ..., url: ...) is data, not settings.
    if (/^\+\s*-\s+[\w-]+\s*:/m.test(f.diff || '')) continue;
    const site = /(^|\/)_?config\.ya?ml$/i.test(f.path);
    const seen = { '+': new Map(), '-': new Map() };
    const stack = { '+': [], '-': [] };
    for (const l of (f.diff || '').split('\n')) {
      if (l.startsWith('@@')) { stack['+'] = []; stack['-'] = []; continue; }
      if (/^(\+\+\+|---)/.test(l) || !/^[ +-]/.test(l)) continue;
      const m = l.slice(1).match(/^(\s*)([A-Za-z][\w -]*?)\s*:(?:\s+(.*?))?\s*(?:#.*)?$/);
      if (!m || /^\s*#/.test(l.slice(1))) continue;
      const depth = m[1].length, val = (m[3] || '').replace(/^["']|["']$/g, '').trim();
      for (const side of l[0] === ' ' ? ['+', '-'] : [l[0]]) {
        const st = stack[side];
        while (st.length && st.at(-1).depth >= depth) st.pop();
        const keyPath = [...st.map((x) => x.key), m[2]];
        st.push({ depth, key: m[2] });
        if (l[0] !== ' ') seen[side].set(keyPath.join('.'), { keyPath, val, section: !m[3] });
      }
    }
    // A setting is named with the block it sits in (author gravatar, google tracking id); a lone word reads as a setting.
    const name = (kp, leaf = true) => {
      const ws = kp.map((k) => k.replace(/[-_]+/g, ' ').toLowerCase());
      const out = site && kp.length === 1 && leaf ? 'site ' + ws[0] : ws.slice(-2).join(' ');
      return out.includes(' ') ? out : out + ' setting';
    };
    const addedSections = [...seen['+']].filter(([k, x]) => x.section && !seen['-'].has(k)).map(([k]) => k);
    const under = (k) => addedSections.some((s2) => k !== s2 && k.startsWith(s2 + '.'));
    for (const [k, x] of seen['+']) {
      if (under(k)) continue;
      const was = seen['-'].get(k);
      if (!was) facts.push(x.section ? { verb: 'Added', text: `${name(x.keyPath.slice(-1), false).replace(/ setting$/, '')} settings` } : { verb: 'Added', text: name(x.keyPath) });
      else if (was.val === x.val) continue;
      else if (/^(true|yes|on)$/i.test(was.val) && /^(false|no|off)$/i.test(x.val)) facts.push({ verb: 'Turned off', text: x.keyPath.length >= 2 && /^enabled?$/.test(x.keyPath.at(-1)) ? name(x.keyPath.slice(0, -1), false).replace(/ setting$/, '') : name(x.keyPath) });
      else if (/^(false|no|off)$/i.test(was.val) && /^(true|yes|on)$/i.test(x.val)) facts.push({ verb: 'Turned on', text: x.keyPath.length >= 2 && /^enabled?$/.test(x.keyPath.at(-1)) ? name(x.keyPath.slice(0, -1), false).replace(/ setting$/, '') : name(x.keyPath) });
      else if (was.val && !x.val) facts.push({ verb: 'Cleared', text: name(x.keyPath) });
      else facts.push({ verb: 'Changed', text: name(x.keyPath) });
    }
    for (const [k, x] of seen['-']) if (!seen['+'].has(k) && !x.section && ![...seen['-'].keys()].some((s2) => k.startsWith(s2 + '.') && seen['-'].get(s2).section)) facts.push({ verb: 'Removed', text: name(x.keyPath) });
  }
  if (!facts.length || facts.length > 3) return '';
  const [a, b] = facts;
  const gm = !b ? `${a.verb} ${a.text}` : a.verb === b.verb ? `${a.verb} ${a.text} and ${b.text}` : `${a.verb} ${a.text} and ${b.verb.toLowerCase()} ${b.text}`;
  return gm.length <= 64 && gm.split(' ').length >= 3 ? gm : '';
}

// A YAML list of records that only gained entries is named by what it lists: _data/visuals.yml with two
// new "- name:" items is "Added 2 visuals", not "Updated 63".
function recordsSubject(fs_) {
  const lists = fs_.filter((f) => /\.ya?ml$/i.test(f.path));
  if (lists.length !== 1) return '';
  const d = lists[0].diff || '';
  const came = (d.match(/^\+-\s+[\w-]+\s*:/gm) || []).length, went = (d.match(/^--\s+[\w-]+\s*:/gm) || []).length;
  if (!came || went || /^-(?!--)/m.test(d)) return '';
  const what = stemOf(lists[0].path).replace(/[-_]+/g, ' ').toLowerCase();
  if (!/^[a-z]+( [a-z]+)?$/.test(what) || /^(config|settings|data|site|index)$/.test(what)) return '';
  const many = what.endsWith('s') ? what : what + 's', one = what.replace(/s$/, '');
  return came === 1 ? `Added a new ${one}` : `Added ${came} ${many}`;
}

// A page head that gained or lost meta tags says which: <meta name="theme-color"> gone is "Removed the
// theme color meta tag"; og:* and twitter:* tags are the Open Graph and Twitter card tags.
function metaSubject(fs_) {
  const names = (sign) => [...new Set(fs_.flatMap((f) => (f.diff || '').split('\n').filter((l) => l[0] === sign).flatMap((l) => [...l.slice(1).matchAll(/<meta\s+(?:name|property)="([\w:.-]+)"/g)].map((m) => m[1]))))];
  const plus = names('+'), minus = names('-');
  const came = plus.filter((x) => !minus.includes(x)), went = minus.filter((x) => !plus.includes(x));
  const say = (xs) => [...new Set(xs.map((x) => (/^og:/.test(x) ? 'Open Graph' : /^twitter:/.test(x) ? 'Twitter card' : x.replace(/[-_:.]+/g, ' '))))];
  const tags = (xs) => { const ws = say(xs); return ws.length <= 2 ? `the ${ws.join(' and ')} meta tag${xs.length > 1 ? 's' : ''}` : ''; };
  if (went.length && !came.length && tags(went)) return `Removed ${tags(went)}`;
  if (came.length && !went.length && tags(came)) return `Added ${tags(came)}`;
  return '';
}

// New tests and tool configs that came along with a bigger change (most of the lines are elsewhere)
// support it; they are not what the commit is about.
const isTestPath = (p) => /(^|\/)(tests?|spec|__tests__)\/|[._-](test|spec)\.[cm]?[jt]sx?$|(^|\/)test[-_][\w-]+\.[cm]?[jt]s$|(^|\/)test_[\w]+\.py$/i.test(p);
function supportFile(f, fs_) {
  if (!isTestPath(f.path) && !/(^|\/)([\w-]+\.config\.[cm]?[jt]s|\.[\w-]+rc(\.\w+)?)$/.test(f.path)) return false;
  const total = fs_.reduce((s2, x) => s2 + (x.add || 0) + (x.del || 0), 0);
  // Tests count together with their fixtures: test/engine.test.mjs and test/fixtures/*.json.
  const own = isTestPath(f.path) ? fs_.filter((x) => isTestPath(x.path)).reduce((s2, x) => s2 + (x.add || 0), 0) : (f.add || 0);
  return own * 2 < total;
}
function readIntent(fs_) {
  // A new file that opens with a sentence about itself: "X uses deterministic local rules for ..."
  if (fs_.length === 1 && (fs_[0].status === 'A' || fs_[0].untracked) && fs_[0].content) {
    const head = [];
    for (const l of fs_[0].content.split('\n').slice(0, 8)) { const t = l.trim(); if (!/^(\/\/|\/\*|\*|#(?![{!]))/.test(t)) break; head.push(t.replace(/^(\/\/+|\/\*+|\*+|#+)\s*/, '').replace(/\s*\*+\/\s*$/, '')); }
    const first = head.join(' ').replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s/)[0].replace(/[.!?:]$/, '');
    const m = first.match(/^(.{3,40}?)\s(uses|provides|adds|holds|keeps|handles|runs|draws|renders|shows|builds|writes|reads|turns|tracks|wraps)\s(.{6,70})$/i);
    if (m && !/[`(){}=<>\[\]]/.test(first)) {
      const obj = m[3].replace(/\s(so|because|since|but|when|while)\s.*$/i, '');
      const gm = /^(uses|provides|adds|holds)$/i.test(m[2]) ? `Added ${obj}` : `Added ${m[1][0].toLowerCase() + m[1].slice(1)} that ${m[2].toLowerCase()} ${obj}`;
      if (gm.length <= 72) return gm;
    }
  }
  // A handler that starts accepting new request fields: body.togetherPairs, searchParams.get('since').
  // The route the handler serves (sub === '/learn', app.post('/learn')) says where better than the
  // function around all the routes: "in the learn route", not "in commit routes".
  const fresh = [], seen = new Set(), ctx = new Set(), routes = new Set();
  for (const f of fs_) {
    const lines = (f.diff || '').split('\n');
    const old = lines.filter((l) => l[0] !== '+').join('\n');
    const h = lines.find((l) => l.startsWith('@@'))?.match(/@@[^@]*@@\s*(?:export\s+)?(?:async\s+)?(?:function\s+)?([A-Za-z_$][\w$]*)/)?.[1];
    let route = '', end = -1;
    for (const l of lines) {
      // A hunk that starts right where the last one ended (a line or two apart) is still in its route.
      const at = l.startsWith('@@') && l.match(/^@@ -(\d+)(?:,(\d+))?/);
      if (at) { if (+at[1] - end > 3) route = ''; end = +at[1] + +(at[2] ?? 1); }
      const r = l.slice(1).match(/(?:===?\s*|\.(?:get|post|put|patch|delete)\(\s*)['"]\/(?:api\/)?([a-z][\w-]*(?:\/[a-z][\w-]*)*)['"]/);
      if (r && l[0] !== '-') route = r[1].split('/').pop();
      if (l[0] === '+') for (const m of l.slice(1).matchAll(/\bbody\.([a-z][\w$]*)|searchParams\.get\(\s*['"]([\w-]+)['"]/g)) {
      const x = m[1] || m[2];
      if (/^(body|data|value|values|id|name|type|text|options|opts|params|payload|input|args|result)$/.test(x)) continue;
      if (seen.has(x) || new RegExp(`\\bbody\\.${x}\\b|['"]${x}['"]`).test(old)) continue;
      seen.add(x); fresh.push(x); if (h) ctx.add(h); routes.add(route);
    }
    }
  }
  if (fresh.length && fresh.length <= 3) {
    const words = fresh.map((x) => x.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(' '));
    const tail = words.every((w) => w.length >= 2 && w.at(-1) === words[0].at(-1)) ? words[0].at(-1) : '';
    const named = tail ? list(words.map((w) => w.slice(0, -1).join(' '))) + ' ' + tail : list(words.map((w) => w.join(' ')));
    const where = routes.size === 1 && [...routes][0] ? ` in the ${[...routes][0].replace(/[-_]+/g, ' ')} route` : ctx.size === 1 ? ' in ' + [...ctx][0].replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase() : '';
    return `Accepted ${named}${where}`;
  }
  return '';
}

// Subjects that say little: a bare file name, "Updated x in y", copy fallbacks, generic style passes.
const weakSubject = (s) => !/^Updated dependencies$/.test(s) && /^(Added|Updated|Refined|Tidied) [\w.-]+$|^Updated [\w .-]+ in [\w.-]+$|^Refined styles\b|^Tidied\b|^Updated [\w .-]+ markup$/.test(s);
const PAST_STOP = new Set('a an the and or of to for in on with by from into at as is are be this that its it our your their new more some all files file across styles style code logic page pages ui app minor small various changes update updates improvements improvement tweaks fixes bump bumps version versions dependency dependencies issues issue'.split(' '));
const PAST_VERB = /^(added|updated|refined|fixed|removed|improved|enhanced|changed|reworked|refactored|tweaked|polished|cleaned|made|moved|renamed|replaced|implemented|created|simplified|tidied|adjusted|restyled|wrote|tracked|bumped|increased|reduced|add|update|refine|fix|remove|improve|enhance|change|rework|refactor|tweak|polish|clean|make|move|rename|replace|implement|create|simplify|adjust)$/i;
function pastPhrase(history, paths, inDiff = () => true) {
  const near = history.filter((c) => c && c.subject && Array.isArray(c.files) && paths.every((p) => c.files.includes(p)) && c.files.length <= paths.length + 4).slice(0, 20);
  if (near.length < 2) return '';
  const fileWords = new Set(near.flatMap((c) => c.files).flatMap((p) => { const b = p.split('/').pop().toLowerCase(); return [b.replace(/[^a-z]/g, ''), b.split('.')[0]]; }));
  for (const p of paths) fileWords.delete(nameOf(p).toLowerCase());
  const grams = (subj) => {
    const ws = subj.replace(/^\S*\p{Extended_Pictographic}\S*\s*/u, '').replace(/^[a-z]+(\([^)]*\))?!?:\s*/, '').split(/[^\p{L}\p{N}-]+/u).filter(Boolean);
    const out = new Set();
    for (let i = 0; i < ws.length; i++) {
      const a = ws[i].toLowerCase(), b = (ws[i + 1] || '').toLowerCase();
      if (PAST_VERB.test(a)) continue;
      const ok = (w) => w.length >= 3 && !PAST_STOP.has(w) && !/\d/.test(w) && !fileWords.has(w);
      if (ok(a)) {
        if (b && ok(b) && !PAST_VERB.test(b)) out.add(a + ' ' + b);
        out.add(a);
      }
    }
    return out;
  };
  const seen = new Map();
  near.forEach((c, at) => { for (const g of grams(c.subject)) { const e = seen.get(g) || { n: 0, at }; e.n++; seen.set(g, e); } });
  const best = [...seen].filter(([g, e]) => e.n >= 2 && g.includes(" ") && g.split(' ').every(inDiff) && !paths.some((p) => g === nameOf(p).toLowerCase()))
    .sort((a, b) => (b[0].includes(' ') - a[0].includes(' ')) || b[1].n - a[1].n || a[1].at - b[1].at)[0];
  return best ? 'the ' + best[0] : '';
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
const TO_IMP = { Added: 'Add', Fixed: 'Fix', Updated: 'Update', Removed: 'Remove', Refined: 'Refine', Polished: 'Polish', Renamed: 'Rename', Moved: 'Move', Improved: 'Improve', Changed: 'Change', Created: 'Create', Deleted: 'Delete', Cleaned: 'Clean', Made: 'Make', Tweaked: 'Tweak', Replaced: 'Replace', Restyled: 'Restyle', Reworked: 'Rework', Wrote: 'Write', Increased: 'Increase', Reduced: 'Reduce', Bumped: 'Bump', Tidied: 'Tidy', Simplified: 'Simplify', Wired: 'Wire', Hooked: 'Hook', Turned: 'Turn', Grouped: 'Group', Accepted: 'Accept', Marked: 'Mark', Kept: 'Keep', Stripped: 'Strip', Stopped: 'Stop' };
export const toImperative = (s) => s
  .replace(/^[A-Z][a-z]+/, (w) => TO_IMP[w] || w)
  .replace(/(\band |, )([a-z]+ed|wrote|made)\b/g, (m, pre, w) => { const k = w[0].toUpperCase() + w.slice(1); return TO_IMP[k] ? pre + TO_IMP[k].toLowerCase() : m; });

function messageFor(fs_, label, tweaks, verbs, tense, emojiForType) {
  const m = messageForPast(fs_, label, tweaks, verbs, emojiForType);
  if (tense === 'imperative') m.gitmoji = toImperative(m.gitmoji);
  return m;
}

const WEAK_CONTEXTS = new Set(['load', 'render', 'draw', 'handle', 'onclick', 'onchange', 'init', 'update', 'main', 'index', 'constructor', 'anonymous', 'default', 'exports']);
// Short words a person would write; anything else that short is code shorthand (pkg, cfg, el).
const SHORT_OK = new Set('ui ux qr id os ai db on in up to by of at go do no it or as be app tab row key map box bar log tag url api css svg all new set get add top end day run git and for the out off one two few its use'.split(' '));
function usefulContexts(f) {
  return [...new Set(contextsOf(f))].filter((name) => !WEAK_CONTEXTS.has(name.toLowerCase()) && name.toLowerCase().split(/\s+/).every((w) => w.length > 3 || SHORT_OK.has(w))).slice(0, 2);
}
function visibleCopy(f) {
  const added = [], removed = [];
  for (const line of (f.diff || '').split('\n')) {
    if (!/^[+-]/.test(line) || /^(\+\+\+|---)/.test(line)) continue;
    const target = line[0] === '+' ? added : removed, text = line.slice(1);
    const add = (value) => {
      const clean = value.replace(/&(?:amp|lt|gt|quot|#39);/g, ' ').replace(/\s+/g, ' ').trim();
      // Words people read, not code that happens to sit between > and < (a.length > 0 && b < 2).
      if (clean.length >= 4 && clean.length <= 88 && /[A-Za-z]{2}/.test(clean) && !/[=&|(){};$\[\]]|=>|\w\.\w|^--|:\s*['"]/.test(clean) && (clean.match(/[\p{L}\s]/gu) || []).length >= clean.length * 0.75 && (/\s/.test(clean) || /^\p{Lu}/u.test(clean)) && /[A-Za-z]{3}/.test(clean) && !/(^|\s)[b-hj-z](\s|$)|\s[-+*/]\s|…$|^\p{Extended_Pictographic}/u.test(clean) && !target.includes(clean)) target.push(clean);
    };
    for (const m of text.matchAll(/>([^<>]{3,88})</g)) add(m[1]);
    for (const m of text.matchAll(/(?:aria-label|placeholder|title|textContent|innerText)\s*=\s*(["'`])([^"'`]{3,88})\1/g)) add(m[2]);
    for (const m of text.matchAll(/(?:toast|confirmDialog|alert)\s*\(\s*(["'`])([^"'`]{3,88})\1/g)) add(m[2]);
  }
  // Text that is only moved or re-wrapped is not a wording change.
  const same = new Set(added.filter((x) => removed.includes(x)));
  added.splice(0, added.length, ...added.filter((x) => !same.has(x)));
  removed.splice(0, removed.length, ...removed.filter((x) => !same.has(x)));
  // Said the way a person would: Changed “Push” to “Hold to push”, Added “Cart” and “Save image”.
  const fits = (x) => x.length <= 40;
  const two = (xs) => { const ys = xs.filter(fits).slice(0, 2); return ys.length ? ys.map((x) => `“${x}”`).join(' and ') : ''; };
  if (added.length === 1 && removed.length === 1 && fits(added[0]) && fits(removed[0])) return `Changed “${removed[0]}” to “${added[0]}”`;
  if (added.length && two(added)) return `Added ${two(added)}`;
  if (removed.length && two(removed)) return `Removed ${two(removed)}`;
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
  const cssLine = onlyStyles && !tweaks ? cssSubject(fs_) : '';
  const renamed = fs_.length === 1 && fs_[0].status === 'M' ? renameOf(fs_[0]) : null;
  const facts = fs_.flatMap(factsFor).sort((x, y) => y.w - x.w);
  // Names that only live inside a regex (\p{Extended_Pictographic}) are not things the change added.
  const inRegex = new Set(fs_.flatMap((f) => [...(f.diff || '').matchAll(/\\[pP]\{([\w=]+)\}/g)].map((m) => m[1].replace(/[_=]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase())));
  const said = facts.filter((x) => x.verb && !(x.text && inRegex.has(String(x.text).toLowerCase())));
  const intentNotes = facts.filter((x) => x.note).map((x) => x.note).join(' ');
  const fixNote = intentNotes.match(/\b(?:fix(?:es|ed)?|bug|broken|crash|regression|prevent(?:s|ed)?)\b[^.!?;]{0,100}/i)?.[0];
  const perfNote = intentNotes.match(/\b(?:performance|faster|speed(?:up)?|slow(?:er|down)?|optim(?:i|iz)(?:e|ed|ation))\b[^.!?;]{0,100}/i)?.[0];
  const copyChanges = fs_.map(visibleCopy).filter(Boolean);
  let fromHeader = false;
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
    const subject = /^changelog$/i.test(label) ? (action === 'Added' ? 'a changelog' : 'the changelog') : /^(readme|contributing|docs?)$/i.test(label) ? 'documentation' : label.toLowerCase();
    gm = `${action} ${subject}`;
  } else if (renamed) {
    // A view renamed in place: mountToday -> mountHome, "Today: ..." -> "Home: ...".
    type = 'feat'; emoji = '✨';
    gm = `Turned ${renamed[0]} into ${renamed[1]}`;
  } else if (copyChanges.length && fs_.length <= 2 && !added.some((f) => !isAsset(kindOf(f.path)) && !VENDOR.test(f.path) && f.add >= 20)) {
    type = kinds.every((k) => ['doc', 'text'].includes(k)) ? 'docs' : 'feat';
    emoji = type === 'docs' ? '📝' : '✨';
    gm = copyChanges[0];
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
  } else if (added.some((f) => !isAsset(kindOf(f.path))) && !tweaks && !added.filter((f) => !isAsset(kindOf(f.path))).every((f) => supportFile(f, fs_))) {
    // Something new: name the thing, not the files it touched.
    type = 'feat';
    // Someone else's code dropped in (a vendored library) is not what the change is about.
    const own = added.filter((f) => !isAsset(kindOf(f.path)) && !VENDOR.test(f.path));
    // New tests name the commit only when they are most of it: tests that came along with a bigger
    // change are not what it is about.
    const testsLead = (f) => isTestPath(f.path) && !supportFile(f, fs_);
    const fresh = (own.length ? own : added.filter((f) => !isAsset(kindOf(f.path)))).sort((x, y) => supportFile(x, fs_) - supportFile(y, fs_) || y.add - x.add);
    const many = added.length >= 3 && commonDir(added.map((f) => f.path)) && !own.some((f) => f.add >= 20);
    let thing = many ? label.toLowerCase() : thingFor(fresh[0], fs_);
    // A folder of new scripts says what they are: "Added 10 raycast scripts", not "Added raycast".
    if (many && !/\s/.test(thing) && added.length === fs_.length && added.every((f) => /\.(sh|bash|zsh|py|rb|pl|ps1|m?js|cjs|ts)$/.test(f.path)) && !/scripts?$/.test(thing)) thing = `${added.length} ${thing} scripts`;
    let about = many ? null : aboutOf(fresh[0], thing);
    // New tests are named for what they test: test/engine.test.mjs -> "engine tests".
    const testFile = own.find((f) => /(^|\/)[\w-]+\.(test|spec)\.[cm]?[jt]sx?$/.test(f.path) && (testsLead(f) || fs_.every((x) => x === f || x.add < f.add)));
    if (testFile && !many) { const stem = testFile.path.split('/').pop().replace(/\.(test|spec)\..*$/, '').replace(/[-_]+/g, ' '); about = { subject: `${stem} tests` }; type = 'test'; }
    // The first new file whose header says plainly what it is names the commit.
    if (!many && !about?.subject) for (const f of fresh.slice(1, 4).filter((x) => x.add * 2 >= fresh[0].add)) { const t = thingFor(f, fs_), a2 = aboutOf(f, t); if (a2?.subject) { thing = t; about = a2; break; } }
    // A header like "Tiny Markdown view for notes and changelogs: headings, lists, ..." names the thing before the colon.
    if (!many && !about?.subject) {
      const h = (fresh[0].content || '').split('\n').slice(0, 6).map((l) => l.trim()).find((l) => /^(\/\/|\/\*|\*|#)\s*\S/.test(l) && !/^#!/.test(l))?.replace(/^(\/\/+|\/\*+|\*+|#+)\s*/, '') || '';
      const pre = h.includes(': ') ? h.slice(0, h.indexOf(': ')) : '';
      if (pre && pre.split(' ').length >= 2 && pre.split(' ').length <= 8 && pre.length <= 58 && !/[`(){}=<>\[\]]/.test(pre)) about = { subject: pre };
    }
    // "Receipt image that turns a receipt or statement spec" lost its "into ...": keep just the name.
    if (about?.subject && /\sthat (turns|converts|maps|moves|changes|translates)\s/.test(about.subject) && !/\s(into|to)\s/.test(about.subject.split(' that ')[1])) about = { subject: about.subject.split(' that ')[0] };
    // A header that gives an order ("Test the production adapter ...", "Install / remove Claude Code
    // hooks ...") says what the new file is for: "Added a test for the production adapter ...". One that
    // asks a question ("Where Busy Lamp keeps its files") does not name it.
    if (about?.subject && /^(Where|What|How|When|Why|Which|Who)\b/.test(about.subject)) about = null;
    const opening = many ? "" : ((fresh[0]?.content || '').split('\n').slice(0, 4).map((l) => l.trim()).find((l) => /^("""|\'\'\'|\/\/|\/\*|\*|#(?!!))\s*\S/.test(l)) || '')
      .replace(/^("""|\'\'\'|\/\/+|\/\*+|\*+|#+)\s*/, '').replace(/("""|\'\'\'|\*\/)\s*$/, '').replace(/\s*\([^)]*\)/g, '').split(/[.;!?](?:\s|$)/)[0].trim();
    const ORDER = /^(Test|Check|Verify|Install|Prepare|Build|Run|Generate|Create|Make|Draw|Render|Read|Write|Sync|Export|Import|Fetch|Download|Upload|Convert|Update|Validate|Bundle|Package|Sign|Publish|Watch|Start|Stop|Launch|Open|Close|Drive|Apply|Copy|Find|Keep|Show|Turn|Load|Save|Send|Serve|Set up|Clean|Compile|Measure|Score|Compare|Split|Merge|Pick|Collect)( \/ [a-z]+)?\s(.+)$/;
    // "Development only: check ES5 grammar ..." says what it does after the colon.
    const [pre, ...post] = opening.split(/:\s/);
    const doing = post.length && (/\sonly$/i.test(pre) || !pre.includes(' ')) ? post.join(': ').replace(/^\w/, (c) => c.toUpperCase()) : pre;
    const plainText = (t) => t.split(' ').length <= 12 && !/[`{}=<>\[\]]/.test(t);
    if (ORDER.test(doing) && !/\sonly$/.test(doing) && plainText(doing)) about = { subject: doing };
    // "Shared, bounded checks for private files ..." was cut to its first word: keep the rest.
    else if (about?.subject && !about.subject.includes(' ') && opening.toLowerCase().startsWith(about.subject.toLowerCase() + ', ') && plainText(opening) && opening.split(' ').length <= 10) about = { subject: opening.slice(about.subject.length + 2) };
    if (about?.subject && (/\sonly$/i.test(about.subject) || /^(one|a|an|the|each|every)\s\w+\s\w{3,}s (every|each|all|the|a|an|its|their|our|your|this|that)\b/i.test(about.subject))) about = null;
    if (about?.subject) {
      const order = about.subject.match(ORDER);
      if (order) {
        const f0 = fresh[0].path, isTest = /(^|\/)(tests?|spec)\/|[._-](test|spec)\.|(^|\/)test[-_]/i.test(f0);
        const noun = isTest ? 'a test' : /(^|\/)[^/]*config[^/]*$|rc(\.\w+)?$/i.test(f0) ? 'a config' : /(^|\/)(scripts?|tools?|bin)\//.test(f0) || /\.(sh|py|rb|pl)$/.test(f0) ? 'a script' : 'a helper';
        const rest = order[3].replace(/^the\s/, 'the ');
        about = { subject: isTest && /^(Test|Check|Verify)$/.test(order[1]) ? `${noun} for ${rest}` : `${noun} to ${order[1].toLowerCase()}${order[2] || ''} ${rest}` };
      }
    }
    gm = `Added ${(about?.subject || thing).replace(/^(Tiny|Small|Little|Simple|Quiet|Short|Basic|New|One|Shared|Local|Plain|Light|Soft|Full|Single|Quick|Live|Main|Global|Custom)\s/, (w) => w.toLowerCase())}`;
    if (about?.subject) fromHeader = true;
    const extra = said.find((x) => x.w >= 6 && !gm.includes(x.text) && !sameFact(gm, x));
    if (extra && gm.length + extra.text.length < 60) gm = joinFact(gm, extra);
  } else if (cssLine) {
    // A small style change says exactly what moved: "Reduced font size for description".
    type = 'style'; emoji = '💄';
    gm = cssLine;
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
    const metaLine = metaSubject(fs_);
    if (tweaks) gm = `Polished ${list([...new Set(fs_.map((f) => nameOf(f.path).toLowerCase()))].slice(0, 3))}${fs_.length > 3 ? ' and more' : ''}`;
    else if (adds && !topics.length) gm = `${adds.verb} ${adds.text}`;
    else if (metaLine) gm = metaLine;
    else if (!topics.length && !kinds.includes('style') && where) gm = `Updated ${where} markup`; // no stylesheet touched: not "Refined styles"
    else {
      // A stylesheet hunk that opens under body or :root says nothing about where the change is.
      const place = where || list([...new Set(fs_.flatMap(usefulContexts))].filter((c) => !/^(body|html|:root|\*)$/i.test(c)).slice(0, 2));
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
    const note = facts.find((x) => x.note && `Updated ${label}: ${x.note}`.length <= 72 && x.note.split(/\s+/).length >= 4 && !(x.note.split(/\s+/).length <= 6 && /,/.test(x.note)) && !/^(a|an|the|this|that|it|what|how|why|when|where|which|who)\s/i.test(x.note));
    if (note && (!best || best.w < 6) && fs_.length <= 2) { type = 'feat'; gm = `Updated ${where || label.toLowerCase()}: ${/^[A-Z](?![A-Z])/.test(note.note) ? note.note[0].toLowerCase() + note.note.slice(1) : note.note}`; }
    else if (best && best.verb === 'Added') { type = 'feat'; gm = `Added ${best.text}${where && best.kind === 'code' && !best.text.includes(where) ? ` to ${where}` : ''}`; }
    else if (best && best.verb === 'Removed') { type = 'refactor'; emoji = '🔥'; gm = `Removed ${best.text}${where ? ` from ${where}` : ''}`; }
    else if (best) { type = best.kind === 'doc' ? 'docs' : best.kind === 'config' ? 'chore' : 'feat'; gm = `${best.verb} ${best.text}`; }
    else if (del > add * 2 && del > 20) { type = 'refactor'; gm = `Simplified ${label.toLowerCase()}`; }
    else if (facts.some((x) => x.fixy) && add < 40) {
      // New try/catch: say where errors are now caught, in the function git names for the chunk.
      const fn = fs_.length === 1 ? contextsOf(fs_[0])[0] : '';
      const at = fn && featureName(fn) ? featureName(fn) : label.toLowerCase();
      type = 'fix'; gm = `Handled errors in ${at}`;
    }
    else {
      type = kinds.every((k) => k === 'doc' || k === 'text') ? 'docs' : 'feat';
      const ctx = [...new Set(fs_.flatMap(usefulContexts))].filter((c) => c !== label.toLowerCase()).slice(0, 2);
      gm = ctx.length ? `Updated ${list(ctx)}${where && fs_.length === 1 ? ` in ${where}` : ''}` : `Updated ${label.toLowerCase()}`;
    }
    const next = said.find((x) => x !== best && x.w >= 4 && !gm.includes(x.text) && !sameFact(gm, x));
    if (next && gm.length + next.text.length < 58) gm = joinFact(gm, next);
  }
  // A button that came or went, named by its label: Added the “Copy notes” button.
  if (fs_.length <= 3 && /^(Updated|Refined|Tidied) [\w .-]+$/.test(gm)) {
    const lines = fs_.flatMap((f) => (f.diff || '').split('\n')), plus = lines.filter((l) => l[0] === '+'), minus = lines.filter((l) => l[0] === '-');
    const ids = (ls) => new Set(ls.flatMap((l) => [...l.matchAll(/<button\b[^>]*\bid="([\w-]+)"/g)].map((m) => m[1])));
    const was = ids(minus), now = ids(plus);
    const labelOf = (id, ls) => {
      const clean = (t) => t.replace(/\$\{[^}]*\}/g, '').replace(/<[^>]*>/g, '').replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
      for (const l of ls) {
        const m = l.match(new RegExp(`id="${id}"[^>]*>([^<{$]{3,30})</button>`)) || l.match(new RegExp(`['"]#${id}['"]\\)\\.(?:innerHTML|textContent)\\s*=\\s*[\`'"](.{3,80}?)[\`'"]\\s*;`));
        if (m && /^[A-Z][\w ’'.-]{2,28}$/.test(clean(m[1]))) return clean(m[1]);
      }
      for (const l of ls) { const m = l.match(new RegExp(`<button\\b[^>]*\\bid="${id}"[^>]*\\b(?:title|aria-label)="([^"]{3,60})"`)) || l.match(new RegExp(`<button\\b[^>]*\\b(?:title|aria-label)="([^"]{3,60})"[^>]*\\bid="${id}"`)); if (m && /^[A-Z][\w ’'.-]{2,28}$/.test(clean(m[1]))) return clean(m[1]); }
      return '';
    };
    const came = [...now].filter((x) => !was.has(x)).map((x) => labelOf(x, plus)).filter(Boolean);
    const went = [...was].filter((x) => !now.has(x)).map((x) => labelOf(x, minus)).filter(Boolean);
    if (came.length && !went.length) { type = 'feat'; emoji = '✨'; gm = `Added the ${list(came.map((x) => `“${x}”`))} button${came.length > 1 ? 's' : ''}`; }
    else if (went.length && !came.length) { type = 'refactor'; emoji = EMOJI.remove || '🔥'; gm = `Removed the ${list(went.map((x) => `“${x}”`))} button${went.length > 1 ? 's' : ''}`; }
  }
  // A vague subject takes the why from a comment written with it: "Fixed, not sticky: the sidebar never
  // travels with the page" -> Refined layout so the sidebar never travels with the page.
  if (fs_.length <= 2 && /^(Updated|Refined|Tidied) [\w .-]+$/.test(gm)) {
    for (const f of fs_) for (const l of (f.diff || '').split('\n')) {
      if (l[0] !== '+' || / so /.test(gm)) continue;
      const c = l.slice(1).trim().match(/^(?:\/\/+|\/\*+|\*|#)\s*(.*?)\s*(?:\*\/)?$/)?.[1];
      if (!c) continue;
      const after = c.replace(/^[^:]{3,40}:\s+/, '');
      const m = after.match(/^((?:the|a|an)\s+[a-z][\w-]*(?:\s[a-z][\w-]*){0,2}\s+(?:never|always|no longer|now|only|stays|keeps|sits|follows)\b[^,;—(]*)/i);
      if (m && m[1].split(' ').length <= 10 && `${gm} so ${m[1]}`.length <= 72) { gm = `${gm} so ${m[1][0].toLowerCase()}${m[1].slice(1).replace(/[.\s]+$/, '')}`; break; }
    }
  }
  // Two kinds of file say plainly what they gained: an icon set and package.json.
  if (fs_.length === 1 && /^(Updated|Refined|Tidied) [\w .-]+$/.test(gm)) {
    const d = fs_[0].diff || '', plus = d.split('\n').filter((l) => l[0] === '+' && !l.startsWith('+++')), minus = d.split('\n').filter((l) => l[0] === '-' && !l.startsWith('---'));
    const icons = [...new Set(plus.map((l) => l.match(/^\+\s*["']?([A-Z][A-Za-z]+)\d*["']?\s*:\s*["'`]\s*</)?.[1]).filter(Boolean))];
    const keyOf = (l) => l.match(/^[+-]\s*"([@\w][\w:./@-]*)"\s*:\s*"([^"]*)"/);
    const gone = new Set(minus.map((l) => keyOf(l)?.[1]).filter(Boolean));
    const keys = plus.map(keyOf).filter((m) => m && !gone.has(m[1]));
    if (icons.length >= 2 && plus.length - icons.length <= 2) {
      const words = icons.map((x) => x.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase());
      type = 'feat'; emoji = '✨'; gm = icons.length <= 3 ? `Added ${list(words)} icons` : `Added ${icons.length} icons`;
    } else if (/(^|\/)package\.json$/.test(fs_[0].path) && keys.length && keys.length <= 3) {
      const scripts = keys.filter((m) => !/^[\^~>=<*]?\d|^(latest|next|workspace:|file:|git\+|https?:)/.test(m[2]));
      const deps = keys.filter((m) => !scripts.includes(m));
      if (scripts.length && !deps.length) { type = 'chore'; emoji = '🔧'; gm = `Added ${list(scripts.map((m) => `“${m[1]}”`))} script${scripts.length > 1 ? 's' : ''}`; }
      else if (deps.length && !scripts.length) { type = 'build'; emoji = '➕'; gm = `Added ${list(deps.map((m) => m[1]))}`; }
    }
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
  return { type, scope: tweaks ? '' : scope, emoji, emojiSuggestions, conventional: conv, gitmoji: gm, body: bodyFor(fs_, facts, gm), source: 'guess', ...(fromHeader ? { fromHeader } : {}) };
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
