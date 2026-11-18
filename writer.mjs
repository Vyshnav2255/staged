// Turns code diffs into specific commit messages, such as "Replaced Geist font with Akt".
import path from 'node:path';

// ---------- names ----------
const STOP = new Set(['index', 'main', 'style', 'styles', 'app', 'site', 'base', 'public', 'src', 'assets', 'lib', 'js', 'css', 'scss', 'sass', 'img', 'images', 'static', 'dist', 'vendor', 'components', 'includes', 'partials']);
export const words = (s) => String(s)
  .replace(/\.[a-z0-9]+$/i, '')
  .replace(/^[_.]+/, '')
  .replace(/([a-z])([A-Z])/g, '$1 $2')
  .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
  .replace(/[-_.]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();
const stem = (p) => { const b = path.basename(p); return /^\.[^.]+$/.test(b) ? b.slice(1) : b.replace(/(\.[a-z0-9]+)+$/i, ''); }; // .gitignore -> gitignore
// "01-mono-filled" -> "mono filled", "staged-512" -> "staged", "Haskoy-MediumItalic" -> "Haskoy Medium Italic"
export const nameOf = (p) => words(stem(p)).replace(/^\d+\s+/, '').replace(/\s+\d+(x\d+)?$/, '').replace(/\bsemi bold\b/i, 'SemiBold') || words(stem(p));
const lower = (s) => (/^[A-Z][a-z]/.test(s) && !/[A-Z].*[A-Z]/.test(s) ? s.toLowerCase() : s);
export const list = (xs) => (xs.length <= 2 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const uniq = (xs) => [...new Set(xs.filter(Boolean))];

// ---------- what kind of file ----------
const FONT = /\.(woff2?|ttf|otf|eot)$/i;
const IMAGE = /\.(png|jpe?g|webp|gif|avif|ico|heic)$/i;
const MEDIA = /\.(mp3|wav|ogg|m4a|mp4|webm|mov)$/i;
const LICENCE = /(^|\/)(licen[cs]e|copying|notice|[^/]*[-_]ofl)(\.[a-z]+)?$/i;
const APP_ICON = /(^|\/)(favicon|apple-touch-icon|android-chrome|mstile|safari-pinned-tab|icon-\d+|[^/]*-(16|32|48|64|96|128|180|192|256|384|512))(\.[a-z]+)?$/i;
export function kindOf(p) {
  if (LICENCE.test(p)) return 'licence';
  if (FONT.test(p)) return 'font';
  if (/\.(icns|ico)$/i.test(p) || /(^|\/)brand\/[^/]+\.(svg|png|icns|ico)$/i.test(p)) return 'app-icon';
  if (/\.svg$/i.test(p)) return APP_ICON.test(p) ? 'app-icon' : /(^|\/)(icons?|svg)\//i.test(p) || !/\//.test(p.replace(/^public\//, '')) ? 'icon' : 'graphic';
  if (IMAGE.test(p)) return APP_ICON.test(p) ? 'app-icon' : 'image';
  if (MEDIA.test(p)) return 'media';
  if (/\.(s?css|sass|less|styl)$/i.test(p)) return 'style';
  if (/\.(m?js|cjs|jsx?|tsx?|vue|svelte)$/i.test(p) || /\.js\.liquid$/i.test(p)) return 'script';
  if (/\.(html?|liquid|njk|hbs|astro)$/i.test(p)) return 'markup';
  if (/(^|\/)readme(\.[a-z]+)?$/i.test(p) || /(^|\/)(changelog|roadmap|contributing)(\.[a-z]+)?$/i.test(p)) return 'doc';
  if (/\.(md|markdown|mdx|txt)$/i.test(p)) return 'text';
  if (/(^|\/)(package(-lock)?\.json|\.?[a-z]*rc(\.json)?|.*\.config\.[cm]?js|.*\.(ya?ml|toml)|manifest\.webmanifest|\.gitignore)$/i.test(p)) return 'config';
  if (/\.json$/i.test(p)) return 'data';
  if (/(^|\/)\.DS_Store$/.test(p)) return 'junk';
  return 'other';
}
export const isAsset = (k) => ['font', 'icon', 'graphic', 'image', 'media', 'licence', 'app-icon'].includes(k);

// ---------- facts from a diff ----------
const lines = (f, sign) => (f.diff || '').split('\n').filter((l) => l[0] === sign && !/^(\+\+\+|---)/.test(l)).map((l) => l.slice(1));
const firstFamily = (v) => (v.split(',')[0] || '').trim().replace(/^['"]|['"]$/g, '').replace(/\s+(Variable|VF)$/i, '');
const GENERIC_FAMILY = /^(var\(|inherit|initial|system-ui|sans-serif|serif|monospace|-apple-system|ui-)/i;

// CSS: properties whose value changed, fonts swapped, new selectors and variables.
function cssFacts(f, out) {
  const add = lines(f, '+'), del = lines(f, '-');
  const props = (ls) => ls.map((l) => l.match(/^\s*(--[\w-]+|[a-z-]+)\s*:\s*([^;{}]+);?/i)).filter(Boolean).map((m) => [m[1].toLowerCase(), m[2].trim()]);
  const a = props(add), d = props(del);
  const before = new Map(d.map(([k, v]) => [k, v]));
  // Fonts
  const fa = uniq(a.filter(([k]) => k === 'font-family').map(([, v]) => firstFamily(v)).filter((v) => !GENERIC_FAMILY.test(v)));
  const fd = uniq(d.filter(([k]) => k === 'font-family').map(([, v]) => firstFamily(v)).filter((v) => !GENERIC_FAMILY.test(v)));
  const newFams = fa.filter((x) => !fd.includes(x)), oldFams = fd.filter((x) => !fa.includes(x));
  if (newFams.length && oldFams.length) out.push({ w: 9, verb: 'Replaced', text: `${oldFams[0]} font with ${newFams[0]}`, kind: 'style' });
  else if (newFams.length && /@font-face/.test(add.join('\n'))) out.push({ w: 6, verb: 'Added', text: `${newFams[0]} font`, kind: 'style' });
  // Weights and sizes that moved one way
  const nums = (k) => a.filter(([x]) => x === k).map(([, v]) => [parseFloat(before.get(k)), parseFloat(v)]).filter(([x, y]) => !isNaN(x) && !isNaN(y) && x !== y);
  const fw = nums('font-weight');
  if (fw.length && fw.every(([x, y]) => y > x)) out.push({ w: 7, verb: 'Increased', text: `font weight to ${fw[fw.length - 1][1]}`, kind: 'style' });
  else if (fw.length && fw.every(([x, y]) => y < x)) out.push({ w: 7, verb: 'Reduced', text: `font weight to ${fw[fw.length - 1][1]}`, kind: 'style' });
  // What sort of styling changed
  const changed = new Set([...a, ...d].map(([k]) => k));
  const topics = [];
  const has = (re) => [...changed].some((k) => re.test(k));
  const valueHas = (re) => [...a, ...d].some(([, v]) => re.test(v));
  if (has(/^(color|background(-color)?|fill|stroke|border-color|outline-color|accent-color|caret-color)$/) || valueHas(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(/i)) topics.push('colours');
  if (has(/shadow$/)) topics.push('shadows');
  if (has(/^(animation|transition)/) || /@keyframes/.test(add.join('\n'))) topics.push('animations');
  if (has(/^(margin|padding|gap|row-gap|column-gap|inset)/)) topics.push('spacing');
  if (has(/^(font-size|line-height|letter-spacing|font-feature-settings|font-variation-settings|text-)/)) topics.push('type');
  if (has(/^(border-radius|--radius)/)) topics.push('corners');
  if (has(/^(display|grid|flex|position|width|height|max-width|min-width|max-height|min-height|align|justify|order|top|left|right|bottom)/)) topics.push('layout');
  if (topics.length) out.push({ w: 3, topics, kind: 'style' });
  const newVars = a.filter(([k]) => k.startsWith('--') && !before.has(k)).length;
  if (newVars >= 3) out.push({ w: 2, verb: 'Added', text: `${newVars} style variables`, kind: 'style' });
  // New components: selectors added that weren't there before
  const sel = (ls) => ls.map((l) => l.match(/^\s*([.#][\w-]+)[^{]*\{\s*$/)).filter(Boolean).map((m) => m[1]);
  const delSel = new Set(sel(del));
  const newSel = uniq(sel(add).filter((s) => !delSel.has(s))).map((s) => s.slice(1).split(/__|--/)[0]);
  const blocks = uniq(newSel);
  if (blocks.length && blocks.length <= 3 && f.status !== 'A') out.push({ w: 4, verb: 'Added', text: `styles for ${list(blocks.map(words).map(lower))}`, kind: 'style' });
}

// JS: functions, exports and listeners a change adds or removes.
// Top-level declarations only: helpers inside functions are noise.
const FN = /^(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)|^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/;
function jsFacts(f, out) {
  const add = lines(f, '+'), del = lines(f, '-');
  const names = (ls, pad = '') => uniq(ls.map((l) => (l.startsWith(pad) && !l.startsWith(pad + ' ') ? l.slice(pad.length) : '').match(FN)).filter(Boolean).map((m) => m[1] || m[2]));
  // Top level first; code wrapped in one function (an IIFE, a .liquid script) is two spaces in.
  let an = names(add), dn = names(del);
  if (!an.length && !dn.length) { an = names(add, '  '); dn = names(del, '  '); }
  const human = (n) => words(n).toLowerCase().replace(/^(on|handle|render|draw|mount|make|build|get|set|to|is|has|use) /, '');
  // Short helpers ("sumOf", "clip") say nothing about the change, so they are left out.
  const telling = (n) => { const h = human(n); return h.length >= 8 && !/ (of|to|for|by|at)$/.test(h); };
  const added = an.filter((n) => !dn.includes(n) && telling(n)), removed = dn.filter((n) => !an.includes(n) && telling(n));
  if (added.length && f.status !== 'A') out.push({ w: 5, verb: 'Added', text: list(uniq(added.slice(0, 3).map(human))), kind: 'code', names: added });
  if (removed.length && !added.length) out.push({ w: 4, verb: 'Removed', text: list(uniq(removed.slice(0, 3).map(human))), kind: 'code', names: removed });
  const keys = uniq(add.join('\n').match(/addEventListener\(\s*['"](\w+)['"]/g)?.map((m) => m.match(/['"](\w+)['"]/)[1]) || []).filter((e) => !del.join('\n').includes(`'${e}'`) && !del.join('\n').includes(`"${e}"`));
  if (keys.some((k) => /^key/.test(k))) out.push({ w: 2, verb: 'Added', text: 'keyboard shortcuts', kind: 'code' });
  if (f.status === 'M') noteFacts(add, out);
  if (/\b(try|catch)\b/.test(add.join('\n')) && !/\b(try|catch)\b/.test(del.join('\n'))) out.push({ w: 1, fixy: true });
}

// New comments that read like sentences say why a change was made: keep the first sentence.
function noteFacts(add, out) {
  const notes = [];
  const isComment = (l) => /^\s*(\/\/|\/\*|\*|#|<!--)/.test(l || '');
  for (const [i, l] of add.entries()) {
    if (isComment(add[i - 1])) continue; // only the start of a comment block
    if (/^\s+/.test(l)) continue; // comments deep inside code are notes to self, not what the change is
    const m = l.match(/^\s*(?:\/\/|\/\*+|\*|#|<!--)\s*([A-Z][^*]*?|[a-z]+[A-Z][^*]*?)\s*(?:\*\/|-->)?\s*$/);
    if (!m || /^(TODO|FIXME|eslint|@|prettier|NOTE:?\s*$)/.test(m[1]) || m[1].split(' ').length < 4) continue;
    const first = m[1].split(/(?<=[.!?;])\s/)[0].replace(/[.:;,]$/, '');
    if (isComment(add[i + 1]) && first === m[1].replace(/[.:;,]$/, '') && !/[.:;]$/.test(m[1])) continue; // sentence runs on: too long to quote
    if (first.length >= 18 && first.length <= 110) notes.push(first);
  }
  for (const n of notes.slice(0, 2)) out.push({ w: 0, note: n, kind: 'note' });
}

// Markup and pages: includes and sections added.
function markupFacts(f, out) {
  const add = lines(f, '+').join('\n'), del = lines(f, '-').join('\n');
  const inc = uniq([...add.matchAll(/\{%-?\s*include\s+([\w./-]+)/g)].map((m) => m[1])).filter((x) => !del.includes(x));
  if (inc.length && f.status !== 'A') out.push({ w: 5, verb: 'Added', text: `${list(inc.slice(0, 2).map((x) => lower(nameOf(x))))} to ${lower(nameOf(f.path))}`, kind: 'markup' });
  const aria = (add.match(/aria-[a-z]+=/g) || []).length - (del.match(/aria-[a-z]+=/g) || []).length;
  if (aria >= 2) out.push({ w: 2, verb: 'Improved', text: 'accessibility', kind: 'markup' });
}

// Docs and Markdown: sections added.
function docFacts(f, out) {
  const add = lines(f, '+'), del = new Set(lines(f, '-'));
  const heads = add.filter((l) => /^#{2,3}\s+\S/.test(l) && !del.has(l)).map((l) => l.replace(/^#+\s+/, '').replace(/[*`_]/g, '').trim());
  if (heads.length && f.status !== 'A') out.push({ w: 4, verb: 'Added', text: `${list(heads.slice(0, 2).map((h) => `"${h}"`))} section${heads.length > 1 ? 's' : ''}`, kind: 'doc' });
}

function configFacts(f, out) {
  if (!/package\.json$/.test(f.path)) return;
  const add = lines(f, '+').join('\n'), del = lines(f, '-').join('\n');
  const ver = add.match(/"version"\s*:\s*"([^"]+)"/);
  if (ver && /"version"/.test(del)) out.push({ w: 3, verb: 'Bumped', text: `version to ${ver[1]}`, kind: 'config' });
  const deps = [...add.matchAll(/^\s*"(@?[\w./-]+)"\s*:\s*"[\^~]?\d/gm)].map((m) => m[1]).filter((d) => !del.includes(`"${d}"`) && d !== 'version');
  if (deps.length) out.push({ w: 4, verb: 'Added', text: `${list(deps.slice(0, 2))} dependenc${deps.length > 1 ? 'ies' : 'y'}`, kind: 'config' });
}

export function factsFor(f) {
  const out = [];
  const k = kindOf(f.path);
  if (f.binary || f.status === 'D') return out;
  try {
    if (k === 'style' || (k === 'markup' && /<style/.test(f.diff || ''))) cssFacts(f, out);
    if (k === 'script' || k === 'markup') jsFacts(f, out);
    if (k === 'markup') markupFacts(f, out);
    if (k === 'doc' || k === 'text') docFacts(f, out);
    if (k === 'config') configFacts(f, out);
  } catch {}
  return out.map((x) => ({ ...x, file: f.path }));
}

// ---------- groups of assets ----------
const NOUN = { font: ['font', 'fonts'], icon: ['icon', 'icons'], graphic: ['graphic', 'graphics'], image: ['image', 'images'], media: ['sound', 'sounds'], licence: ['licence', 'licences'], 'app-icon': ['app icon', 'app icons'] };
const noun = (k, n) => NOUN[k][n === 1 ? 0 : 1];

// Fonts: "Haskoy Italic, Medium Italic and SemiBold Italic fonts" (family named once).
function fontNames(fs_) {
  const ns = fs_.map((f) => nameOf(f.path).replace(/\s*(Variable|VF)$/i, ' Variable').trim());
  const fam = ns.map((n) => n.split(' ')[0]);
  if (new Set(fam).size === 1 && ns.length > 1) {
    const rest = ns.map((n) => n.split(' ').slice(1).join(' ') || 'Regular');
    return `${fam[0]} ${list(uniq(rest))}`;
  }
  return list(uniq(ns));
}

// A subject for a group made only of assets, or null.
export function assetSubject(all) {
  // Mostly assets, plus the page or config that points at them (a manifest, a <link>): still about the assets.
  let fs_ = all.filter((f) => isAsset(kindOf(f.path)));
  if (fs_.length < all.length && (fs_.length / all.length < 0.7 || !all.every((f) => isAsset(kindOf(f.path)) || ['config', 'markup'].includes(kindOf(f.path))))) return null;
  if (!fs_.length) return null;
  const kinds = fs_.map((f) => kindOf(f.path));
  const main = Object.entries(kinds.reduce((m, k) => ((m[k] = (m[k] || 0) + 1), m), {})).filter(([k]) => k !== 'licence').sort((a, b) => b[1] - a[1])[0]?.[0] || 'licence';
  const ofMain = fs_.filter((f) => kindOf(f.path) === main);
  const allNew = fs_.every((f) => f.status === 'A' || f.status === '?'), allGone = fs_.every((f) => f.status === 'D');
  const verb = allNew ? 'Added' : allGone ? 'Removed' : main === 'app-icon' || fs_.every((f) => f.status === 'M') ? 'Updated' : 'Added';
  let what;
  if (main === 'app-icon') what = ofMain.length === 1 ? lower(nameOf(ofMain[0].path)) : 'app icons';
  else if (main === 'font') what = `${ofMain.length <= 4 ? fontNames(ofMain) : `${uniq(ofMain.map((f) => nameOf(f.path).split(' ')[0])).join(' and ')}`} ${noun('font', ofMain.length)}`;
  else if (main === 'licence') what = `${list(uniq(fs_.map((f) => nameOf(f.path).replace(/\s*(OFL|licen[cs]e)$/i, '')).filter((x) => x && !/^(licen[cs]e|copying|notice)$/i.test(x))))} font licence${fs_.length > 1 ? 's' : ''}`.replace(/^ font/, 'licence');
  else if (ofMain.length <= 3) what = `${list(uniq(ofMain.map((f) => lower(nameOf(f.path)))))} ${noun(main, ofMain.length)}`;
  else {
    const dir = commonDir(ofMain.map((f) => f.path));
    what = `${ofMain.length} ${dir ? lower(words(path.basename(dir))) + ' ' : ''}${noun(main, ofMain.length)}`.replace(/\b(\w+) \1\b/, '$1');
  }
  const lic = main !== 'licence' && kinds.includes('licence') ? ' with licence' + (kinds.filter((k) => k === 'licence').length > 1 ? 's' : '') : '';
  const type = verb === 'Removed' ? 'chore' : main === 'font' || main === 'licence' ? 'style' : 'chore';
  return { verb, what: what.replace(/\s+/g, ' ').trim() + lic, type, emoji: verb === 'Removed' ? '🔥' : main === 'font' ? '💄' : '🍱' };
}

export function commonDir(paths) {
  if (!paths.length) return '';
  const parts = paths.map((p) => p.split('/').slice(0, -1));
  const out = [];
  for (let i = 0; ; i++) {
    const s = parts[0][i];
    if (s == null || !parts.every((x) => x[i] === s)) break;
    out.push(s);
  }
  // skip folders that say nothing (public, assets, src …)
  while (out.length && STOP.has(out[out.length - 1].toLowerCase())) out.pop();
  return out.join('/');
}

// A short human name for what a group of files is about.
export function topicOf(fs_) {
  const fresh = fs_.filter((f) => f.status === 'A' || f.status === '?');
  const pick = (xs) => {
    const counts = {};
    for (const x of xs) { const n = lower(nameOf(x.path)); if (n && !STOP.has(n.toLowerCase())) counts[n] = (counts[n] || 0) + (x.add || 1); }
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
  };
  if (fresh.length >= 3) {
    const dir = commonDir(fresh.map((f) => f.path));
    if (dir && fresh.every((f) => f.path.startsWith(dir + '/'))) {
      const segs = dir.split('/').filter((s) => !STOP.has(s.toLowerCase()));
      if (segs.length) return lower(words(segs.slice(-2).join(' ')));
    }
  }
  const code = fresh.filter((f) => ['script', 'markup', 'style'].includes(kindOf(f.path)));
  return pick(code.length ? code : fresh.length ? fresh : [...fs_].sort((a, b) => b.add + b.del - (a.add + a.del)).slice(0, 1));
}

// What a new file is, in words people use: "readme view", "tags page", "sky styles".
export function thingFor(f, all) {
  const k = kindOf(f.path), n = lower(nameOf(f.path));
  if (/(^|\/)manifest\.webmanifest$/i.test(f.path)) return "installable app support";
  if (k === 'script' && n === 'writer') return 'commit message writer';
  if (k === 'script' && n === 'feature index') return 'feature grouping index';
  if (k === 'script' && n === 'update') return 'in-app update flow';
  if (k === 'script' && n === 'updater') return 'app updater';
  if (/(^|\/)(pages?|_pages|routes)\//.test(f.path) && k === 'markup') return `${n} page`;
  if (/(^|\/)_includes\//.test(f.path)) return n;
  if (k === 'script' && /(^|\/)public\//.test(f.path) && all.some((x) => /index\.html$/.test(x.path) || /app\.js$/.test(x.path))) return `${n} view`;
  if (k === 'style') return `${n} styles`;
  if (k === 'script' && /\.mjs$/.test(f.path)) return n;
  return n;
}


// ---------- what a new file says it is ----------
// Most new files open with a line that says what they are: a header comment, a <title>, a # heading.
const VERBS = /^(Reads|Keeps|Turns|Shows|Builds|Renders|Draws|Makes|Runs|Watches|Handles|Finds|Lists|Groups|Writes|Creates|Loads|Parses|Fetches|Sends|Tracks|Adds|Lets|Gives|Puts|Opens|Checks|Generates|Converts|Serves|Starts|Stops|Holds|Stores|Wraps|Splits|Picks|Plays|Animates|Detects|Syncs|Exports|Imports|Formats|Cleans)\b/;
const BASE_VERBS = /^(Ship|Show|Make|Build|Run|Keep|Turn|Read|Write|Find|Check|Open|Serve|Start|Fetch|Load|Sync|Track|Group|Pick|Play|Draw|Render|Watch|Handle|List|Send|Create|Generate|Convert|Parse|Format|Clean|Store|Save|Let|Give|Put|Hold|Wrap|Split|Detect|Publish|Bump|Tag|Draft|Guess|Learn|Move|Copy|Remove|Delete|Download|Upload)\b(?=\s+\w)/;
export function headerOf(f) {
  const text = f.content || lines(f, '+').join('\n');
  if (!text) return null;
  const k = kindOf(f.path);
  let line = '';
  if (k === 'markup') line = (text.match(/<title>([^<]{4,})<\/title>/i) || text.match(/<h1[^>]*>([^<]{4,})<\/h1>/i) || [])[1] || '';
  if (!line && /^(doc|text)$/.test(k)) line = (text.match(/^title:\s*["']?(.+?)["']?\s*$/m) || text.match(/^#\s+(.+)$/m) || [])[1] || '';
  if (!line) {
    const head = text.split('\n').slice(0, 12);
    for (const l of head) {
      if (/^\s*(#!|['"]use strict|import |export \{|$)/.test(l)) continue;
      const m = l.match(/^\s*(?:\/\/+|\/\*+|\*|#(?!\s*include)|<!--|""")\s*(.+?)\s*(?:\*\/|-->)?\s*$/);
      if (!m) break;
      if (m[1].length < 8 || /^(eslint|@|prettier|-\*-|copyright|\(c\))/i.test(m[1])) continue;
      line = m[1];
      // a sentence that carries on over the next comment lines
      for (let k = head.indexOf(l) + 1; k < head.length && !/[.!?]$/.test(line); k++) {
        const n = head[k].match(/^\s*(?:\/\/+|\*(?!\/))\s*(.+?)\s*$/);
        if (!n) break;
        line += ' ' + n[1];
      }
      break;
    }
  }
  line = line.replace(/<[^>]+>/g, '').replace(/`/g, '').trim();
  return line.length >= 8 ? line : null;
}

// Turns a header into words for a subject: "Added small terminal helpers", "Added writer that reads diffs".
export function aboutOf(f, thing) {
  const h = headerOf(f);
  if (!h) return null;
  const name = nameOf(f.path).toLowerCase();
  const first = h.split(/(?<=[.!?])\s/)[0].replace(/[.!?]$/, '');
  const [pre, post] = first.includes(': ') ? [first.slice(0, first.indexOf(': ')), first.slice(first.indexOf(': ') + 2)] : [first, ''];
  const fit = (x) => x && x.length <= 58 ? x : null;
  const cut = (x) => x.split(/\s[(—–-]\s?|[,;(]/)[0].trim();
  let subject = null;
  const preIsName = pre.toLowerCase().replace(/[^a-z0-9 ]/g, '') === name.replace(/[^a-z0-9 ]/g, '') || pre.split(' ').length === 1;
  // "Ship a new version of staged" reads as an order: say what the thing does instead.
  const order = first.match(BASE_VERBS);
  if (!VERBS.test(first) && order) { const v = order[1].toLowerCase(); const does = /(s|sh|ch|x|z)$/.test(v) ? v + 'es' : /[^aeiou]y$/.test(v) ? v.slice(0, -1) + 'ies' : v + 's'; const rest = first.split(/:\s/)[0].slice(order[1].length); subject = fit(`${thing} that ${does}${rest}`) || fit(`${thing} that ${does}${cut(rest)}`); }
  else if (VERBS.test(first)) subject = fit(`${thing} that ${lower(first)}`) || fit(`${thing} that ${lower(cut(first))}`);
  else if (!preIsName && post && pre.split(' ').length <= 5) subject = fit(lower(pre));
  else if (!post && kindOf(f.path) !== 'markup') subject = fit(lower(first)) || fit(lower(cut(first)));
  else if (preIsName && post && VERBS.test(post)) subject = fit(`${thing} that ${lower(post)}`) || fit(`${thing} that ${lower(cut(post))}`);
  if (subject && /^(the|a|an) /i.test(subject) && subject.split(' ').length > 8) subject = null;
  return { subject, note: h.length <= 110 ? h.replace(/[.]$/, '') : cut(h) };
}

// Where in a file the edits happened, from the function or selector git names in each hunk header.
export function contextsOf(f) {
  const names = [];
  for (const l of (f.diff || '').split('\n')) {
    const m = l.match(/^@@[^@]*@@\s*(.*)$/);
    if (!m || !m[1]) continue;
    const c = m[1];
    const fn = c.match(/(?:function\s*\*?\s*|const\s+|let\s+|class\s+|def\s+|fn\s+|func\s+)([A-Za-z_$][\w$]*)/)
      || c.match(/(?:^|\s)(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?:\{|=>)?\s*$/);
    const css = c.match(/^\s*([.#]?[a-z][\w-]*)[^{]*\{/i);
    const n = fn ? fn[1] : css && kindOf(f.path) === 'style' ? css[1].replace(/^[.#]/, '') : null;
    if (n && n.length > 2) names.push(n);
  }
  const counts = {};
  for (const n of names) counts[n] = (counts[n] || 0) + 1;
  const human = (n) => words(n).toLowerCase().replace(/^(on|handle|render|draw|mount|make|build|get|set|to|use) (?=\w)/, '');
  return uniq(Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([n]) => human(n))).filter((n) => n && !STOP.has(n)).slice(0, 2);
}

// Tense helpers
export const PAST = { Add: 'Added', Fix: 'Fixed', Update: 'Updated', Remove: 'Removed', Refine: 'Refined', Polish: 'Polished', Improve: 'Improved', Replace: 'Replaced', Increase: 'Increased', Reduce: 'Reduced', Bump: 'Bumped', Rename: 'Renamed', Move: 'Moved', Restyle: 'Restyled', Tidy: 'Tidied', Clean: 'Cleaned' };
