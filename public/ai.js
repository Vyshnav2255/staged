// Commit Compass uses deterministic local rules for grouping and message drafts.
const writeHeaders = { 'content-type': 'application/json', 'x-changes': '1' };

export const ENGINES = {
  rules: { label: 'Commit Compass rules', short: 'Commit Compass', note: 'Local, explainable rules group changes and write a grounded first draft.' },
};

export function status() { return Promise.resolve({ rules: 'ready' }); }
export function preferred() { return 'rules'; }
export function preferredRaw() { return 'rules'; }
export function setPreferred() {}
export async function pick() { return 'rules'; }

export async function write({ repo, files }) {
  const response = await fetch(`/api/changes/message-local?repo=${encodeURIComponent(repo)}`, {
    method: 'POST', headers: writeHeaders, body: JSON.stringify({ files: files.map((file) => file.path) }),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok || value.error) throw new Error(value.error || response.statusText);
  return { ...value, source: 'rules' };
}

