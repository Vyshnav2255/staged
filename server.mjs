#!/usr/bin/env node
// staged: every change across your git repos, on localhost.
//
//   node server.mjs [folder ...]                 asks: keep it running, or just for now
//   node server.mjs --here [folder ...]          run in this Terminal until Ctrl+C
//   node server.mjs --install [folder ...]       keep it running: now and at every login
//   node server.mjs --uninstall                  stop the background copy
//   options: --port 4321  --no-open
//
// This file keeps the web server (app-server.mjs) running and restarts it when the
// app's own code changes, so you never have to start it again by hand.

import { fork, spawn, execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import readline from 'node:readline';
import { buildPlan } from './plan.mjs';
import { c, link, pick, animateLogo, log } from './tui.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, 'app-server.mjs');
const args = process.argv.slice(2);
const LABEL = 'app.staged';
let logoShown = false;

const plistPath = () => path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const unitPath = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user', 'staged.service');
const vbsPath = () => path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'staged.vbs');
const isInstalled = () => [plistPath(), unitPath(), vbsPath()].some((f) => f && fs.existsSync(f));
const portBusy = (port = 4321) => new Promise((res) => {
  const s = net.connect(port, '127.0.0.1');
  s.on('connect', () => { s.destroy(); res(true); });
  s.on('error', () => res(false));
});
const rest = (list, ...flags) => list.filter((a) => !flags.includes(a));
const openUrl = (url) => {
  const [cmd, a] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  execFile(cmd, a, () => {});
};

main();

async function main() {
  if (args[0] === 'plan') {
    const usage = 'Usage: staged plan [repo-path] [--include-diff]';
    if (args.includes('--help') || args.includes('-h')) { console.log(usage); return; }
    const includeDiff = args.includes('--include-diff');
    const positional = args.slice(1).filter((arg) => !arg.startsWith('--'));
    if (positional.length > 1) { console.error(usage); process.exitCode = 2; return; }
    try { process.stdout.write(JSON.stringify(await buildPlan(positional[0] || process.cwd(), { includeDiff }), null, 2) + '\n'); }
    catch (error) { process.stderr.write(`staged plan: ${error.message}\n`); process.exitCode = 1; }
    return;
  }
  if (args.includes('--uninstall')) return uninstall();
  if (args.includes('--install') || args.includes('--background')) return guardedInstall(rest(args, '--install', '--background'));
  if (args.includes('--here') || args.includes('--help') || args.includes('-h') || !process.stdin.isTTY || !process.stdout.isTTY) return supervise(rest(args, '--here'));
  return ask();
}

// Asked when you start staged from a Terminal.
async function ask() {
  await animateLogo(); logoShown = true;
  const url = 'http://localhost:4321';
  if (isInstalled()) {
    const running = await portBusy();
    console.log(running
      ? `  ${c.green('●')} Already running in the background at ${link(url)}\n`
      : `  ${c.amber('●')} Set up to run in the background, but it isn't answering right now.\n`);
    const choice = await pick('What would you like to do?', [
      ...(running ? [{ value: 'open', label: 'Open it', hint: 'in your browser' }] : [{ value: 'restart', label: 'Start it again', hint: 'in the background' }]),
      { value: 'here', label: 'Run here instead', hint: 'stop the background copy, run in this Terminal' },
      { value: 'stop', label: 'Stop it', hint: "and don't start it at login" },
    ]);
    console.log('');
    if (choice === 'open') { openUrl(url); return console.log(`  Opened ${link(url)}\n`); }
    if (choice === 'restart') return install(args);
    if (choice === 'stop') return uninstall();
    if (choice === 'here') { uninstall(true); await new Promise((r) => setTimeout(r, 600)); return supervise(args); }
    return console.log(`  ${c.muted('Nothing changed.')}\n`);
  }
  const choice = await pick('How do you want to run it?', [
    { value: 'keep', label: 'Keep it running', tag: 'recommended', hint: 'always there, starts at login' },
    { value: 'here', label: 'Just for now', hint: 'in this Terminal, until you press Ctrl+C' },
  ]);
  console.log('');
  if (choice === 'keep') return guardedInstall(args);
  if (choice === 'here') return supervise(args);
  console.log(`  ${c.muted('Maybe later.')}\n`);
}

async function guardedInstall(folders) {
  // A copy already running in another Terminal would take the usual address, so ask to close it first.
  if (!isInstalled() && await portBusy()) {
    console.log(`\n  ${c.amber('●')} staged is already running in another Terminal window.\n    Stop it there with Ctrl+C, then run this again.\n`);
    process.exit(1);
  }
  install(folders);
}

