// Shrink: makes heavy images and videos in a repo lighter, from the Health view.
// Images go through sharp (installed into staged's own folder the first time you ask), videos
// through ffmpeg when it's on the computer. Every file is copied to .git/staged-trash/ first, a
// result is only kept when it's clearly smaller, and the changes land as normal uncommitted edits,
// so you review them in Commit like anything else.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const WIN = process.platform === 'win32';
const RASTER = /\.(png|jpe?g|gif|webp|avif|tiff?)$/i;
const VIDEO = /\.(mp4|m4v|mov|webm)$/i;
const MAX_IMAGE_W = 2400, MAX_VIDEO_W = 1920;
const KEEP_FORMAT = /favicon|apple-touch|(^|[\/_.-])og([-_.]|image)|social|share-card|twitter-card/i;
const KEEP_IF_UNDER = 0.9; // a result has to save at least 10% to be worth the churn
// Text files that may point at an image or video by name.
const TEXT = /\.(html?|md|markdown|mdx|liquid|njk|hbs|erb|scss|sass|css|less|m?[jt]sx?|cjs|vue|svelte|astro|json|ya?ml|toml|xml|txt|webmanifest)$/i;

const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => err ? reject(Object.assign(err, { stderr: String(stderr || '') })) : resolve(String(stdout)));
});

