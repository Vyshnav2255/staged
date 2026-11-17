// Updates staged from inside the app. A release is a git tag like v0.3.0 on the repo staged was
// cloned from. staged checks for new tags now and then, shows what's new, and on "Update"
// fast-forwards its own folder to the tag. The supervisor then restarts it and the page reloads.
import fs from 'node:fs';
import path from 'node:path';

const EVERY = 6 * 60 * 60 * 1000; // look for a new release every 6 hours
const semver = (t) => { const m = String(t).match(/^v?(\d+)\.(\d+)\.(\d+)$/); return m ? [+m[1], +m[2], +m[3]] : null; };
const newer = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]; return false; };
const TYPES = [
  ['feature', /^(✨|🎉|🚀|feat\b)/u, 'New'],
  ['design', /^(💄|💫|🎨|🍱|style\b)/u, 'Look and feel'],
  ['fix', /^(🐛|🚑️?|🩹|fix\b)/u, 'Fixes'],
  ['perf', /^(⚡️?|perf\b)/u, 'Faster'],
];

export function updater({ dir, git, onUpdated }) {
const pkgVersion = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version; } catch { return '0.0.0'; } };
  // The version you're on is the newest release tag already in this copy (a GitHub release is a tag),
  // so it works even when package.json wasn't bumped. Falls back to package.json.
  let tagNow = '';
  const versionNow = () => {
    const a = semver(tagNow), b = semver(pkgVersion());
    return a && (!b || newer(a, b) || a.join('.') === b.join('.')) ? tagNow.replace(/^v/, '') : pkgVersion();
  };
  const readTagNow = async () => { tagNow = (await git(dir, ['describe', '--tags', '--abbrev=0']).catch(() => '')).trim(); };
  let state = { current: versionNow(), latest: null, checkedAt: 0, error: '', busy: false };
  const isRepo = fs.existsSync(path.join(dir, '.git'));

  async function check(force = false) {
    if (!isRepo || state.busy) return state;
    if (!force && Date.now() - state.checkedAt < EVERY) return state;
    state.checkedAt = Date.now();
    try {
      await git(dir, ['fetch', '--tags', '--quiet', '--no-recurse-submodules', 'origin']);
      state.error = '';
    } catch (e) {
      state.error = 'offline'; // no network, or no access to the repo: try again later, quietly
    }
    await readTagNow();
    state.current = versionNow();
    const cur = semver(state.current) || [0, 0, 0];
    const tags = (await git(dir, ['tag', '--list']).catch(() => '')).split('\n').map((t) => t.trim()).filter((t) => semver(t));
    const best = tags.filter((t) => newer(semver(t), cur)).sort((a, b) => (newer(semver(a), semver(b)) ? -1 : 1))[0];
    state.latest = best ? await describe(best) : null;
    return state;
  }

  // What's in the release: the tag's own note, plus the commits since this version, grouped.
  // Release notes written on GitHub's "New release" page, when the repo is on GitHub.
  async function githubNote(tag) {
    try {
      const remote = (await git(dir, ['remote', 'get-url', 'origin'])).trim();
      const m = remote.match(/github\.com[:/]([^/]+)\/(.+?)(\.git)?$/);
      if (!m) return null;
      const r = await fetch(`https://api.github.com/repos/${m[1]}/${m[2]}/releases/tags/${encodeURIComponent(tag)}`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'staged' }, signal: AbortSignal.timeout(5000) });
      if (!r.ok) return null;
      const j = await r.json();
      return { title: j.name && j.name !== tag ? j.name : '', body: String(j.body || '').replace(/\r/g, '').replace(/^#+\s*/gm, '').replace(/\*\*/g, '').trim(), url: j.html_url };
    } catch { return null; }
  }

  async function describe(tag) {
    const gh = await githubNote(tag);
    const note = gh ? [gh.title, gh.body].filter(Boolean).join('\n\n') : (await git(dir, ['cat-file', '-t', tag]).catch(() => '')).trim() === 'tag' ? (await git(dir, ['tag', '-l', '--format=%(contents)', tag]).catch(() => '')).trim() : '';
    const from = tagNow || 'HEAD';
    const log = (await git(dir, ['log', '--format=%s', '--no-merges', `${from}..${tag}`]).catch(() => '')).split('\n').filter(Boolean);
    const groups = TYPES.map(([key, , label]) => ({ key, label, items: [] }));
    const other = { key: 'other', label: 'Also', items: [] };
    for (const s of log) {
      if (/^(🔖|chore\(release\)|Released |Release )/u.test(s)) continue;
      const hit = TYPES.findIndex(([, re]) => re.test(s));
      const text = s.replace(/^(?:\p{Extended_Pictographic}|️|‍|\s)+/u, '').replace(/^\w+(\([^)]*\))?!?:\s*/, '').replace(/^./, (c) => c.toUpperCase());
      (hit >= 0 ? groups[hit] : other).items.push(text);
    }
    const date = (await git(dir, ['log', '-1', '--format=%cI', tag]).catch(() => '')).trim();
    return { tag, version: tag.replace(/^v/, ''), date, url: gh?.url || '', note: note.split('\n').filter((l) => !/^-----BEGIN PGP/.test(l)).join('\n').trim(), groups: [...groups, other].filter((g) => g.items.length), count: log.length };
  }

  // Can staged update itself safely? Only if its folder is a clean git clone it can fast-forward.
  async function blocker(tag) {
    if (!isRepo) return 'staged was not installed with git clone, so it cannot update itself. Download the new version from the repo page instead.';
    const dirty = (await git(dir, ['status', '--porcelain', '--untracked-files=no']).catch(() => '')).trim();
    if (dirty) return "staged's own files have changes that aren't committed. Commit or undo them, then update.";
    const ok = await git(dir, ['merge-base', '--is-ancestor', 'HEAD', tag]).then(() => true, () => false);
    if (!ok) return 'This copy of staged has commits that are not in the release, so it cannot move forward on its own. Run git pull in its folder.';
    return '';
  }

  async function apply() {
    const latest = state.latest;
    if (!latest) throw new Error('You already have the latest version.');
    const why = await blocker(latest.tag);
    if (why) throw new Error(why);
    state.busy = true;
    try {
      const before = (await git(dir, ['rev-parse', 'HEAD'])).trim();
      await git(dir, ['merge', '--ff-only', '--quiet', latest.tag]);
      const changed = (await git(dir, ['diff', '--name-only', before, 'HEAD']).catch(() => '')).split('\n').filter(Boolean);
      const from = state.current;
      await readTagNow();
      state.current = versionNow();
      state.latest = null;
      onUpdated?.({ from, to: state.current, changed });
      return { from, to: state.current, changed: changed.length };
    } finally {
      state.busy = false;
    }
  }

  // Look once shortly after starting, then every few hours.
  setTimeout(() => check(true), 4000).unref?.();
  setInterval(() => check(true), EVERY).unref?.();

  return async function routes(req, res, url, sendJson) {
    if (!url.pathname.startsWith('/api/update')) return false;
    try {
      if (url.pathname === '/api/update' && req.method === 'GET') {
        await check(url.searchParams.has('now'));
        const why = state.latest ? await blocker(state.latest.tag) : '';
        sendJson(res, 200, JSON.stringify({ current: state.current, latest: state.latest, blocked: why, offline: state.error === 'offline', canSelfUpdate: isRepo }));
        return true;
      }
      if (url.pathname === '/api/update' && req.method === 'POST') {
        if (req.headers['x-changes'] !== '1') { sendJson(res, 403, JSON.stringify({ error: 'Forbidden' })); return true; }
        sendJson(res, 200, JSON.stringify(await apply()));
        return true;
      }
    } catch (e) {
      sendJson(res, 400, JSON.stringify({ error: String(e && e.message || e) }));
      return true;
    }
    return false;
  };
}
