// One progress bar for the whole app (user asked 2026-11-26): a pill track, striped parts that each end
// in a round cap tucked over the next one, so the bar never shows a gap.
import { esc } from './ui.js';

// parts: [{ value, color, title }]. Parts with no value are left out.
export function bar(parts, { label = '', cls = '' } = {}) {
  const ps = parts.filter((p) => p.value > 0);
  const aria = label || ps.map((p) => p.title).filter(Boolean).join(', ');
  return `<div class="bar${cls ? ' ' + cls : ''}" role="img" aria-label="${esc(aria)}">${ps.map((p, k) =>
    `<i style="flex:${p.value};background-color:${p.color};z-index:${ps.length - k}"${p.title ? ` title="${esc(p.title)}"` : ''}></i>`).join('')}</div>`;
}

// One fill on an empty track, for progress that moves (an update downloading). The caller or CSS sets its width.
export function fillBar({ cls = '', color = 'var(--logo-2)' } = {}) {
  return `<div class="bar is-fill${cls ? ' ' + cls : ''}" aria-hidden="true"><i style="background-color:${color}"></i></div>`;
}
