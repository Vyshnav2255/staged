// The gitmoji picker: suggested first, then your recent picks, then everything by kind.
// Search by meaning, by :code: or by type ("fix", "style"). Arrow keys move, Enter picks.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// [emoji, code, type, name, extra search words]
export const GITMOJI = [
  // New
  ['✨', 'sparkles', 'feat', 'New feature', 'add introduce'],
  ['🎉', 'tada', 'feat', 'Begin a project or big milestone', 'start launch initial'],
  ['🚸', 'children_crossing', 'feat', 'Better experience', 'usability ux'],
  ['♿️', 'wheelchair', 'feat', 'Accessibility', 'a11y'],
  ['🔍️', 'mag', 'feat', 'SEO', 'search meta'],
  ['🌐', 'globe_with_meridians', 'feat', 'Translations', 'i18n language'],
  ['🥚', 'egg', 'feat', 'Easter egg', 'hidden fun'],
  ['💸', 'money_with_wings', 'feat', 'Sponsorships or money', 'pay'],
  ['🧵', 'thread', 'feat', 'Multithreading or concurrency', ''],
  ['🦺', 'safety_vest', 'feat', 'Validation', 'check input'],
  ['📈', 'chart_with_upwards_trend', 'feat', 'Analytics or tracking', 'stats'],
  // Fix
  ['🐛', 'bug', 'fix', 'Bug fix', 'broken issue'],
  ['🚑️', 'ambulance', 'fix', 'Critical hotfix', 'urgent'],
  ['🩹', 'adhesive_bandage', 'fix', 'Small fix', 'minor patch'],
  ['🔒️', 'lock', 'fix', 'Security or privacy', 'vulnerability'],
  ['🥅', 'goal_net', 'fix', 'Catch errors', 'error handling'],
  ['✏️', 'pencil2', 'fix', 'Typos', 'spelling'],
  ['🚨', 'rotating_light', 'fix', 'Compiler or linter warnings', 'lint'],
  ['⏪️', 'rewind', 'revert', 'Revert changes', 'undo'],
  // Look and feel
  ['💄', 'lipstick', 'style', 'UI and styles', 'css design look'],
  ['💫', 'dizzy', 'style', 'Animations and transitions', 'motion'],
  ['🎨', 'art', 'style', 'Structure or format of code', 'format prettier'],
  ['📱', 'iphone', 'style', 'Responsive design', 'mobile'],
  ['🍱', 'bento', 'chore', 'Assets', 'images icons fonts'],
  ['🔊', 'loud_sound', 'feat', 'Sounds or logs added', 'audio'],
  ['🔇', 'mute', 'chore', 'Sounds or logs removed', 'audio'],
  // Content
  ['📝', 'memo', 'docs', 'Docs and content', 'readme write'],
  ['💬', 'speech_balloon', 'docs', 'Text and literals', 'copy wording'],
  ['📄', 'page_facing_up', 'docs', 'License', 'licence'],
  ['💡', 'bulb', 'docs', 'Comments in code', 'comment'],
  ['🗃️', 'card_file_box', 'chore', 'Database', 'data'],
  // Code
  ['♻️', 'recycle', 'refactor', 'Refactor', 'restructure'],
  ['⚡️', 'zap', 'perf', 'Performance', 'faster speed'],
  ['🔥', 'fire', 'refactor', 'Remove code or files', 'delete'],
  ['⚰️', 'coffin', 'refactor', 'Remove dead code', 'unused'],
  ['🚚', 'truck', 'refactor', 'Move or rename', 'rename move'],
  ['🏗️', 'building_construction', 'refactor', 'Architecture', 'structure'],
  ['🏷️', 'label', 'refactor', 'Types', 'typescript'],
  ['🧪', 'test_tube', 'test', 'Failing test', ''],
  ['✅', 'white_check_mark', 'test', 'Tests', 'spec'],
  ['🚧', 'construction', 'chore', 'Work in progress', 'wip'],
  ['🧑‍💻', 'technologist', 'chore', 'Developer experience', 'dx tooling'],
  // Setup
  ['🔧', 'wrench', 'chore', 'Config files', 'settings'],
  ['🔨', 'hammer', 'chore', 'Scripts', 'build script'],
  ['📦️', 'package', 'build', 'Packages or build output', 'compiled'],
  ['⬆️', 'arrow_up', 'build', 'Upgrade dependencies', 'update bump'],
  ['⬇️', 'arrow_down', 'build', 'Downgrade dependencies', ''],
  ['➕', 'heavy_plus_sign', 'build', 'Add a dependency', ''],
  ['➖', 'heavy_minus_sign', 'build', 'Remove a dependency', ''],
  ['📌', 'pushpin', 'build', 'Pin dependencies', 'lock version'],
  ['👷', 'construction_worker', 'ci', 'CI build system', 'actions pipeline'],
  ['💚', 'green_heart', 'ci', 'Fix CI build', ''],
  ['🚀', 'rocket', 'chore', 'Deploy', 'release ship'],
  ['🔖', 'bookmark', 'chore', 'Release or version tag', 'version'],
  ['🙈', 'see_no_evil', 'chore', '.gitignore', 'ignore'],
  ['🔀', 'twisted_rightwards_arrows', 'chore', 'Merge branches', 'merge'],
  ['🌱', 'seedling', 'chore', 'Seed files', ''],
  ['🚩', 'triangular_flag_on_post', 'feat', 'Feature flags', 'toggle'],
];
const KINDS = [
  ['New', ['✨', '🎉', '🚸', '♿️', '🔍️', '🌐', '🥚', '💸', '🧵', '🦺', '📈']],
  ['Fix', ['🐛', '🚑️', '🩹', '🔒️', '🥅', '✏️', '🚨', '⏪️']],
  ['Look and feel', ['💄', '💫', '🎨', '📱', '🍱', '🔊', '🔇']],
  ['Content', ['📝', '💬', '📄', '💡', '🗃️']],
  ['Code', ['♻️', '⚡️', '🔥', '⚰️', '🚚', '🏗️', '🏷️', '🧪', '✅', '🚧', '🧑‍💻']],
  ['Setup', ['🔧', '🔨', '📦️', '⬆️', '⬇️', '➕', '➖', '📌', '👷', '💚', '🚀', '🔖', '🙈', '🔀', '🌱', '🚩']],
];
const BY = new Map(GITMOJI.map((g) => [g[0], g]));
const SUGGEST = { feat: ['✨', '🚸', '🎉'], fix: ['🐛', '🩹', '🚑️'], style: ['💄', '💫', '📱'], perf: ['⚡️'], refactor: ['♻️', '🔥', '🚚'], docs: ['📝', '💬', '✏️'], chore: ['🔧', '🍱', '🙈'], build: ['📦️', '⬆️'], ci: ['👷'], test: ['✅'] };
const RECENT = 'staged-emoji-recent';
const recent = () => { try { return JSON.parse(localStorage.getItem(RECENT) || '[]').filter((e) => BY.has(e)); } catch { return []; } };
const remember = (e) => { try { localStorage.setItem(RECENT, JSON.stringify([e, ...recent().filter((x) => x !== e)].slice(0, 8))); } catch {} };

