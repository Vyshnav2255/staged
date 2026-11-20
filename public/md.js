// Tiny Markdown view for notes and changelogs: headings, bullet lists, paragraphs, bold, code, links.
import { esc } from './ui.js';

const inline = (s) => esc(s)
  .replace(/`([^`]+)`/g, '<code class="mono">$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
  .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

export function mdView(md) {
  const out = []; let list = null, para = null;
  const flush = () => {
    if (list) { out.push(`<ul>${list.map((x) => `<li>${inline(x)}</li>`).join('')}</ul>`); list = null; }
    if (para) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = null; }
  };
  for (const raw of String(md || '').replace(/\r/g, '').split('\n')) {
    const l = raw.trim(); let m;
    if (!l) flush();
    else if ((m = l.match(/^(#{1,6})\s+(.*)$/))) { flush(); const n = Math.min(m[1].length, 3); out.push(`<h${n + 2}>${inline(m[2])}</h${n + 2}>`); }
    else if ((m = l.match(/^[-*+]\s+(.*)$/))) { if (para) flush(); (list ||= []).push(m[1]); }
    else if (list && /^\s{2,}\S/.test(raw)) list[list.length - 1] += ' ' + l;
    else { if (list) flush(); (para ||= []).push(l); }
  }
  flush();
  return `<div class="md-view">${out.join('')}</div>`;
}
