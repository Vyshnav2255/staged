// Project settings: choices that belong to one repo, not to staged as a whole. For now that is how
// its commit messages are written. Opens from the repo header, the Commit menu or ⌘K.
import { esc, modal } from './ui.js';

const KEY = 'changes.commit';
const read = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } };
const write = (v) => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch {} };
const STYLES = [
  ['auto', 'Auto', 'Writes the way this project’s history already does'],
  ['gitmoji', 'Gitmoji', '✨ Added book notes for …'],
  ['conventional', 'Conventional', 'feat(books): add notes for …'],
  ['both', 'Both', '✨ feat(books): add notes for …'],
];
const NAMES = { gitmoji: 'Gitmoji', conventional: 'Conventional', plain: 'Plain', both: 'Both' };

function projectStyle(repo) { return read().formats?.[repo] || 'auto'; }

// learned: the style staged read from this repo's history, when it knows it (shown next to Auto).
// Opens as a side panel, like the cart.
export function openProjectSettings(repo, { learned, onChange } = {}) {
  const body = () => {
    const cur = projectStyle(repo);
    return `<p class="ps-h">Commit messages</p>
      <div class="ps-opts" role="radiogroup" aria-label="Commit message style for ${esc(repo)}">
        ${STYLES.map(([k, l, d]) => `<button class="ps-opt" role="radio" aria-checked="${cur === k}" data-style="${k}">
          <span class="ps-dot" aria-hidden="true"></span>
          <span class="ps-main"><b>${l}</b><span class="ps-eg ${k === 'auto' ? '' : 'mono'}">${k === 'auto' ? (NAMES[learned] ? `Like its history · ${NAMES[learned]}` : 'Like its history') : esc(d)}</span></span>
        </button>`).join('')}
      </div>`;
  };
  const m = modal({ title: `${repo} settings`, body: `<div data-ps>${body()}</div>`, side: true });
  m.el.classList.add('is-ps');
  m.el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-style]'); if (!b) return;
    const v = read(); v.formats = { ...(v.formats || {}) };
    if (b.dataset.style === 'auto') delete v.formats[repo]; else v.formats[repo] = b.dataset.style;
    write(v);
    m.el.querySelector('[data-ps]').innerHTML = body();
    m.el.querySelector(`[data-style="${b.dataset.style}"]`)?.focus();
    onChange?.(b.dataset.style);
  });
  return m;
}
