// Read-mostly insights: git tree, repo state (ahead/behind, branches, stashes), Today,
// releases (tags), push, changelog export.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

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

      if (p === '/api/x/push' && req.method === 'POST') {
        const up = await upstreamCounts(dir);
        const branch = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
        const args = up.upstream ? ['push', '--follow-tags'] : ['push', '--follow-tags', '-u', 'origin', branch];
        const out = await git(dir, args).catch((e) => { throw new Error((e.stderr || e.message || '').toString().trim().split('\n').slice(-3).join(' ')); });
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
      return fail('Not found', 404);
    } catch (e) {
      return fail(e);
    }
  };
}