// ---------- keep the server running, restart on code changes ----------
function supervise(argv) {
  let child = null, port = null, restarting = false, restarts = 0, timer = null, quitting = false;
  // In a Terminal, single keys drive it: o opens the browser, r restarts, q quits.
  const keys = process.stdin.isTTY && process.stdout.isTTY;
  const onKey = (_, k = {}) => {
    if ((k.ctrl && k.name === 'c') || k.name === 'q') return quit();
    if (k.name === 'o' && port) { openUrl(`http://localhost:${port}`); log(c.blue('↗'), c.muted('opened in your browser')); }
    if (k.name === 'r') restart();
  };
  const listenKeys = () => { if (!keys) return; readline.emitKeypressEvents(process.stdin); process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on('keypress', onKey); };
  const stopKeys = () => { if (!keys) return; process.stdin.off('keypress', onKey); try { process.stdin.setRawMode(false); } catch {} process.stdin.pause(); };
  const quit = () => {
    if (quitting) return;
    quitting = true; stopKeys();
    console.log(`\n  ${c.faint('●')} ${c.muted('Stopped. See you soon.')}\n`);
    if (child) { child.removeAllListeners('exit'); child.on('exit', () => process.exit(0)); child.kill('SIGTERM'); setTimeout(() => process.exit(0), 1500).unref(); }
    else process.exit(0);
  };

  const start = () => {
    const env = { ...process.env };
    let a = argv;
    if (port) { // after a restart, keep the same address and don't open another tab
      a = argv.filter((x, i) => x !== '--port' && argv[i - 1] !== '--port');
      Object.assign(env, { STAGED_PORT: String(port), STAGED_NO_OPEN: '1', STAGED_RESTART: '1' });
    }
    if (keys) env.STAGED_KEYS = '1';
    child = fork(APP, a, { env, stdio: 'inherit' });
    child.on('message', (m) => {
      if (m && m.port) port = m.port;
      if (m && m.restart) m.self ? relaunch() : schedule();
    });
    child.on('exit', (code, signal) => {
      child = null;
      if (restarting) { restarting = false; return start(); }
      if (code === 0 || signal === 'SIGINT' || signal === 'SIGTERM') process.exit(code || 0);
      if (restarts > 0) log(c.red('✕'), `staged stopped with an error. ${c.muted('It starts again when you save a fix.')}`);
      else process.exit(code || 1);
    });
  };

  const restart = () => {
    restarts++;
    if (!child) return start();
    restarting = true;
    child.kill('SIGTERM');
  };

  // Restart only when a file's contents change: macOS also reports reads and touches.
  const sumOf = (f) => { try { return crypto.createHash('md5').update(fs.readFileSync(path.join(HERE, f))).digest('hex'); } catch { return null; } };
  const sums = new Map(fs.readdirSync(HERE).filter((f) => /\.mjs$/.test(f)).map((f) => [f, sumOf(f)]));
  const schedule = () => { if (relaunched) return; clearTimeout(timer); timer = setTimeout(restart, 150); };
  // An update changed this file too: start a fresh supervisor with the new code and step aside.
  let relaunched = false;
  const relaunch = () => {
    if (relaunched) return;
    relaunched = true;
    clearTimeout(timer);
    const next = () => {
      stopKeys();
      const env = { ...process.env, STAGED_RESTART: '1', STAGED_NO_OPEN: '1', ...(port ? { STAGED_PORT: String(port) } : {}) };
      const kid = spawn(process.execPath, [path.join(HERE, 'server.mjs'), '--here', ...argv.filter((x, i) => x !== '--port' && argv[i - 1] !== '--port')], { env, stdio: 'inherit' });
      for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) { process.removeAllListeners(sig); process.on(sig, () => { kid.kill(sig); process.exit(0); }); }
      kid.on('exit', (code) => process.exit(code || 0));
    };
    if (!child) return next();
    child.removeAllListeners('exit');
    child.on('exit', next);
    child.kill('SIGTERM');
  };
  fs.watch(HERE, (_, file) => {
    if (!file || !/\.mjs$/.test(file) || file === 'server.mjs') return;
    const sum = sumOf(file);
    if (sums.get(file) === sum) return;
    sums.set(file, sum);
    clearTimeout(timer);
    if (!relaunched) timer = setTimeout(restart, 150);
  });

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { if (child) child.kill(sig); process.exit(0); });
  (async () => {
    if (!logoShown && !process.env.STAGED_RESTART && process.stdout.isTTY) await animateLogo();
    listenKeys();
    start();
  })();
}