export function pickEmoji(anchor, { current, type, suggested = [], onPick }) {
  document.querySelector('.emoji-pop')?.remove();
  const pop = document.createElement('div');
  pop.className = 'emoji-pop';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Pick a gitmoji');
  const tile = (e) => { const g = BY.get(e); return g ? `<button class="emo ${e === current ? 'is-current' : ''}" data-e="${e}" data-t="${g[2]}" data-s="${esc((g[3] + ' ' + g[1] + ' ' + g[2] + ' ' + g[4]).toLowerCase())}" title="${esc(g[3])}" aria-label="${esc(g[3])}">${e}</button>` : ''; };
  const sug = [...new Set([...(current ? [current] : []), ...suggested.filter((e) => BY.has(e)), ...(SUGGEST[type] || []), '✨', '🐛', '💄'])].slice(0, 6);
  const rec = recent().filter((e) => !sug.includes(e)).slice(0, 6);
  pop.innerHTML = `
    <div class="emo-search"><input class="emoji-q" placeholder="Search by meaning or :code:" spellcheck="false" autocomplete="off" aria-label="Search gitmoji"></div>
    <div class="emo-body">
      <section class="emo-sec" data-fixed><h5 class="mono">Suggested</h5><div class="emo-grid">${sug.map(tile).join('')}</div></section>
      ${rec.length ? `<section class="emo-sec" data-fixed><h5 class="mono">Recent</h5><div class="emo-grid">${rec.map(tile).join('')}</div></section>` : ''}
      ${KINDS.map(([k, list]) => `<section class="emo-sec"><h5 class="mono">${k}</h5><div class="emo-grid">${list.map(tile).join('')}</div></section>`).join('')}
      <p class="emo-none muted" hidden>No gitmoji for that. Try “style” or “fix”.</p>
    </div>
    <footer class="emo-foot"><span class="emo-big"></span><span class="emo-info"><b></b><span class="mono muted"></span></span></footer>`;
  document.body.appendChild(pop);

  // Place under the button, or above it when there's no room.
  const r = anchor.getBoundingClientRect(), pw = 336, ph = pop.offsetHeight;
  const left = Math.max(12, Math.min(innerWidth - pw - 12, r.left - 6));
  const below = r.bottom + 8 + ph < innerHeight;
  pop.style.left = left + 'px';
  pop.style.top = (below ? r.bottom + 8 : Math.max(12, r.top - 8 - ph)) + scrollY + 'px';
  pop.style.transformOrigin = `${r.left + r.width / 2 - left}px ${below ? '0' : '100%'}`;
  pop.classList.add(below ? 'is-below' : 'is-above');

  const q = pop.querySelector('input');
  const foot = pop.querySelector('.emo-foot');
  const show = (b) => {
    const g = b && BY.get(b.dataset.e);
    foot.querySelector('.emo-big').textContent = g ? g[0] : '';
    foot.querySelector('b').textContent = g ? g[3] : 'Hover to see what each one means';
    foot.querySelector('.mono').textContent = g ? `:${g[1]}: · ${g[2]}` : '';
  };
  const tiles = () => [...pop.querySelectorAll('.emo:not([hidden])')].filter((b) => !b.closest('section').hidden);
  let at = -1;
  const focusAt = (i) => { const list = tiles(); if (!list.length) return; at = (i + list.length) % list.length; list.forEach((b, k) => b.classList.toggle('is-active', k === at)); list[at].scrollIntoView({ block: 'nearest' }); show(list[at]); };
  show(pop.querySelector('.emo.is-current') || pop.querySelector('.emo'));
  requestAnimationFrame(() => q.focus());

  q.addEventListener('input', () => {
    const v = q.value.toLowerCase().replace(/:/g, '').trim();
    let any = false;
    for (const sec of pop.querySelectorAll('.emo-sec')) {
      if (sec.hasAttribute('data-fixed')) { sec.hidden = !!v; continue; }
      let n = 0;
      for (const b of sec.querySelectorAll('.emo')) { const hit = !v || b.dataset.s.includes(v); b.hidden = !hit; n += hit; }
      sec.hidden = !n; any ||= n > 0;
    }
    pop.querySelector('.emo-none').hidden = any;
    at = -1; focusAt(0);
  });
  const close = () => { pop.classList.add('is-out'); setTimeout(() => pop.remove(), 120); removeEventListener('mousedown', outside, true); removeEventListener('keydown', esc_, true); anchor.focus?.(); };
  const outside = (e) => { if (!pop.contains(e.target) && e.target !== anchor) close(); };
  const esc_ = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  setTimeout(() => { addEventListener('mousedown', outside, true); addEventListener('keydown', esc_, true); });
  q.addEventListener('keydown', (e) => {
    const cols = 8;
    if (e.key === 'ArrowRight') { e.preventDefault(); focusAt(at + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); focusAt(at - 1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); focusAt(at < 0 ? 0 : at + cols); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusAt(at - cols); }
    else if (e.key === 'Enter') { e.preventDefault(); (tiles()[Math.max(0, at)])?.click(); }
  });
  pop.addEventListener('mouseover', (e) => { const b = e.target.closest('.emo'); if (b) show(b); });
  pop.addEventListener('click', (e) => {
    const b = e.target.closest('.emo');
    if (!b) return;
    remember(b.dataset.e);
    b.classList.add('is-picked');
    setTimeout(() => { close(); onPick(b.dataset.e, b.dataset.t); }, 90);
  });
}
