// Local indexes for feature grouping. The persistent index contains Git metadata only:
// commit IDs, subjects, and changed paths. It never stores file contents or diffs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const GROUP_INDEX_SCHEMA = 2;
export const CONFIDENCE_TARGET = 0.90;
const MAX_COMMITS = 2000;
const MAX_COCHANGE_FILES = 30;
const LEAD_EMOJI = /^\s*(\p{Extended_Pictographic}[\uFE0F\u200D\p{Extended_Pictographic}]*)\s*([A-Z][a-z]+)/u;

export function repoIdForPath(dir) {
  let root = path.resolve(dir);
  try { root = fs.realpathSync(root); } catch {}
  return crypto.createHash('sha256').update(root).digest('hex').slice(0, 24);
}

function parseLog(raw) {
  return raw.split('\x1e').filter(Boolean).map((chunk) => {
    const [header = '', ...names] = chunk.split('\n');
    const [sha = '', ...subject] = header.split('\x1f');
    return { sha, subject: subject.join('\x1f'), files: [...new Set(names.filter(Boolean))] };
  }).filter((c) => c.sha);
}

function readIndex(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value?.schema === GROUP_INDEX_SCHEMA ? value : null;
  } catch { return null; }
}

function fileCommitIndex(commits) {
  const out = Object.create(null);
  commits.forEach((commit, i) => {
    // Downweight releases, format-only sweeps, and other unusually broad commits instead of
    // dropping them entirely. Recent focused commits contribute the strongest signal.
    const breadth = commit.files.length > 200 ? 0.04 : commit.files.length > 80 ? 0.12 : commit.files.length > 30 ? 0.35 : 1;
    const weight = Math.exp(-i / 500) * breadth;
    for (const file of commit.files) (out[file] ||= []).push([i, weight]);
  });
  return out;
}

function saveIndex(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(value));
    fs.renameSync(temp, file);
  } catch {}
}

export async function indexHistory({ git, dir, indexDir }) {
  const head = (await git(dir, ['rev-parse', 'HEAD']).catch(() => '')).trim();
  const root = (await git(dir, ['rev-parse', '--show-toplevel']).catch(() => path.resolve(dir))).trim() || path.resolve(dir);
  const repoId = repoIdForPath(root);
  const file = path.join(indexDir, repoId + '.json');
  const saved = readIndex(file);
  let commits, status;

  if (saved?.repoId === repoId && saved.indexedHead === head) {
    commits = saved.commits || [];
    status = 'cached';
  } else {
    let appended = null;
    if (saved?.repoId === repoId && saved.indexedHead && head) {
      try {
        await git(dir, ['merge-base', '--is-ancestor', saved.indexedHead, head]);
        const raw = await git(dir, ['log', '--no-merges', '--name-only', '--format=%x1e%H%x1f%s', saved.indexedHead + '..' + head]);
        appended = parseLog(raw);
      } catch {}
    }
    if (appended) {
      commits = [...appended, ...(saved.commits || [])].slice(0, MAX_COMMITS);
      status = 'incremental';
    } else {
      const raw = head ? await git(dir, ['log', '-n', String(MAX_COMMITS), '--no-merges', '--name-only', '--format=%x1e%H%x1f%s']).catch(() => '') : '';
      commits = parseLog(raw).slice(0, MAX_COMMITS);
      status = 'rebuilt';
    }
    saveIndex(file, {
      schema: GROUP_INDEX_SCHEMA,
      repoId,
      indexedHead: head,
      indexedAt: new Date().toISOString(),
      commits,
    });
  }

  return {
    schema: GROUP_INDEX_SCHEMA,
    repoId,
    head,
    indexedAt: saved?.repoId === repoId && saved.indexedHead === head ? saved.indexedAt : new Date().toISOString(),
    status,
    commits,
    fileCommits: fileCommitIndex(commits),
    indexedFiles: new Set(commits.flatMap((c) => c.files)).size,
  };
}

