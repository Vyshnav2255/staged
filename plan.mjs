#!/usr/bin/env node
// Machine-readable engine output for editors and coding agents.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MIN_GROUP_LINK_EVIDENCE, readChanges, suggestGroups } from './commit.mjs';
import { cochangeFor, historyStyle, indexHistory, repoIdForPath, styleAcrossRepos, CONFIDENCE_TARGET } from './feature-index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = process.env.STAGED_HOME || (process.platform === 'win32'
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'staged')
  : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'staged'));

const git = (cwd, args) => new Promise((resolve, reject) => execFile('git', args, {
  cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
}, (error, stdout, stderr) => error ? reject(new Error(String(stderr || error.message).trim())) : resolve(stdout)));

function readJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function knownRepos(current) {
  const config = readJson(path.join(CONFIG_DIR, 'config.json'));
  const roots = process.env.STAGED_ROOT ? process.env.STAGED_ROOT.split(path.delimiter) : config.roots || [];
  const dirs = new Set([current, ...(config.repos || [])]);
  const skip = new Set(['node_modules', 'vendor', 'Library', 'Pods', 'dist', 'build']);
  const isRepo = (dir) => fs.existsSync(path.join(dir, '.git'));
  const visit = (dir, depth = 3) => {
    if (isRepo(dir)) { dirs.add(dir); return; }
    if (depth < 1) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) if (entry.isDirectory() && !entry.name.startsWith('.') && !skip.has(entry.name)) visit(path.join(dir, entry.name), depth - 1);
  };
  for (const root of roots) visit(root);
  return [...dirs].filter(isRepo).map((dir) => ({ dir }));
}

export async function buildPlan(repoPath = process.cwd(), { includeDiff = false } = {}) {
  const requested = path.resolve(repoPath);
  const root = (await git(requested, ['rev-parse', '--show-toplevel'])).trim();
  const [branch, head] = await Promise.all([
    git(root, ['branch', '--show-current']).catch(() => ''),
    git(root, ['rev-parse', 'HEAD']).catch(() => ''),
  ]);
  const files = await readChanges(git, root, () => '');
  const index = await indexHistory({ git, dir: root, indexDir: path.join(CONFIG_DIR, 'group-index') });
  const priorStyle = await styleAcrossRepos({ git, repos: knownRepos(root), indexDir: path.join(CONFIG_DIR, 'group-index') });
  const style = historyStyle(index.commits, priorStyle);
  const learnedAll = readJson(path.join(CONFIG_DIR, 'learned.json'));
  const learned = learnedAll[repoIdForPath(root)] || learnedAll[path.basename(root)] || {};
  const groups = suggestGroups(files, {
    cochange: cochangeFor(index, files.map((file) => file.path), priorStyle.crossRepoPairs),
    together: new Set(learned.together || []),
    apart: new Set(learned.apart || []),
    verbs: style.verbs,
    tense: style.tense,
    emojiForType: { ...style.emojiForType, ...(learned.emojiByType || {}) },
  });
  const packageJson = readJson(path.join(HERE, 'package.json'));
  const byPath = new Map(files.map((file) => [file.path, file]));
  const changes = (group) => group.files.map((filePath) => {
    const file = byPath.get(filePath);
    const hunkIds = group.hunks?.[filePath];
    const entry = {
      path: filePath,
      status: file?.status || '?',
      added: file?.add || 0,
      removed: file?.del || 0,
      ...(hunkIds?.length ? { hunks: hunkIds } : {}),
    };
    if (includeDiff && file?.diff) entry.diff = file.diff;
    return entry;
  });

  return {
    schema: 'staged.commit-plan.v1',
    generatedAt: new Date().toISOString(),
    engine: { name: 'staged engine', version: packageJson.version || 'unknown', mode: 'rules', confidenceTarget: CONFIDENCE_TARGET, minimumJoinEvidence: MIN_GROUP_LINK_EVIDENCE },
    repository: { name: path.basename(root), path: root, branch: branch.trim() || null, head: head.trim() || null },
    style: { tense: style.tense, format: style.style.format, historyCommits: index.commits.length },
    summary: {
      changedFiles: files.length,
      suggestedCommits: groups.length,
      reviewGroups: groups.filter((group) => group.review).length,
      additions: files.reduce((sum, file) => sum + file.add, 0),
      removals: files.reduce((sum, file) => sum + file.del, 0),
    },
    groups: groups.map((group, position) => ({
      id: group.id,
      order: position + 1,
      title: group.title,
      type: group.type,
      scope: group.scope || '',
      emoji: group.emoji,
      emojiSuggestions: group.emojiSuggestions || [group.emoji],
      subject: { gitmoji: group.gitmoji, conventional: group.conventional },
      body: group.body || '',
      confidence: group.confidence,
      review: group.review,
      evidence: group.why ? group.why.split('·').map((item) => item.trim()).filter(Boolean) : [],
      changedLines: group.size,
      changes: changes(group),
    })),
    ...(includeDiff ? { diffIncluded: true } : {}),
  };
}

async function main(args) {
  const usage = 'Usage: staged plan [repo-path] [--include-diff]\nPrints a JSON plan from the staged engine; it never commits or edits the repository.';
  if (args.includes('--help') || args.includes('-h')) { process.stdout.write(usage + '\n'); return; }
  const includeDiff = args.includes('--include-diff');
  const positional = args.filter((arg) => !arg.startsWith('--'));
  if (positional.length > 1) throw new Error(usage);
  const plan = await buildPlan(positional[0] || process.cwd(), { includeDiff });
  process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { process.stderr.write(`staged plan: ${error.message}\n`); process.exitCode = 1; });
}
