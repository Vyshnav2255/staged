// Read-mostly insights: git tree, repo state (ahead/behind, branches, stashes), Today,
// releases (tags), push, changelog export.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const IMG = /\.(png|jpe?g|gif|webp|avif|svg|heic|bmp|tiff?)$/i;
const MODERN_IMG = /\.(webp|avif|svg)$/i;
const VID = /\.(mp4|m4v|mov|webm)$/i;
const BOT_BRANCH = /(^|\/)(dependabot|renovate|imgbot|snyk|greenkeeper)(\/|$)/i;

function githubRepo(remote) {
  const m = remote.match(/github[\w.-]*[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i);
  return m ? m[1] : '';
}
// gh lives in Homebrew's folder, which apps started by launchd don't always have on PATH.
function ghRelease(cwd, tag, notes) {
  const tries = ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh'];
  return new Promise((resolve) => {
    const next = () => {
      const bin = tries.shift();
      if (!bin) return resolve('');
      execFile(bin, ['release', 'create', tag, '--verify-tag', '--title', tag, '--notes', notes || tag], { cwd, timeout: 30000 }, (err, out) => {
        if (err && err.code === 'ENOENT') return next();
        resolve(err ? '' : String(out).trim().split('\n').pop());
      });
    };
    next();
  });
}

export function insightRoutes({ git, listRepos, repoDir, onIncoming }) {
  const weightCache = new Map(); // sha -> totals (Health: site weight)

  // ---------- incoming: notice commits on the remote, and pull them in safely ----------
  // Fetch only downloads; it never touches your files. It runs with no prompts (an SSH key
  // that needs a passphrase, or a password, just makes it skip quietly) and a time limit.
  const fetchedAt = new Map(), lastBehind = new Map();
  const FETCH_EVERY = 5 * 60 * 1000;
  function fetchRemote(dir) {
    return new Promise((resolve) => {
      execFile('git', ['fetch', '--quiet', '--no-recurse-submodules', '--prune'], {
        cwd: dir, timeout: 30000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes -o ConnectTimeout=10' },
      }, (err, _o, stderr) => resolve(err ? String(stderr || err.message).trim().split('\n').pop() : ''));
    });
  }
  async function incoming(dir, limit = 50) {
    const raw = await git(dir, ['log', `-${limit}`, '--format=%H%x1f%h%x1f%an%x1f%cI%x1f%s', 'HEAD..@{u}']).catch(() => '');
    return raw.split('\n').filter(Boolean).map((l) => { const [sha, short, author, date, subject] = l.split('\x1f'); return { sha, short, author, date, subject }; });
  }
  async function refresh(name, dir, force = false) {
    if (!force && Date.now() - (fetchedAt.get(dir) || 0) < FETCH_EVERY - 5000) return null;
    const up0 = await upstreamCounts(dir);
    if (!up0.upstream) return null;
    const error = await fetchRemote(dir);
    fetchedAt.set(dir, Date.now());
    const up = await upstreamCounts(dir);
    if (up.behind !== lastBehind.get(dir)) { lastBehind.set(dir, up.behind); onIncoming && onIncoming({ repo: name, behind: up.behind, ahead: up.ahead }); }
    return { ...up, error, fetchedAt: fetchedAt.get(dir) };
  }
  // Look every few minutes, one repo at a time, so a slow remote never holds the others up.
  let sweeping = false;
  async function sweep() {
    if (sweeping) return; sweeping = true;
    try { for (const r of await listRepos()) await refresh(r.name, r.dir).catch(() => {}); } finally { sweeping = false; }
  }
  setTimeout(sweep, 8000).unref?.();
  setInterval(sweep, FETCH_EVERY).unref?.();

  const conflicted = async (dir) => (await git(dir, ['diff', '--name-only', '--diff-filter=U']).catch(() => '')).split('\n').filter(Boolean);
  async function busy(dir) {
    const g = path.resolve(dir, (await git(dir, ['rev-parse', '--git-dir'])).trim());
    return ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD'].some((f) => fs.existsSync(path.join(g, f)));
  }
  // Pull: set uncommitted work aside, bring the new commits in (fast-forward, or replay your
  // unpushed commits on top), then put the work back. If anything clashes, undo all of it.
  async function pull(dir) {
    const up = await upstreamCounts(dir);
    if (!up.upstream) throw Object.assign(new Error('This branch isn’t linked to a remote branch yet.'), { code: 'no-upstream' });
    if (await busy(dir)) throw Object.assign(new Error('Git is in the middle of a merge or rebase here. Finish it in a terminal first.'), { code: 'busy' });
    if (!up.behind) return { pulled: 0, commits: [] };
    const commits = await incoming(dir);
    const before = (await git(dir, ['rev-parse', 'HEAD'])).trim();
    // Uncommitted files that the new commits also change: ask to commit them first, rather than risk a clash.
    const statusZ = (await git(dir, ['status', '--porcelain=v1', '-z', '-uall'])).split('\0').filter(Boolean);
    const dirtyFiles = new Set(statusZ.map((l) => l.slice(3)));
    const theirs = (await git(dir, ['diff', '--name-only', 'HEAD...@{u}']).catch(() => '')).split('\n').filter(Boolean);
    const overlap = theirs.filter((f) => dirtyFiles.has(f));
    if (overlap.length) throw Object.assign(new Error('Some files you haven’t committed are also changed in the new commits. Commit them first, then pull.'), { code: 'overlap', files: overlap });
    const dirty = statusZ.length > 0;
    let stashed = false;
    if (dirty) {
      const n0 = (await git(dir, ['stash', 'list']).catch(() => '')).split('\n').filter(Boolean).length;
      await git(dir, ['stash', 'push', '--include-untracked', '-m', 'staged: set aside while pulling']);
      stashed = (await git(dir, ['stash', 'list']).catch(() => '')).split('\n').filter(Boolean).length > n0;
    }
    // Put the set-aside work back. apply, then drop only once it went in cleanly.
    const apply = () => git(dir, ['stash', 'apply', '--index']).catch(() => git(dir, ['stash', 'apply']));
    const putBack = async () => { if (!stashed) return; await apply(); await git(dir, ['stash', 'drop']); };
    // If putting it back clashes: return to exactly where we started, then put it back there.
    const restore = async () => {
      await git(dir, ['reset', '--hard', before]).catch(() => {});
      if (!stashed) return;
      const extra = (await git(dir, ['ls-tree', '-r', '--name-only', 'stash@{0}^3']).catch(() => '')).split('\n').filter(Boolean);
      for (const f of extra) { try { fs.rmSync(path.join(dir, f), { force: true }); } catch {} }
      await putBack().catch(() => {});
    };
    try {
      if (up.ahead) await git(dir, ['rebase', '--no-autosquash', '@{u}']);
      else await git(dir, ['merge', '--ff-only', '@{u}']);
    } catch (e) {
      const files = await conflicted(dir);
      await git(dir, ['rebase', '--abort']).catch(() => {});
      await restore();
      throw Object.assign(new Error(files.length ? 'Your commits and the new ones change the same lines, so nothing was pulled.' : 'Couldn’t pull: ' + String(e.stderr || e.message).trim().split('\n').pop()), { code: files.length ? 'conflict' : 'failed', files });
    }
    try { await putBack(); }
    catch {
      const files = await conflicted(dir);
      await restore();
      throw Object.assign(new Error('Your uncommitted changes clash with the new commits, so nothing was pulled. Commit them first, then pull.'), { code: 'conflict', files });
    }
    const files = (await git(dir, ['diff', '--name-only', before, 'HEAD']).catch(() => '')).split('\n').filter(Boolean).length;
    lastBehind.set(dir, 0);
    return { pulled: commits.length, commits, files, replayed: up.ahead, kept: stashed };
  }

  async function upstreamCounts(dir) {
    try {
      const out = (await git(dir, ['rev-list', '--left-right', '--count', 'HEAD...@{u}'])).trim().split(/\s+/);
      return { ahead: +out[0], behind: +out[1], upstream: (await git(dir, ['rev-parse', '--abbrev-ref', '@{u}'])).trim() };
    } catch { return { ahead: 0, behind: 0, upstream: '' }; }
  }

  async function branches(dir) {
    const head = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim();
    const raw = await git(dir, ['for-each-ref', '--format=%(refname)%1f%(refname:short)%1f%(committerdate:iso-strict)%1f%(objectname:short)%1f%(subject)', 'refs/heads', 'refs/remotes']).catch(() => '');
    const merged = new Set((await git(dir, ['branch', '-a', '--merged', 'HEAD', '--format=%(refname:short)']).catch(() => '')).split('\n').map((s) => s.trim()).filter(Boolean));
    return raw.split('\n').filter(Boolean).map((l) => {
      const [ref, name, date, sha, subject] = l.split('\x1f');
      return { name, remote: ref.startsWith('refs/remotes/'), date, sha, subject, current: name === head, merged: merged.has(name), bot: BOT_BRANCH.test(name) };
    }).filter((b) => !b.name.endsWith('/HEAD') && b.name !== 'origin');
  }

  async function stashes(dir) {
    const raw = await git(dir, ['stash', 'list', '--format=%gd%x1f%cI%x1f%gs']).catch(() => '');
    return raw.split('\n').filter(Boolean).map((l) => { const [ref, date, msg] = l.split('\x1f'); return { ref, date, msg }; });
  }

  async function oldestChange(dir) {
    const raw = await git(dir, ['status', '--porcelain=v1', '-z', '-uall']).catch(() => '');
    const files = raw.split('\0').filter(Boolean).map((p) => p.slice(3)).filter(Boolean);
    let oldest = null;
    for (const f of files.slice(0, 400)) {
      try { const m = fs.statSync(path.join(dir, f)).mtimeMs; if (oldest === null || m < oldest) oldest = m; } catch {}
    }
    return { dirty: files.length, oldest };
  }

  async function graph(dir, limit, all) {
    const args = ['log', '--topo-order', `-n${limit}`, '--format=%H%x1f%P%x1f%D%x1f%aI%x1f%an%x1f%s'];
    if (all) {
      // every local branch and remote branch except bots, plus tags
      const refs = (await branches(dir)).filter((b) => !b.bot).map((b) => (b.remote ? 'refs/remotes/' : 'refs/heads/') + b.name);
      args.push(...refs, 'HEAD');
    } else args.push('HEAD');
    const raw = await git(dir, args);
    const head = (await git(dir, ['rev-parse', 'HEAD']).catch(() => '')).trim();
    const commits = raw.split('\n').filter(Boolean).map((l) => {
      const [sha, parents, refs, date, author, subject] = l.split('\x1f');
      return { sha, parents: parents ? parents.split(' ') : [], refs: refs ? refs.split(', ').filter((r) => !BOT_BRANCH.test(r)) : [], date, author, subject };
    });
    return { head, commits };
  }

  async function commitDetail(dir, sha) {
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) throw new Error('Bad commit id');
    const meta = await git(dir, ['show', '-s', '--format=%H%x1f%an%x1f%aI%x1f%B', sha]);
    const [full, author, date, body] = meta.split('\x1f');
    const ns = await git(dir, ['show', '--numstat', '--format=', '-M', sha]);
    const files = ns.split('\n').filter(Boolean).map((l) => {
      const [a, d, ...p] = l.split('\t');
      return { path: p.join('\t'), add: a === '-' ? 0 : +a, del: d === '-' ? 0 : +d };
    });
    return { sha: full, author, date, message: body.trim(), files };
  }

  // Site weight: total size of CSS / JS / images / fonts in the tree, sampled weekly.
  function categorise(p) {
    if (/\.(s?css|sass|less)$/i.test(p)) return 'css';
    if (/\.(m?js|cjs|ts|tsx|jsx|liquid)$/i.test(p) && !/\.(md|html)$/i.test(p)) return /\.liquid$/i.test(p) && !/\.js\.liquid$/i.test(p) ? 'other' : 'js';
    if (IMG.test(p)) return 'images';
    if (/\.(woff2?|ttf|otf|eot)$/i.test(p)) return 'fonts';
    if (/\.(mp3|ogg|wav|m4a|mp4|webm|mov)$/i.test(p)) return 'media';
    return 'other';
  }
  async function treeWeight(dir, sha) {
    if (weightCache.has(sha)) return weightCache.get(sha);
    const raw = await git(dir, ['ls-tree', '-r', '-l', sha]);
    const t = { css: 0, js: 0, images: 0, fonts: 0, media: 0, other: 0 };
    for (const l of raw.split('\n')) {
      const m = l.match(/^\d+ blob [0-9a-f]+\s+(\d+)\t(.+)$/);
      if (!m) continue;
      if (/^(node_modules|vendor|_site|dist|\.git)\//.test(m[2])) continue;
      t[categorise(m[2])] += +m[1];
    }
    weightCache.set(sha, t);
    return t;
  }
  async function weight(dir, weeks) {
    const raw = await git(dir, ['log', '--first-parent', '--format=%H%x1f%cI%x1f%s', `--since=${weeks} weeks ago`, 'HEAD']);
    const rows = raw.split('\n').filter(Boolean).map((l) => { const [sha, date, subject] = l.split('\x1f'); return { sha, date, subject }; });
    // last commit of each week, newest first
    const seen = new Set();
    const picks = [];
    for (const r of rows) {
      const d = new Date(r.date); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      const k = d.getTime();
      if (seen.has(k)) continue;
      seen.add(k);
      picks.push({ ...r, week: k });
    }
    if (!picks.length) {
      const sha = (await git(dir, ['rev-parse', 'HEAD'])).trim();
      picks.push({ sha, date: new Date().toISOString(), subject: '', week: Date.now() });
    }
    const out = [];
    for (const p of picks.slice(0, weeks)) out.push({ ...p, ...(await treeWeight(dir, p.sha)) });
    // Biggest single jumps between consecutive samples
    return out.reverse();
  }

  async function imageReport(dir) {
    const raw = await git(dir, ['log', '--since=26 weeks ago', '--diff-filter=AM', '--name-only', '--format=%x1e%H%x1f%cI%x1f%s']).catch(() => '');
    const seen = new Map();
    for (const chunk of raw.split('\x1e')) {
      const [head, ...files] = chunk.split('\n');
      if (!head) continue;
      const [sha, date, subject] = head.split('\x1f');
      for (const f of files) if (f && (IMG.test(f) || VID.test(f)) && !seen.has(f)) seen.set(f, { path: f, sha, date, subject, committed: true });
    }
    const st = await git(dir, ['status', '--porcelain=v1', '-z', '-uall']).catch(() => '');
    for (const p of st.split('\0').filter(Boolean)) { const f = p.slice(3); if (IMG.test(f) || VID.test(f)) seen.set(f, { path: f, committed: false }); }
    const items = [];
    for (const it of seen.values()) {
      let bytes = 0;
      try { bytes = fs.statSync(path.join(dir, it.path)).size; } catch { continue; }
      const issues = [];
      if (VID.test(it.path)) {
        // Videos: big is relative, so only flag the heavy ones (and .mov, which browsers handle badly).
        if (bytes > 10 * 1024 * 1024) issues.push('over 10 MB');
        else if (bytes > 2 * 1024 * 1024) issues.push('over 2 MB');
        if (/\.mov$/i.test(it.path)) issues.push('not MP4');
        items.push({ ...it, bytes, issues, kind: 'video' });
        continue;
      }
      if (bytes > 500 * 1024) issues.push('over 500 KB');
      else if (bytes > 250 * 1024) issues.push('over 250 KB');
      if (!MODERN_IMG.test(it.path) && !/favicon|apple-touch|og[-_]?image/i.test(it.path)) issues.push('not WebP');
      items.push({ ...it, bytes, issues });
    }
    items.sort((a, b) => b.issues.length - a.issues.length || b.bytes - a.bytes);
    return items.slice(0, 80);
  }

  // ---------- codebase: languages, frameworks and tooling, read from the files (cached per HEAD) ----------
  const stackCache = new Map(); // dir -> { key, value }
  const LANG = {
    js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JavaScript', ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript',
    css: 'CSS', scss: 'SCSS', sass: 'SCSS', less: 'Less', html: 'HTML', htm: 'HTML', liquid: 'Liquid', md: 'Markdown', mdx: 'MDX',
    vue: 'Vue', svelte: 'Svelte', astro: 'Astro', py: 'Python', rb: 'Ruby', go: 'Go', rs: 'Rust', swift: 'Swift', kt: 'Kotlin', java: 'Java',
    php: 'PHP', c: 'C', h: 'C', cpp: 'C++', cc: 'C++', hpp: 'C++', cs: 'C#', dart: 'Dart', sh: 'Shell', zsh: 'Shell', lua: 'Lua',
    ex: 'Elixir', exs: 'Elixir', scala: 'Scala', sql: 'SQL', yml: 'YAML', yaml: 'YAML', json: 'JSON', toml: 'TOML', njk: 'Nunjucks', hbs: 'Handlebars', erb: 'Ruby',
  };
  // Data and docs formats are left out of the language mix.
  const MINOR = new Set(['Markdown', 'MDX', 'YAML', 'JSON', 'TOML']);
  const SKIP_PATH = /(^|\/)(node_modules|vendor|bower_components|_site|dist|build|out|\.next|\.nuxt|coverage|Pods)\//;
  const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
  async function stack(dir) {
    const key = (await git(dir, ['rev-parse', 'HEAD']).catch(() => '')).trim() + ':' + (await git(dir, ['status', '--porcelain=v1']).catch(() => '')).length;
    const hit = stackCache.get(dir);
    if (hit && hit.key === key) return hit.value;
    const files = (await git(dir, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).catch(() => '')).split('\0').filter(Boolean);
    const bytes = new Map(); let total = 0, counted = 0, size = 0;
    for (const f of files) {
      let b = 0; try { b = fs.statSync(path.join(dir, f)).size; } catch { continue; }
      size += b; counted++;
      if (SKIP_PATH.test(f) || /\.min\.(js|css)$/i.test(f) || /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Gemfile\.lock|Cargo\.lock)$/.test(f)) continue;
      const lang = LANG[path.extname(f).slice(1).toLowerCase()];
      if (!lang) continue;
      if (MINOR.has(lang)) continue; // data and docs don't say what it's written in
      bytes.set(lang, (bytes.get(lang) || 0) + b); total += b;
    }
    const languages = [...bytes].map(([name, b]) => ({ name, bytes: b, share: total ? b / total : 0 })).sort((a, b) => b.bytes - a.bytes);
    const main = languages[0]?.name || '';

    const frameworks = [], tools = [];
    const add = (list, name) => { if (name && !list.includes(name)) list.push(name); };
    let pkg = null; try { pkg = JSON.parse(readText(path.join(dir, 'package.json')) || 'null'); } catch {}
    const deps = pkg ? { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies } : {};
    const has = (d) => Object.prototype.hasOwnProperty.call(deps, d);
    const exists = (f) => fs.existsSync(path.join(dir, f));
    for (const [d, n] of [['next', 'Next.js'], ['nuxt', 'Nuxt'], ['@sveltejs/kit', 'SvelteKit'], ['astro', 'Astro'], ['@remix-run/react', 'Remix'], ['gatsby', 'Gatsby'], ['@angular/core', 'Angular'], ['expo', 'Expo'], ['react-native', 'React Native'], ['electron', 'Electron'], ['@tauri-apps/api', 'Tauri'], ['react', 'React'], ['vue', 'Vue'], ['svelte', 'Svelte'], ['solid-js', 'Solid'], ['preact', 'Preact'], ['express', 'Express'], ['fastify', 'Fastify'], ['hono', 'Hono'], ['@nestjs/core', 'NestJS'], ['@11ty/eleventy', 'Eleventy'], ['remotion', 'Remotion']]) if (has(d)) add(frameworks, n);
    for (const [d, n] of [['typescript', 'TypeScript'], ['vite', 'Vite'], ['webpack', 'webpack'], ['tailwindcss', 'Tailwind CSS'], ['sass', 'Sass'], ['vitest', 'Vitest'], ['jest', 'Jest'], ['@playwright/test', 'Playwright'], ['eslint', 'ESLint'], ['prettier', 'Prettier'], ['@biomejs/biome', 'Biome'], ['storybook', 'Storybook'], ['@storybook/react', 'Storybook'], ['prisma', 'Prisma'], ['drizzle-orm', 'Drizzle'], ['three', 'three.js'], ['gsap', 'GSAP'], ['motion', 'Motion'], ['framer-motion', 'Motion']]) if (has(d)) add(tools, n);
    const gem = readText(path.join(dir, 'Gemfile'));
    if (/['"](jekyll|github-pages)['"]/.test(gem) || (exists('_config.yml') && !pkg)) add(frameworks, 'Jekyll');
    if (/['"]rails['"]/.test(gem)) add(frameworks, 'Rails');
    if (/['"]sinatra['"]/.test(gem)) add(frameworks, 'Sinatra');
    const py = readText(path.join(dir, 'requirements.txt')) + readText(path.join(dir, 'pyproject.toml'));
    for (const [re, n] of [[/\bdjango\b/i, 'Django'], [/\bflask\b/i, 'Flask'], [/\bfastapi\b/i, 'FastAPI'], [/\bstreamlit\b/i, 'Streamlit']]) if (re.test(py)) add(frameworks, n);
    if (exists('hugo.toml') || exists('hugo.yaml') || (exists('config.toml') && exists('archetypes'))) add(frameworks, 'Hugo');
    if (exists('pubspec.yaml')) add(frameworks, /flutter:/.test(readText(path.join(dir, 'pubspec.yaml'))) ? 'Flutter' : 'Dart');
    if (exists('Package.swift')) add(tools, 'Swift Package Manager');
    if (files.some((f) => /\.xcodeproj\//.test(f))) add(tools, 'Xcode');
    if (exists('Dockerfile') || exists('compose.yaml') || exists('docker-compose.yml')) add(tools, 'Docker');
    if (exists('vercel.json') || exists('vercel.ts')) add(tools, 'Vercel');
    if (exists('netlify.toml')) add(tools, 'Netlify');
    if (exists('CNAME') || files.some((f) => f.startsWith('.github/workflows/'))) add(tools, files.some((f) => f.startsWith('.github/workflows/')) ? 'GitHub Actions' : 'GitHub Pages');
    if (!frameworks.length && main === 'HTML') add(frameworks, 'Static site');

    let packageManager = '';
    if (pkg) packageManager = exists('pnpm-lock.yaml') ? 'pnpm' : exists('yarn.lock') ? 'Yarn' : exists('bun.lockb') || exists('bun.lock') ? 'Bun' : 'npm';
    else if (gem) packageManager = 'Bundler';
    else if (exists('Cargo.toml')) packageManager = 'Cargo';
    else if (exists('go.mod')) packageManager = 'Go modules';
    else if (exists('poetry.lock')) packageManager = 'Poetry';
    else if (exists('uv.lock')) packageManager = 'uv';
    else if (exists('requirements.txt')) packageManager = 'pip';
    let runtime = '';
    const nv = (readText(path.join(dir, '.nvmrc')) || readText(path.join(dir, '.node-version'))).trim() || pkg?.engines?.node || '';
    if (nv) runtime = `Node ${nv.replace(/^v/, '')}`;
    else if (pkg) runtime = 'Node';
    const rv = readText(path.join(dir, '.ruby-version')).trim();
    if (rv) runtime = runtime ? `${runtime}, Ruby ${rv}` : `Ruby ${rv}`;
    const gv = readText(path.join(dir, 'go.mod')).match(/^go (\S+)/m);
    if (gv) runtime = `Go ${gv[1]}`;
    const pv = readText(path.join(dir, '.python-version')).trim();
    if (pv) runtime = `Python ${pv}`;
    let license = typeof pkg?.license === 'string' && !/^SEE LICEN[CS]E/i.test(pkg.license) ? pkg.license : '';
    if (!license) {
      const lf = files.find((f) => /^(LICEN[CS]E|COPYING)(\.(md|txt))?$/i.test(f));
      const t = lf ? readText(path.join(dir, lf)).slice(0, 400) : '';
      license = /MIT License/i.test(t) ? 'MIT' : /Apache License/i.test(t) ? 'Apache 2.0' : /GNU GENERAL PUBLIC LICENSE/i.test(t) ? 'GPL' : /BSD/i.test(t) ? 'BSD' : lf ? (t.split('\n').find((l) => l.trim()) || '').replace(/^#+\s*/, '').trim().slice(0, 40) : '';
    }
    const value = { main, languages: languages.slice(0, 8), frameworks, tools, packageManager, runtime, license, files: counted, size };
    stackCache.set(dir, { key, value });
    return value;
  }

  async function lastTag(dir) {
    try { return (await git(dir, ['describe', '--tags', '--abbrev=0'])).trim(); } catch { return ''; }
  }

  const readJson = (req) => new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (d) => { b += d; if (b.length > 2e6) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
  });

  return async function handle(req, res, url, send) {
    const p = url.pathname;
    if (!p.startsWith('/api/x/')) return false;
    const ok = (o) => (send(res, 200, JSON.stringify(o)), true);
    const fail = (e, code = 500) => (send(res, code, JSON.stringify({ error: String(e && e.message || e) })), true);
    if (req.method !== 'GET' && req.headers['x-changes'] !== '1') return fail('Forbidden', 403);
    try {
      if (p === '/api/x/today') {
        const repos = await listRepos();
        const out = await Promise.all(repos.map(async (r) => {
          const [oc, up, br, st, branch] = await Promise.all([
            oldestChange(r.dir), upstreamCounts(r.dir), branches(r.dir), stashes(r.dir),
            git(r.dir, ['rev-parse', '--abbrev-ref', 'HEAD']).then((s) => s.trim()).catch(() => ''),
          ]);
          const stale = br.filter((b) => !b.remote && !b.current && !b.bot && Date.now() - Date.parse(b.date) > 30 * 864e5);
          return { name: r.name, branch, ...oc, ...up, staleBranches: stale.length, stashes: st.length };
        }));
        return ok({ repos: out });
      }
      const name = url.searchParams.get('repo') || '';
      const dir = await repoDir(name);
      if (!dir) return fail('No such repo', 404);

      if (p === '/api/x/state') {
        const [up, br, st, oc, tag] = await Promise.all([upstreamCounts(dir), branches(dir), stashes(dir), oldestChange(dir), lastTag(dir)]);
        return ok({ ...up, branches: br, stashes: st, ...oc, lastTag: tag });
      }
      if (p === '/api/x/graph') {
        const limit = Math.min(2000, Math.max(50, +url.searchParams.get('limit') || 300));
        return ok(await graph(dir, limit, url.searchParams.get('all') !== '0'));
      }
      if (p === '/api/x/commit') return ok(await commitDetail(dir, url.searchParams.get('sha') || ''));
      if (p === '/api/x/weight') return ok({ weeks: await weight(dir, Math.min(104, +url.searchParams.get('weeks') || 26)) });
      if (p === '/api/x/images') return ok({ images: await imageReport(dir) });
      if (p === '/api/x/stack') return ok(await stack(dir));

      if (p === '/api/x/fetch' && req.method === 'POST') {
        const r = await refresh(name, dir, true);
        return ok({ ...(r || await upstreamCounts(dir)), commits: await incoming(dir) });
      }
      if (p === '/api/x/incoming') return ok({ ...(await upstreamCounts(dir)), commits: await incoming(dir), fetchedAt: fetchedAt.get(dir) || 0 });
      if (p === '/api/x/pull' && req.method === 'POST') {
        try { return ok(await pull(dir)); }
        catch (e) { return send(res, 409, JSON.stringify({ error: e.message, code: e.code || 'failed', files: e.files || [] })), true; }
      }
      if (p === '/api/x/push' && req.method === 'POST') {
        const up = await upstreamCounts(dir);
        const branch = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
        const args = up.upstream ? ['push', '--follow-tags'] : ['push', '--follow-tags', '-u', 'origin', branch];
        let out;
        try { out = await git(dir, args); }
        catch (e) {
          const msg = (e.stderr || e.message || '').toString();
          if (/fetch first|non-fast-forward|rejected/i.test(msg)) return send(res, 409, JSON.stringify({ error: 'The remote has commits you don’t have yet. Pull them first, then push.', code: 'behind' })), true;
          throw new Error(msg.trim().split('\n').slice(-3).join(' '));
        }
        return ok({ pushed: true, output: String(out || '') });
      }
      if (p === '/api/x/tag' && req.method === 'POST') {
        const body = await readJson(req);
        const tag = String(body.name || '').trim();
        if (!/^[\w.\-/]+$/.test(tag) || tag.startsWith('-')) return fail('Use a simple tag name like v1.4.0', 400);
        const exists = await git(dir, ['rev-parse', '-q', '--verify', `refs/tags/${tag}`]).then(() => true, () => false);
        if (exists) return fail(`${tag} already exists`, 409);
        await git(dir, ['tag', '-a', '--cleanup=verbatim', tag, '-m', String(body.notes || tag).trim() || tag]);
        if (!body.push) return ok({ tag });
        await git(dir, ['push', 'origin', tag]).catch((e) => { throw new Error('Tagged, but the push failed: ' + String(e.stderr || e.message).trim().split('\n').pop()); });
        // On GitHub, publish it as a Release (not just a tag): with the gh CLI when it's signed in,
        // otherwise hand back GitHub's "new release" page already filled in, so one click publishes it.
        const gh = githubRepo((await git(dir, ['remote', 'get-url', 'origin']).catch(() => '')).trim());
        if (!gh) return ok({ tag });
        const notes = String(body.body || '').trim();
        const made = await ghRelease(dir, tag, notes);
        if (made) return ok({ tag, release: made, published: true });
        const q = new URLSearchParams({ tag, title: tag, body: notes.slice(0, 6000) });
        const page = `https://github.com/${gh}/releases/new?${q}`;
        const [cmd, args] = process.platform === 'darwin' ? ['open', [page]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', page]] : ['xdg-open', [page]];
        execFile(cmd, args, () => {});
        return ok({ tag, release: page, published: false });
      }
      if (p === '/api/x/changelog' && req.method === 'POST') {
        const body = await readJson(req);
        const file = String(body.file || 'CHANGELOG.md');
        if (file.includes('..') || path.isAbsolute(file)) return fail('Bad file name', 400);
        fs.writeFileSync(path.join(dir, file), String(body.markdown || ''));
        return ok({ file });
      }
      if (p === '/api/x/file') {
        // Serves images from the repo for thumbnails. Images only, inside the repo only.
        const rel = url.searchParams.get('path') || '';
        const full = path.resolve(dir, rel);
        if (!full.startsWith(path.resolve(dir) + path.sep) || !IMG.test(full) || !fs.existsSync(full)) return fail('Not found', 404);
        const ext = path.extname(full).slice(1).toLowerCase();
        const type = ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
        res.writeHead(200, { 'content-type': type, 'cache-control': 'max-age=60', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" });
        res.end(fs.readFileSync(full));
        return true;
      }
      return fail('Not found', 404);
    } catch (e) {
      return fail(e);
    }
  };
}