function intersectionCount(a, b) {
  let i = 0, j = 0, n = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { n++; i++; j++; }
    else if (a[i] < b[j]) i++;
    else j++;
  }
  return n;
}

function sharedWeight(a, b) {
  let i = 0, j = 0, total = 0;
  while (i < a.length && j < b.length) {
    if (a[i][0] === b[j][0]) { total += Math.min(a[i][1], b[j][1]); i++; j++; }
    else if (a[i][0] < b[j][0]) i++;
    else j++;
  }
  return total;
}

function totalWeight(posting) { return posting.reduce((sum, item) => sum + item[1], 0); }

export function cochangeFor(index, paths, crossRepoPairs = new Map()) {
  const wanted = [...new Set(paths)];
  const byFile = index.fileCommits || {};
  const out = new Map();
  for (let i = 0; i < wanted.length; i++) for (let j = i + 1; j < wanted.length; j++) {
    const a = wanted[i], b = wanted[j];
    const key = a < b ? a + '\0' + b : b + '\0' + a;
    const prior = crossRepoPairs.get(key) || 0;
    const left = byFile[a] || [], right = byFile[b] || [];
    if (!left.length || !right.length) { if (prior) out.set(key, prior); continue; }
    const shared = sharedWeight(left, right);
    const score = shared / Math.max(0.001, Math.min(totalWeight(left), totalWeight(right)));
    // Shrink tiny samples so a single broad/recent commit cannot create a strong learned link.
    const confidence = shared >= 1.5 ? score * (shared / (shared + 1.25)) : 0;
    const combined = Math.max(confidence >= 0.34 ? confidence : 0, prior);
    if (combined) out.set(key, combined);
  }
  return out;
}

// A per-change inverted index: common terms are dropped by IDF, and the remaining postings
// provide candidate edges without comparing every pair of hunks.
export function buildTermIndex(docs, identities = docs.map((_, i) => String(i))) {
  const df = new Map();
  const n = new Set(docs.map((doc, i) => doc ? identities[i] : null).filter(Boolean)).size || 1;
  const seenIn = new Map();
  for (let i = 0; i < docs.length; i++) if (docs[i]) for (const term of docs[i].keys()) {
    if (!seenIn.has(term)) seenIn.set(term, new Set());
    seenIn.get(term).add(identities[i]);
  }
  for (const [term, ids] of seenIn) df.set(term, ids.size);

  const vectors = docs.map((doc) => {
    if (!doc) return null;
    const vector = new Map();
    for (const [term, tf] of doc) {
      const count = df.get(term);
      if (count > Math.max(2, n * 0.5)) continue;
      vector.set(term, (1 + Math.log(tf)) * Math.log((n + 1) / count));
    }
    if (!vector.size) return null;
    let norm = 0;
    for (const weight of vector.values()) norm += weight * weight;
    norm = Math.sqrt(norm) || 1;
    for (const [term, weight] of vector) vector.set(term, weight / norm);
    return vector;
  });

  const postings = new Map();
  vectors.forEach((vector, i) => {
    if (vector) for (const term of vector.keys()) {
      if (!postings.has(term)) postings.set(term, []);
      postings.get(term).push(i);
    }
  });
  return {
    vectors,
    terms: postings.size,
    mayOverlap(left, right) {
      const target = new Set(right);
      for (const i of left) for (const term of vectors[i]?.keys() || []) {
        for (const j of postings.get(term) || []) if (target.has(j)) return true;
      }
      return false;
    },
  };
}