export function shrinkRoutes({ repoDir, here }) {
  const req = createRequire(path.join(here, 'package.json'));
  let installing = null;

  // Resolved fresh each time, so it works straight after the install without a restart.
  async function loadSharp() {
    try { const m = await import(pathToFileURL(req.resolve('sharp')).href); return m.default || m; } catch { return null; }
  }

  let ffmpegPath;
  async function ffmpeg() {
    if (ffmpegPath !== undefined) return ffmpegPath;
    // A background service often has a short PATH, so also look where Homebrew and friends put it.
    const dirs = [...(process.env.PATH || '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/snap/bin'];
    const names = WIN ? ['ffmpeg.exe'] : ['ffmpeg'];
    ffmpegPath = null;
    for (const d of dirs) for (const n of names) { const f = path.join(d, n); if (d && fs.existsSync(f)) { ffmpegPath = f; return f; } }
    return null;
  }

  function installHint() {
    if (process.platform === 'darwin') return 'brew install ffmpeg';
    if (WIN) return 'winget install ffmpeg';
    return 'sudo apt install ffmpeg';
  }

  // npm sits next to the node binary that runs staged, even when PATH doesn't have it.
  function npmCmd() {
    const near = path.join(path.dirname(process.execPath), WIN ? 'npm.cmd' : 'npm');
    return fs.existsSync(near) ? near : (WIN ? 'npm.cmd' : 'npm');
  }

  function setup() {
    installing ||= new Promise((resolve) => {
      const env = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}` };
      const p = spawn(npmCmd(), ['install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock'], { cwd: here, env, shell: WIN });
      let err = '';
      p.stderr.on('data', (d) => { err += d; });
      p.on('error', (e) => { err += e.message; });
      p.on('close', async () => {
        installing = null;
        const ok = !!(await loadSharp());
        resolve(ok ? { sharp: true } : { sharp: false, error: (err.trim().split('\n').filter(Boolean).pop() || 'npm install failed') });
      });
    });
    return installing;
  }

  async function gitDir(dir) {
    const g = (await run('git', ['rev-parse', '--git-dir'], { cwd: dir })).trim();
    return path.isAbsolute(g) ? g : path.join(dir, g);
  }

  // Swap old file names for new ones in the repo's text files. Only exact names: when another file
  // shares the name, the folder has to match too, so an unrelated logo.png elsewhere is left alone.
  async function updateRefs(dir, renames, backup) {
    if (!renames.length) return { count: 0, files: [] };
    const files = (await run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: dir })).split('\0').filter(Boolean);
    const baseCount = new Map();
    for (const f of files) { const b = path.posix.basename(f); baseCount.set(b, (baseCount.get(b) || 0) + 1); }
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rules = [];
    for (const { from, to } of renames) {
      const fromBase = path.posix.basename(from), toBase = path.posix.basename(to);
      const unique = (baseCount.get(fromBase) || 0) <= 1;
      const tail = unique ? fromBase : from.split('/').slice(-2).join('/');
      const toTail = unique ? toBase : to.split('/').slice(-2).join('/');
      for (const [a, b] of [[tail, toTail], [encodeURI(tail), encodeURI(toTail)]]) {
        rules.push({ re: new RegExp(`(?<![\\w.-])${esc(a)}(?![\\w.-])`, 'g'), to: b });
      }
    }
    let count = 0;
    const touched = [];
    for (const f of files) {
      if (!TEXT.test(f)) continue;
      const full = path.join(dir, f);
      let text;
      try { if (fs.statSync(full).size > 2 * 1024 * 1024) continue; text = fs.readFileSync(full, 'utf8'); } catch { continue; }
      let next = text;
      for (const r of rules) next = next.replace(r.re, () => { count++; return r.to; });
      if (next !== text) { backup(f); fs.writeFileSync(full, next); touched.push(f); }
    }
    return { count, files: touched };
  }

  async function shrinkImage(sharp, src, dst) {
    const ext = path.extname(dst).slice(1).toLowerCase();
    const animated = /\.gif$/i.test(src);
    let img = sharp(src, { animated, limitInputPixels: false }).rotate();
    const meta = await img.metadata();
    if ((meta.width || 0) > MAX_IMAGE_W) img = img.resize({ width: MAX_IMAGE_W, withoutEnlargement: true });
    if (ext === 'png') img = img.png({ compressionLevel: 9, palette: true, quality: 85, effort: 8 });
    else if (ext === 'jpg' || ext === 'jpeg') img = img.jpeg({ quality: 80, mozjpeg: true });
    else if (ext === 'avif') img = img.avif({ quality: 55, effort: 6 });
    else img = img.webp({ quality: meta.hasAlpha ? 82 : 78, alphaQuality: 90, effort: 6, smartSubsample: true });
    await img.toFile(dst);
  }

  async function shrinkVideo(bin, src, dst) {
    const webm = /\.webm$/i.test(dst);
    const scale = `scale='min(${MAX_VIDEO_W},iw)':-2`;
    const args = ['-y', '-loglevel', 'error', '-i', src, '-map', '0:v:0', '-map', '0:a:0?', '-vf', scale,
      ...(webm
        ? ['-c:v', 'libvpx-vp9', '-crf', '34', '-b:v', '0', '-row-mt', '1', '-c:a', 'libopus', '-b:a', '96k']
        : ['-c:v', 'libx264', '-crf', '26', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-c:a', 'aac', '-b:a', '128k']),
      dst];
    await run(bin, args, { timeout: 15 * 60 * 1000 });
  }

  async function shrinkOne(dir, rel, ctx) {
    const full = path.resolve(dir, rel);
    if (!full.startsWith(path.resolve(dir) + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) return { path: rel, skipped: 'File not found' };
    const isImg = RASTER.test(rel), isVid = VIDEO.test(rel);
    if (!isImg && !isVid) return { path: rel, skipped: "Can't shrink this kind of file" };
    if (isImg && !ctx.sharp) return { path: rel, skipped: 'Image tools are not installed' };
    if (isVid && !ctx.ffmpeg) return { path: rel, skipped: `Needs ffmpeg (${installHint()})` };
    if (/\.gif$/i.test(rel) && /favicon|apple-touch/i.test(rel)) return { path: rel, skipped: 'Left as is' };

    // Images become WebP (AVIF stays AVIF), videos become MP4 (WebM stays WebM). Same name, new extension.
    const ext = path.extname(rel).toLowerCase();
    // Social cards and icons must stay PNG or JPEG for the sites that read them, so those keep their format.
    const keepFormat = isImg && KEEP_FORMAT.test(rel) && /\.(png|jpe?g)$/i.test(rel);
    const outExt = isImg ? (keepFormat ? ext : ext === '.avif' ? '.avif' : '.webp') : (ext === '.webm' ? '.webm' : '.mp4');
    const outRel = rel.slice(0, -ext.length) + outExt;
    const renamed = outRel !== rel;
    const outFull = path.join(dir, outRel);
    if (renamed && fs.existsSync(outFull)) return { path: rel, skipped: `${path.basename(outRel)} already exists` };

    const before = fs.statSync(full).size;
    const tmp = path.join(os.tmpdir(), `staged-shrink-${process.pid}-${Date.now().toString(36)}${outExt}`);
    try {
      if (isImg) await shrinkImage(ctx.sharp, full, tmp);
      else await shrinkVideo(ctx.ffmpeg, full, tmp);
      const after = fs.statSync(tmp).size;
      if (after > before * KEEP_IF_UNDER) return { path: rel, skipped: 'Already about as small as it gets', before };
      // Keep a copy of the original, like Discard does.
      fs.mkdirSync(path.dirname(path.join(ctx.trash, rel)), { recursive: true });
      fs.copyFileSync(full, path.join(ctx.trash, rel));
      fs.copyFileSync(tmp, outFull);
      if (renamed) fs.rmSync(full, { force: true });
      return { path: rel, newPath: renamed ? outRel : null, before, after };
    } catch (e) {
      return { path: rel, skipped: (e.stderr || e.message || 'Failed').trim().split('\n').pop().slice(0, 200) };
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }

  // A run is one press of Shrink (one file or many). Its log lives next to the originals, so Undo
  // can put everything back: the original files, and any file whose links were rewritten.
  const runsFile = async (dir) => path.join(await gitDir(dir), 'staged-trash', 'shrink-runs.json');
  const readRuns = async (dir) => { try { return JSON.parse(fs.readFileSync(await runsFile(dir), 'utf8')); } catch { return []; } };
  const writeRuns = async (dir, runs) => { const f = await runsFile(dir); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(runs.slice(-20), null, 1)); };
  // A run still matters while its new files aren't committed yet.
  async function pending(dir, run) {
    const out = (run.files || []).map((f) => f.newPath || f.path);
    if (!out.length) return false;
    const st = await run_git(dir, ['status', '--porcelain=v1', '-z', '-uall', '--', ...out]);
    return st.split('\0').some(Boolean);
  }
  const run_git = (dir, args) => run('git', args, { cwd: dir }).catch(() => '');

  const readBody = (r) => new Promise((resolve) => { let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } }); });

  return async function handle(rq, res, url, sendJson) {
    if (!url.pathname.startsWith('/api/shrink/')) return false;
    const ok = (body) => (sendJson(res, 200, JSON.stringify(body)), true);
    const fail = (msg, code = 400) => (sendJson(res, code, JSON.stringify({ error: msg })), true);
    if (rq.method !== 'GET' && rq.headers['x-changes'] !== '1') return fail('Forbidden', 403);
    try {
      if (url.pathname === '/api/shrink/status') {
        return ok({ sharp: !!(await loadSharp()), installing: !!installing, ffmpeg: !!(await ffmpeg()), ffmpegHint: installHint() });
      }
      if (url.pathname === '/api/shrink/setup' && rq.method === 'POST') return ok(await setup());
      if (url.pathname === '/api/shrink/run' && rq.method === 'POST') {
        const body = await readBody(rq);
        const dir = await repoDir(body.repo);
        if (!dir) return fail('Repo not found', 404);
        const paths = [...new Set((body.paths || []).filter((p) => typeof p === 'string'))].slice(0, 200);
        if (!paths.length) return fail('Nothing to shrink');
        const id = /^[a-z0-9]{4,16}$/.test(body.run || '') ? body.run : Date.now().toString(36);
        const ctx = { sharp: paths.some((p) => RASTER.test(p)) ? await loadSharp() : null, ffmpeg: paths.some((p) => VIDEO.test(p)) ? await ffmpeg() : null };
        ctx.trash = path.join(await gitDir(dir), 'staged-trash', 'shrink-' + id);
        const results = [];
        for (const p of paths) results.push(await shrinkOne(dir, p, ctx));
        const runs = await readRuns(dir);
        let entry = runs.find((r) => r.id === id);
        if (!entry) { entry = { id, at: new Date().toISOString(), files: [], refs: [] }; runs.push(entry); }
        const backup = (f) => {
          if (entry.refs.includes(f)) return;
          const to = path.join(ctx.trash, '_links', f);
          fs.mkdirSync(path.dirname(to), { recursive: true });
          fs.copyFileSync(path.join(dir, f), to);
          entry.refs.push(f);
        };
        const renames = results.filter((r) => r.newPath).map((r) => ({ from: r.path, to: r.newPath }));
        const refs = await updateRefs(dir, renames, backup);
        const done = results.filter((r) => r.after != null);
        for (const r of done) entry.files.push({ path: r.path, newPath: r.newPath, before: r.before, after: r.after, links: refs.files.length && r.newPath ? refs.count : 0 });
        if (done.length || entry.files.length) await writeRuns(dir, runs); else await writeRuns(dir, runs.filter((r) => r !== entry));
        return ok({ results, refs: refs.count, saved: done.reduce((s, r) => s + r.before - r.after, 0), shrunk: done.length, run: id });
      }
      if (url.pathname === '/api/shrink/last') {
        const dir = await repoDir(url.searchParams.get('repo'));
        if (!dir) return fail('Repo not found', 404);
        const runs = await readRuns(dir);
        for (let i = runs.length - 1; i >= 0; i--) if (await pending(dir, runs[i])) return ok({ run: runs[i] });
        return ok({ run: null });
      }
      if (url.pathname === '/api/shrink/undo' && rq.method === 'POST') {
        const body = await readBody(rq);
        const dir = await repoDir(body.repo);
        if (!dir) return fail('Repo not found', 404);
        const runs = await readRuns(dir);
        const entry = runs.find((r) => r.id === body.run);
        if (!entry) return fail('That shrink is already undone');
        const trash = path.join(await gitDir(dir), 'staged-trash', 'shrink-' + entry.id);
        const inside = (p) => { const f = path.resolve(dir, p); if (!f.startsWith(path.resolve(dir) + path.sep)) throw new Error('Bad path'); return f; };
        for (const f of entry.files) {
          const orig = path.join(trash, f.path);
          if (!fs.existsSync(orig)) continue;
          fs.mkdirSync(path.dirname(inside(f.path)), { recursive: true });
          fs.copyFileSync(orig, inside(f.path));
          if (f.newPath) fs.rmSync(inside(f.newPath), { force: true });
        }
        for (const f of entry.refs) { const orig = path.join(trash, '_links', f); if (fs.existsSync(orig)) fs.copyFileSync(orig, inside(f)); }
        await writeRuns(dir, runs.filter((r) => r !== entry));
        return ok({ undone: entry.files.length });
      }
      return fail('Not found', 404);
    } catch (e) {
      return fail(e.message || 'Something went wrong', 500);
    }
  };
}
