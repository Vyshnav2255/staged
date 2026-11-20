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

export function insightRoutes({ git, listRepos, repoDir }) {

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