function styleStats(commits) {
  const formats = { gitmoji: 0, conventional: 0, plain: 0 };
  const scopes = { withScope: 0, totalConventional: 0 };
  const lengths = [];
  const tense = { past: 0, imperative: 0 };
  const verbs = {};
  const types = {};
  const emojiTypes = {};
  const emojiClass = { '✨': 'feat', '🎉': 'feat', '🚸': 'feat', '🌟': 'feat', '📈': 'feat', '🚀': 'chore', '🐛': 'fix', '🚑': 'fix', '🩹': 'fix', '🔒': 'fix', '🚨': 'fix', '✏': 'docs', '💄': 'style', '💫': 'style', '🎨': 'style', '📱': 'style', '⚡': 'perf', '♻': 'refactor', '🔥': 'refactor', '⚰': 'refactor', '🚚': 'refactor', '🏗': 'refactor', '📝': 'docs', '📚': 'docs', '📄': 'docs', '💬': 'docs', '💡': 'docs', '🔧': 'chore', '🔨': 'chore', '🙈': 'chore', '🍱': 'chore', '📦': 'build', '⬆': 'build', '⬇': 'build', '➕': 'build', '➖': 'build', '📌': 'build', '✅': 'test', '🧪': 'test', '👷': 'ci', '💚': 'ci' };
  const stripEmoji = (s) => s.replace(/^\s*\p{Extended_Pictographic}[\uFE0F\u200D\p{Extended_Pictographic}]*\s*/u, '');
  for (const commit of commits) {
    const subject = (commit.subject || '').trim();
    if (!subject || /^(merge\b|revert\b|fixup!|squash!)/i.test(subject) || /\b(?:formatting sweep|generated files?)\b/i.test(subject)) continue;
    lengths.push(subject.length);
    const plain = stripEmoji(subject);
    const conventional = plain.match(/^([a-z]+)(?:\(([^)]+)\))?!?:\s+(.+)$/i);
    if (/^\s*\p{Extended_Pictographic}/u.test(subject)) formats.gitmoji++;
    else if (conventional) {
      formats.conventional++;
      scopes.totalConventional++;
      if (conventional[2]) scopes.withScope++;
      types[conventional[1].toLowerCase()] = (types[conventional[1].toLowerCase()] || 0) + 1;
    } else formats.plain++;
    const first = (conventional?.[3] || plain).match(/^[A-Za-z]+/)?.[0]?.toLowerCase() || '';
    if (/^(added|fixed|updated|removed|refined|polished|renamed|moved|improved|changed|created|deleted|cleaned|made|used|bumped|implemented|replaced|tweaked|enhanced)$/.test(first)) tense.past++;
    else if (/^(add|fix|update|remove|refine|polish|rename|move|improve|change|create|delete|clean|make|use|bump|implement|replace|tweak|refactor|enhance|refresh|preserve|avoid|support|handle|prevent|allow|ensure|reduce|increase|simplify)$/.test(first)) tense.imperative++;
    const emoji = subject.match(LEAD_EMOJI);
    if (emoji && /ed$/.test(emoji[2])) {
      const key = emoji[1].replace(/\uFE0F/g, '') + '\0' + emoji[2];
      verbs[key] = (verbs[key] || 0) + 1;
    }
    const leadEmoji = subject.match(/^\s*(\p{Extended_Pictographic}[\uFE0F\u200D\p{Extended_Pictographic}]*)/u)?.[1]?.replace(/\uFE0F/g, '');
    const category = conventional?.[1]?.toLowerCase() || emojiClass[leadEmoji];
    if (leadEmoji && category) {
      const key = `${category}\0${leadEmoji}`;
      emojiTypes[key] = (emojiTypes[key] || 0) + 1;
    }
  }
  return { count: lengths.length, formats, scopes, lengths, tense, verbs, types, emojiTypes };
}

