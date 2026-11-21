// Run: each project's own commands (serve the site, build, test, …) on a button. staged finds them
// from the files a project already has, you can add your own, and it opens the page once a dev
// server says where it is. Commands run in your login shell, so rbenv, nvm and friends are on PATH.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile, execFileSync } from 'node:child_process';

const WIN = process.platform === 'win32';
const SHELL = process.env.SHELL || ['/bin/zsh', '/bin/bash'].find((s) => fs.existsSync(s)) || '/bin/sh';

const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const has = (dir, f) => fs.existsSync(path.join(dir, f));
const URL_RE = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|[\w.-]+\.local)(?::\d+)?(?:\/[^\s'"<>)\]\u001b]*)?/i;
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g;
// Scripts that keep running and serve a page, so they get "open when ready".
const SERVE = /^(dev|start|serve|preview|watch|storybook|develop)(:|$)/i;

function pm(dir) {
  if (has(dir, 'bun.lockb') || has(dir, 'bun.lock')) return 'bun';
  if (has(dir, 'pnpm-lock.yaml')) return 'pnpm';
  if (has(dir, 'yarn.lock')) return 'yarn';
  return 'npm';
}

// What a project can run, best guess first. Each: { id, label, cmd, kind: 'serve' | 'task', from }
export function detect(dir) {
  const out = [];
  const add = (id, label, cmd, kind, from) => { if (!out.some((x) => x.cmd === cmd)) out.push({ id, label, cmd, kind, from }); };
  const gem = read(path.join(dir, 'Gemfile'));
  if (/jekyll|github-pages/.test(gem) || (has(dir, '_config.yml') && !has(dir, 'package.json'))) {
    const bx = gem ? 'bundle exec ' : '';
    add('jekyll:serve', 'Serve site', `${bx}jekyll serve --livereload`, 'serve', 'Jekyll');
    add('jekyll:build', 'Build site', `${bx}jekyll build`, 'task', 'Jekyll');
  }
  const pkgRaw = read(path.join(dir, 'package.json'));
  if (pkgRaw) {
    let pkg = {}; try { pkg = JSON.parse(pkgRaw); } catch {}
    const m = pm(dir), run = m === 'npm' ? 'npm run' : m === 'yarn' ? 'yarn' : `${m} run`;
    const scripts = Object.keys(pkg.scripts || {});
    // serve-like scripts first, then the rest in the file's order
    const order = [...scripts.filter((s) => SERVE.test(s)), ...scripts.filter((s) => !SERVE.test(s))];
    for (const s of order) add(`npm:${s}`, s, s === 'start' && m === 'npm' ? 'npm start' : `${run} ${s}`, SERVE.test(s) ? 'serve' : 'task', 'package.json');
    if (!has(dir, 'node_modules') && Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length) add('npm:install', 'Install packages', `${m} install`, 'task', 'package.json');
  }
  const mk = read(path.join(dir, 'Makefile'));
  for (const [, t] of mk.matchAll(/^([A-Za-z0-9][\w.-]*):(?!=)/gm)) if (!/^\./.test(t)) add(`make:${t}`, `make ${t}`, `make ${t}`, /^(dev|serve|run|start)$/.test(t) ? 'serve' : 'task', 'Makefile');
  if (has(dir, 'Cargo.toml')) { add('cargo:run', 'cargo run', 'cargo run', 'serve', 'Cargo'); add('cargo:test', 'cargo test', 'cargo test', 'task', 'Cargo'); }
  if (has(dir, 'manage.py')) add('django:serve', 'Run server', 'python3 manage.py runserver', 'serve', 'Django');
  if (has(dir, 'go.mod')) { add('go:run', 'go run .', 'go run .', 'serve', 'Go'); add('go:test', 'go test ./...', 'go test ./...', 'task', 'Go'); }
  if (!out.some((x) => x.kind === 'serve') && has(dir, 'index.html')) add('static:serve', 'Serve folder', 'python3 -m http.server 8000', 'serve', 'index.html');
  return out;
}

export function runRoutes({ repoDir, store }) {
  const jobs = new Map(); // `${repo}\0${id}` -> job
  const loadSaved = () => { try { return JSON.parse(fs.readFileSync(store, 'utf8')); } catch { return {}; } };
  const saveSaved = (v) => { fs.mkdirSync(path.dirname(store), { recursive: true }); fs.writeFileSync(store, JSON.stringify(v, null, 2)); };
  const commandsFor = (repo, dir) => {
    const saved = loadSaved()[repo] || {};
    const own = (saved.custom || []).map((c) => ({ ...c, kind: c.kind || 'task', from: 'yours', custom: true }));
    const found = detect(dir).filter((c) => !(saved.hidden || []).includes(c.id));
    const all = [...found, ...own];
    const pin = saved.main && all.find((c) => c.id === saved.main);
    return pin ? [pin, ...all.filter((c) => c !== pin)] : all;
  };
  const view = (j) => ({ id: j.id, label: j.label, cmd: j.cmd, kind: j.kind, state: j.state, code: j.code, url: j.url, at: j.at, ended: j.ended, log: j.log.join('').slice(-12000) });
  const open = (url) => {
    const [cmd, a] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
    execFile(cmd, a, () => {});
  };
  // Stops the command and everything it started (a dev server's watchers, node under npm).
  // Windows has no process groups, so taskkill walks the tree instead.
  const killTree = (j, force) => {
    if (WIN) { try { execFileSync('taskkill', ['/pid', String(j.child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} return; }
    try { process.kill(-j.child.pid, force ? 'SIGKILL' : 'SIGTERM'); } catch { try { j.child.kill(force ? 'SIGKILL' : 'SIGTERM'); } catch {} }
  };
  const stop = (j) => {
    if (j.state !== 'running') return;
    j.state = 'stopping';
    killTree(j, false);
    setTimeout(() => { if (j.state === 'stopping') killTree(j, true); }, 4000).unref();
  };
  // A staged restart shouldn't leave dev servers holding their ports with no way to stop them.
  const killAll = () => { for (const j of jobs.values()) if (j.state === 'running' || j.state === 'stopping') killTree(j, false); };
  process.on('exit', killAll);
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => { killAll(); process.exit(0); });

  function start(repo, dir, c, { openWhenReady }) {
    const key = repo + '\0' + c.id, old = jobs.get(key);
    if (old && (old.state === 'running' || old.state === 'stopping')) return old;
    const env = { ...process.env, FORCE_COLOR: '0', CI: process.env.CI || '', BROWSER: 'none' };
    // A login shell on macOS and Linux, so rbenv, nvm and the rest of your PATH are there. cmd on Windows.
    const child = WIN
      ? spawn(c.cmd, { cwd: dir, shell: true, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(SHELL, ['-ilc', c.cmd], { cwd: dir, detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const j = { ...c, repo, child, state: 'running', code: null, url: null, at: Date.now(), ended: null, log: [], size: 0, openWhenReady };
    const onData = (buf) => {
      // the login shell's own noise about job control isn't the command's output
      const t = String(buf).replace(ANSI, '').replace(/\r(?!\n)/g, '\n').replace(/^.*(no job control in this shell|cannot set terminal process group|Inappropriate ioctl for device).*\n?/gm, '');
      if (!t) return;
      j.log.push(t); j.size += t.length;
      while (j.size > 60000 && j.log.length > 1) j.size -= j.log.shift().length;
      if (!j.url) {
        // the page, not a side channel: Jekyll prints its LiveReload address first
        const line = t.split('\n').find((l) => URL_RE.test(l) && !/live ?reload|websocket|hmr|\bws:/i.test(l) && !/:35729\b/.test(l));
        const m = line && line.match(URL_RE);
        if (m) { j.url = m[0].replace(/0\.0\.0\.0|\[::1?\]/, 'localhost').replace(/[.,;:]+$/, ''); if (j.openWhenReady) open(j.url); }
      }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', (e) => { onData(`\n${e.message}\n`); j.state = 'failed'; j.ended = Date.now(); });
    child.on('exit', (code, sig) => { j.code = code; j.ended = Date.now(); j.state = j.state === 'stopping' || sig ? 'stopped' : code === 0 ? 'done' : 'failed'; });
    jobs.set(key, j);
    return j;
  }

  return async function handle(req, res, url, sendJson) {
    if (!url.pathname.startsWith('/api/run/')) return false;
    const sub = url.pathname.slice('/api/run'.length);
    const ok = (b) => sendJson(res, 200, JSON.stringify(b));
    const fail = (m, code = 400) => sendJson(res, code, JSON.stringify({ error: m }));
    if (req.method !== 'GET' && req.headers['x-changes'] !== '1') return fail('Forbidden', 403), true;
    const repo = url.searchParams.get('repo') || '';
    const dir = await repoDir(repo);
    if (!dir) return fail('No such repo', 404), true;
    const body = req.method === 'POST' ? await new Promise((r) => { let s = ''; req.on('data', (d) => (s += d)); req.on('end', () => { try { r(JSON.parse(s || '{}')); } catch { r({}); } }); }) : {};
    const jobsOf = () => [...jobs.values()].filter((j) => j.repo === repo).map(view);
    try {
      if (sub === '/list' && req.method === 'GET') return ok({ commands: commandsFor(repo, dir), jobs: jobsOf() }), true;
      if (sub === '/start' && req.method === 'POST') {
        const c = commandsFor(repo, dir).find((x) => x.id === body.id);
        if (!c) return fail('That command isn’t there any more. Refresh and try again.', 404), true;
        const j = start(repo, dir, c, { openWhenReady: body.open !== false && c.kind === 'serve' });
        return ok({ job: view(j) }), true;
      }
      if (sub === '/stop' && req.method === 'POST') {
        const j = jobs.get(repo + '\0' + body.id); if (j) stop(j);
        return ok({ stopped: !!j }), true;
      }
      if (sub === '/open' && req.method === 'POST') {
        const j = jobs.get(repo + '\0' + body.id); if (j?.url) open(j.url);
        return ok({ opened: !!j?.url }), true;
      }
      if (sub === '/clear' && req.method === 'POST') {
        const j = jobs.get(repo + '\0' + body.id); if (j && j.state !== 'running' && j.state !== 'stopping') jobs.delete(repo + '\0' + body.id);
        return ok({}), true;
      }
      // Your own commands, and which one is the main button.
      if (sub === '/save' && req.method === 'POST') {
        const all = loadSaved(), mine = all[repo] || (all[repo] = {});
        if (body.add) {
          const cmd = String(body.add.cmd || '').trim(); if (!cmd) return fail('Type a command first'), true;
          const label = String(body.add.label || '').trim() || cmd;
          mine.custom = [...(mine.custom || []), { id: 'own:' + Date.now().toString(36), label, cmd, kind: body.add.kind === 'serve' ? 'serve' : 'task' }];
        }
        if (body.remove) { mine.custom = (mine.custom || []).filter((c) => c.id !== body.remove); if (!String(body.remove).startsWith('own:')) mine.hidden = [...new Set([...(mine.hidden || []), body.remove])]; }
        if ('main' in body) mine.main = body.main || undefined;
        if (body.unhide) mine.hidden = [];
        saveSaved(all);
        return ok({ commands: commandsFor(repo, dir) }), true;
      }
      return fail('Not found', 404), true;
    } catch (e) { return fail(e.message || String(e), 500), true; }
  };
}
