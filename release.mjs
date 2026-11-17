#!/usr/bin/env node
// Ship a new version of staged. Everyone running it sees "staged x.y.z is ready" within a few hours.
//
//   npm run release                       patch: 0.2.0 -> 0.2.1
//   npm run release -- minor              0.2.0 -> 0.3.0
//   npm run release -- major "A note"     with a line shown at the top of "What's new"
//   npm run release -- 1.0.0
//
// It bumps package.json, commits "🔖 Released x.y.z", tags vx.y.z and pushes both.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { c, logo, pick } from './tui.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const git = (...a) => execFileSync('git', a, { cwd: HERE, encoding: 'utf8' }).trim();
const fail = (msg) => { console.log(`\n  ${c.red('●')} ${msg}\n`); process.exit(1); };

const args = process.argv.slice(2);
const pkgFile = path.join(HERE, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
const [ma, mi, pa] = pkg.version.split('.').map(Number);
const bumps = { patch: `${ma}.${mi}.${pa + 1}`, minor: `${ma}.${mi + 1}.0`, major: `${ma + 1}.0.0` };

console.log(logo('ship a new version'));
if (git('status', '--porcelain')) fail('Commit or stash your changes first, so the release is exactly what you pushed.');
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
if (!/^(main|master)$/.test(branch)) fail(`You're on ${branch}. Releases go out from main.`);

let kind = args.find((a) => bumps[a] || /^\d+\.\d+\.\d+$/.test(a));
const note = args.find((a) => a !== kind) || '';
if (!kind) {
  const last = (() => { try { return git('describe', '--tags', '--abbrev=0', '--match', 'v*'); } catch { return ''; } })();
  const log = git('log', '--format=%s', '--no-merges', ...(last ? [`${last}..HEAD`] : ['-20']));
  const lines = log.split('\n').filter(Boolean);
  if (!lines.length) fail('Nothing new since the last release.');
  console.log(`  ${c.muted(`${lines.length} commit${lines.length > 1 ? 's' : ''} since ${last || 'the start'}:`)}`);
  for (const l of lines.slice(0, 8)) console.log(`    ${l}`);
  if (lines.length > 8) console.log(`    ${c.muted(`and ${lines.length - 8} more`)}`);
  console.log('');
  kind = await pick(`Release ${pkg.version} as`, [
    { value: 'patch', label: bumps.patch, hint: 'fixes and polish' },
    { value: 'minor', label: bumps.minor, hint: 'new things' },
    { value: 'major', label: bumps.major, hint: 'big changes' },
  ]);
  if (!kind) { console.log(`  ${c.muted('Not released.')}\n`); process.exit(0); }
}
const next = bumps[kind] || kind;

pkg.version = next;
fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
git('add', 'package.json');
git('commit', '-q', '-m', `🔖 Released ${next}`);
git('tag', '-a', `v${next}`, '-m', note || `staged ${next}`);
try {
  execFileSync('git', ['push', '--follow-tags', '--quiet', 'origin', branch], { cwd: HERE, stdio: 'inherit' });
} catch {
  fail(`Tagged v${next} here, but couldn't push. Run: git push --follow-tags`);
}
console.log(`  ${c.green('●')} ${c.bold(`Released ${next}`)}\n    ${c.muted("Everyone running staged will see it's ready within a few hours.")}\n`);