function combineStyleProfiles(profiles) {
  const valid = profiles.filter((p) => p?.count);
  const weight = (p) => Math.min(1, p.count / 30);
  const formatTotals = { gitmoji: 0, conventional: 0, plain: 0 };
  const verbTotals = {};
  const emojiTotals = {};
  let past = 0, imperative = 0, repositories = 0, commitSamples = 0, weightedLength = 0, lengthWeight = 0;
  for (const p of valid) {
    const w = weight(p);
    if (w > 0) repositories++;
    commitSamples += p.count;
    for (const k of Object.keys(formatTotals)) formatTotals[k] += p.formats[k] / p.count * w;
    past += p.tense.past / p.count * w;
    imperative += p.tense.imperative / p.count * w;
    if (p.lengths.length) { const avg = p.lengths.reduce((a, b) => a + b, 0) / p.lengths.length; weightedLength += avg * w; lengthWeight += w; }
    for (const [key, count] of Object.entries(p.verbs)) verbTotals[key] = (verbTotals[key] || 0) + count / p.count * w;
    for (const [key, count] of Object.entries(p.emojiTypes)) emojiTotals[key] = (emojiTotals[key] || 0) + count / p.count * w;
  }
  const verbs = {};
  for (const [key, rate] of Object.entries(verbTotals)) if (rate >= 0.12) {
    const [emoji, verb] = key.split('\0');
    if (!verbs[emoji] || verbTotals[emoji + '\0' + verbs[emoji]] < rate) { verbs[emoji] = verb; verbs[emoji + '\uFE0F'] = verb; }
  }
  const totalFormat = Object.values(formatTotals).reduce((a, b) => a + b, 0) || 1;
  const strongest = Object.entries(formatTotals).sort((a, b) => b[1] - a[1])[0]?.[0] || 'plain';
  const emojiForType = {};
  for (const type of ['feat', 'fix', 'style', 'perf', 'refactor', 'remove', 'docs', 'chore', 'build', 'test', 'ci']) {
    const options = Object.entries(emojiTotals).filter(([key]) => key.startsWith(type + '\0')).sort((a, b) => b[1] - a[1]);
    if (options[0]?.[1] >= 0.18 && options[0][1] >= (options[1]?.[1] || 0) * 1.25) emojiForType[type] = options[0][0].split('\0')[1];
  }
  return {
    repositories,
    commits: commitSamples,
    format: strongest,
    formatShare: formatTotals[strongest] / totalFormat,
    tense: imperative > past ? 'imperative' : 'past',
    tenseConfidence: Math.abs(imperative - past) / Math.max(0.001, imperative + past),
    averageSubjectLength: lengthWeight ? Math.round(weightedLength / lengthWeight) : 0,
    verbs,
    emojiForType,
    source: 'local-repositories',
  };
}