// ---------- start at login ----------
function install(folders) {
  const node = process.execPath;
  const runArgs = [path.join(HERE, 'server.mjs'), '--no-open', ...folders.map((f) => path.resolve(f.replace(/^~(?=$|[/\\])/, os.homedir())))];
  const url = 'http://localhost:4321';
  const home = os.homedir();

  if (process.platform === 'darwin') {
    const plist = path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
    const log = path.join(home, 'Library', 'Logs', 'staged.log');
    const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const exe = macApp(node, runArgs);
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>${(exe ? [exe] : [node, ...runArgs]).map((a) => `<string>${xml(a)}</string>`).join('')}</array>
  <key>AssociatedBundleIdentifiers</key><string>${LABEL}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(process.env.PATH || '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin')}</string></dict>
  <key>WorkingDirectory</key><string>${xml(HERE)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`);
    const uid = process.getuid();
    try { execFileSync('launchctl', ['bootout', `gui/${uid}/${LABEL}`], { stdio: 'ignore' }); } catch {}
    execFileSync('launchctl', ['bootstrap', `gui/${uid}`, plist]);
    done(url);
  } else if (process.platform === 'linux') {
    const unit = path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'systemd', 'user', 'staged.service');
    fs.mkdirSync(path.dirname(unit), { recursive: true });
    fs.writeFileSync(unit, `[Unit]\nDescription=staged\n\n[Service]\nExecStart=${[node, ...runArgs].map((a) => JSON.stringify(a)).join(' ')}\nEnvironment=PATH=${process.env.PATH}\nRestart=always\n\n[Install]\nWantedBy=default.target\n`);
    execFileSync('systemctl', ['--user', 'daemon-reload']);
    execFileSync('systemctl', ['--user', 'enable', '--now', 'staged.service']);
    done(url);
  } else if (process.platform === 'win32') {
    const startup = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'staged.vbs');
    const cmd = [node, ...runArgs].map((a) => `""${a}""`).join(' ');
    fs.writeFileSync(startup, `CreateObject("WScript.Shell").Run "${cmd}", 0, False\r\n`);
    execFile('wscript', [startup], () => {});
    done(url);
  } else {
    console.log(`  Starting at login isn't supported on ${process.platform} yet. Run "node server.mjs" instead.`);
  }
}

// macOS names a login item after the program it runs, which would be "node". So the item runs a
// tiny staged.app instead: a launcher script with the staged name and icon, kept in Application
// Support. Returns the launcher's path, or null if it couldn't be made (then node runs directly).
function macApp(node, runArgs) {
  try {
    const app = path.join(os.homedir(), 'Library', 'Application Support', 'staged', 'staged.app');
    const q = (a) => `'${a.replace(/'/g, `'\\''`)}'`;
    fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
    fs.mkdirSync(path.join(app, 'Contents', 'Resources'), { recursive: true });
    fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>staged</string>
  <key>CFBundleDisplayName</key><string>staged</string>
  <key>CFBundleIdentifier</key><string>${LABEL}</string>
  <key>CFBundleExecutable</key><string>staged</string>
  <key>CFBundleIconFile</key><string>staged</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8')).version || '1.0'}</string>
  <key>LSUIElement</key><true/>
  <key>LSBackgroundOnly</key><true/>
</dict></plist>
`);
    fs.copyFileSync(path.join(HERE, 'public', 'brand', 'staged.icns'), path.join(app, 'Contents', 'Resources', 'staged.icns'));
    const exe = path.join(app, 'Contents', 'MacOS', 'staged');
    fs.writeFileSync(exe, `#!/bin/bash\n# Starts staged. Made by "npm start"; safe to delete, it's remade when needed.\ncd ${q(HERE)} && exec -a staged ${[node, ...runArgs].map(q).join(' ')}\n`, { mode: 0o755 });
    fs.chmodSync(exe, 0o755);
    try { execFileSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', app], { stdio: 'ignore' }); } catch {}
    return exe;
  } catch { return null; }
}

function uninstall(quiet = false) {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    const plist = path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
    try { execFileSync('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`], { stdio: 'ignore' }); } catch {}
    fs.rmSync(plist, { force: true });
  } else if (process.platform === 'linux') {
    try { execFileSync('systemctl', ['--user', 'disable', '--now', 'staged.service'], { stdio: 'ignore' }); } catch {}
    fs.rmSync(path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'systemd', 'user', 'staged.service'), { force: true });
  } else if (process.platform === 'win32') {
    fs.rmSync(path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'staged.vbs'), { force: true });
    console.log('  Removed. staged stops after you sign out, or end the "node" task now.');
  }
  if (!quiet) console.log(`  ${c.muted('●')} Stopped. staged won't start at login any more.\n    Run ${c.bold('npm start')} whenever you want it back.\n`);
}

// Kept short on purpose: what happened, where it is, and how to stop it.
function done(url) {
  console.log(`  ${c.green('●')} ${c.bold('staged is running')} ${c.muted('and starts by itself when you log in')}`);
  console.log(`    ${link(url)}\n`);
  console.log(`    ${c.muted('To stop it, run')} ${c.ink('npm run remove')}\n`);
  setTimeout(() => openUrl(url), 1200);
}
