// The commit engine's promises, checked on real piles of changes (staged's own history).
// Run with: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { suggestGroups } from '../commit.mjs';

const cases = JSON.parse(fs.readFileSync(new URL('./fixtures/staged-history.json', import.meta.url)));
const unitsOf = (files) => files.flatMap((f) => (f.hunks?.length ? f.hunks.map((h) => f.path + '#' + h.id) : [f.path]));
const ownerOf = (groups, files) => {
  const own = new Map();
  for (const g of groups) for (const p of g.files) {
    const f = files.find((x) => x.path === p);
    const ids = f.hunks?.length ? (g.hunks?.[p] || f.hunks.map((h) => h.id)) : [null];
    for (const id of ids) { const k = id ? p + '#' + id : p; own.set(k, [...(own.get(k) || []), g.id]); }
  }
  return own;
};
// Words a person would never write in a subject: code, jargon from staged's own internals.
const JUNK = /visible wording|[a-z][A-Z]|--[a-z]|\b(\w+) \1\b|\bacross \d+ files across\b|\bedge cases\b|: \w+: |\bthat turns\b(?!.*\binto\b)|\b(pkg|cfg|cm)\b|\b[Ee]xtended pictographic\b/;

for (const [i, c] of cases.entries()) {
  test(`pile ${i + 1}: ${c.commits.length} real commits, ${c.files.length} files`, () => {
    const groups = suggestGroups(c.files, { history: c.history, tense: 'past' });
    assert.ok(groups.length >= 1);
    const own = ownerOf(groups, c.files);
    for (const u of unitsOf(c.files)) assert.equal(own.get(u)?.length, 1, `${u} should be in exactly one commit`);
    for (const g of groups) {
      assert.ok(g.files.length, 'no empty commits');
      for (const s of [g.gitmoji, g.conventional]) {
        assert.ok(s && s.trim().length >= 4, `subject is written: ${s}`);
        assert.ok(s.length <= 80, `subject fits a line: ${s}`);
      }
      assert.doesNotMatch(g.gitmoji.replace(/\b(GitHub|GitLab|JavaScript|TypeScript|YouTube|LinkedIn|WordPress|iPhone|macOS)\b/g, 'Brand'), JUNK, `subject reads like a person wrote it: ${g.gitmoji}`);
      assert.match(g.type, /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)$/, `known type: ${g.type}`);
      assert.doesNotMatch(g.conventional, /^(added|updated|fixed|removed|changed|reworked|refined|simplified) /i, `conventional is imperative: ${g.conventional}`);
    }
  });
}

test('same input, same commits', () => {
  const c = cases.at(-1);
  const a = suggestGroups(c.files, { history: c.history }).map((g) => [g.files, g.gitmoji]);
  const b = suggestGroups(c.files, { history: c.history }).map((g) => [g.files, g.gitmoji]);
  assert.deepEqual(a, b);
});

test('a big pile is sorted quickly', () => {
  const c = cases.reduce((x, y) => (y.files.length > x.files.length ? y : x));
  const t = performance.now();
  suggestGroups(c.files, { history: c.history });
  assert.ok(performance.now() - t < 3000, 'under 3 seconds');
});