export async function styleAcrossRepos({ git, repos, indexDir }) {
  const histories = await Promise.all(repos.map(async (repo) => {
    const dir = typeof repo === 'string' ? repo : repo.dir;
    if (!dir) return null;
    try { return await indexHistory({ git, dir, indexDir }); } catch { return null; }
  }));
  const usable = histories.filter(Boolean);
  const profile = combineStyleProfiles(usable.map((h) => styleStats(h.commits.slice(0, 600))));
  // Mine repeated relative-path pairs across repos as a weak grouping prior. Require recurrence
  // in multiple repositories so a single project's architecture cannot become a global rule.
  const pairCounts = new Map();
  usable.forEach((history) => {
    const repoPairs = new Map();
    for (const commit of history.commits.slice(0, 700)) {
      if (commit.files.length < 2 || commit.files.length > MAX_COCHANGE_FILES || /^(merge\b|revert\b|fixup!|squash!)/i.test(commit.subject)) continue;
      const files = [...new Set(commit.files.map((p) => p.replaceAll('\\', '/').replace(/^\.\//, '')))].sort();
      for (let i = 0; i < files.length; i++) for (let j = i + 1; j < files.length; j++) {
        const key = files[i] + '\0' + files[j];
        repoPairs.set(key, (repoPairs.get(key) || 0) + 1);
      }
    }
    for (const [key, count] of repoPairs) {
      if (!pairCounts.has(key)) pairCounts.set(key, { count: 0, repos: 0 });
      const stat = pairCounts.get(key); stat.count += count; stat.repos++;
    }
  });
  const crossRepoPairs = new Map();
  for (const [key, stat] of pairCounts) if (stat.count >= 4 && stat.repos >= 2) {
    crossRepoPairs.set(key, Math.min(0.72, 0.5 + (stat.count - 4) * 0.02 + (stat.repos - 2) * 0.035));
  }
  return {
    ...profile,
    indexedRepos: usable.length,
    indexedCommits: usable.reduce((sum, history) => sum + history.commits.length, 0),
    indexedFiles: usable.reduce((sum, history) => sum + history.indexedFiles, 0),
    crossRepoPairs,
  };
}

export function historyStyle(commits, prior = null) {
  const counts = {};
  const emojiTypes = { ...(prior?.emojiForType || {}) };
  const localEmojis = {};
  for (const commit of commits.slice(0, 600)) {
    const match = commit.subject.match(LEAD_EMOJI);
    if (!match || !/ed$/.test(match[2])) continue;
    const emoji = match[1].replace(/\uFE0F/g, '');
    (counts[emoji] ||= {})[match[2]] = ((counts[emoji] || {})[match[2]] || 0) + 1;
  }
  const verbs = { ...(prior?.verbs || {}) };
  for (const [emoji, values] of Object.entries(counts)) {
    const best = Object.entries(values).sort((a, b) => b[1] - a[1])[0];
    if (best && best[1] >= 3) { verbs[emoji] = best[0]; verbs[emoji + '\uFE0F'] = best[0]; }
  }
  const emojiClass = { '✨': 'feat', '🎉': 'feat', '🚸': 'feat', '🌟': 'feat', '📈': 'feat', '🚀': 'chore', '🐛': 'fix', '🚑': 'fix', '🩹': 'fix', '🔒': 'fix', '🚨': 'fix', '✏': 'docs', '💄': 'style', '💫': 'style', '🎨': 'style', '📱': 'style', '⚡': 'perf', '♻': 'refactor', '🔥': 'refactor', '⚰': 'refactor', '🚚': 'refactor', '🏗': 'refactor', '📝': 'docs', '📚': 'docs', '📄': 'docs', '💬': 'docs', '💡': 'docs', '🔧': 'chore', '🔨': 'chore', '🙈': 'chore', '🍱': 'chore', '📦': 'build', '⬆': 'build', '⬇': 'build', '➕': 'build', '➖': 'build', '📌': 'build', '✅': 'test', '🧪': 'test', '👷': 'ci', '💚': 'ci' };
  for (const commit of commits.slice(0, 600)) {
    const lead = commit.subject.match(/^\s*(\p{Extended_Pictographic}[\uFE0F\u200D\p{Extended_Pictographic}]*)/u)?.[1]?.replace(/\uFE0F/g, '');
    if (!lead || !emojiClass[lead]) continue;
    const category = emojiClass[lead];
    (localEmojis[category] ||= {})[lead] = ((localEmojis[category] || {})[lead] || 0) + 1;
  }
  for (const [category, values] of Object.entries(localEmojis)) {
    const ranked = Object.entries(values).sort((a, b) => b[1] - a[1]);
    const [best, second] = ranked;
    if (best?.[1] >= 5 && best[1] >= (second?.[1] || 0) * 1.35) emojiTypes[category] = best[0];
  }
  const localProfile = styleStats(commits.slice(0, 600));
  const past = localProfile.tense.past, imperative = localProfile.tense.imperative;
  const localTenseSamples = past + imperative;
  const tense = localTenseSamples >= 6 ? (imperative > past ? 'imperative' : 'past') : prior?.tense || (imperative > past ? 'imperative' : 'past');
  const localFormat = Object.entries(localProfile.formats).sort((a, b) => b[1] - a[1])[0]?.[0] || 'plain';
  const styleSamples = localProfile.count;
  const format = styleSamples >= 12 ? localFormat : prior?.format || localFormat;
  return { verbs, tense, emojiForType: emojiTypes, style: { source: styleSamples >= 12 ? 'repository-history' : prior?.source || 'local-repository-prior', localSamples: styleSamples, ...(prior ? { learnedFromRepos: prior.repositories, styleSamples: prior.commits, format, averageSubjectLength: prior.averageSubjectLength } : { format }) } };
}
