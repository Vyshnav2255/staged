// README: the project's README.md, rendered as a page with a contents rail.
import { esc } from './ui.js';

let host = null, html = null, toc = [];

export function mountReadme(el) {
  host = el;
  if (html) return draw();
  host.innerHTML = '<div class="loading mono">Opening the README…</div>';
  fetch('/README.md', { cache: 'no-store' }).then((r) => r.ok ? r.text() : Promise.reject(new Error('README.md not found')))
    .then((md) => { ({ html, toc } = render(md)); draw(); })
    .catch((e) => { host.innerHTML = `<div class="cm-banner is-error"><span>${esc(e.message)}</span></div>`; });
}

function draw() {
  host.innerHTML = `<div class="rd">
    <article class="rd-body">${html}</article>
    <nav class="rd-toc" aria-label="On this page"><div class="rd-toc-h mono">On this page</div>${toc.map((t) => `<a href="#" data-to="${t.id}">${esc(t.text)}</a>`).join('')}</nav>
  </div>`;
  host.querySelector('.rd-toc').addEventListener('click', (e) => {
    const a = e.target.closest('[data-to]'); if (!a) return;
    e.preventDefault();
    host.querySelector('#' + a.dataset.to)?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  });
}

const slug = (s) => 'rd-' + s.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function inline(s) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/localhost:\d+\/?)/g, '$1<a href="$2">$2</a>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[+i])}</code>`);
}

// Small Markdown renderer: headings, paragraphs, lists, tables, code fences, the logo image.
function render(md) {
  const lines = md.replace(/\r/g, '').split('\n');
  const out = [], toc = [];
  let i = 0, firstH1 = true;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    let m;
    if ((m = l.match(/^```(\w*)/))) {
      const buf = []; i++;
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
      i++;
      out.push(`<pre class="rd-code"><span class="rd-lang mono">${esc(m[1] || 'text')}</span><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    if ((m = l.match(/^(#{1,3})\s+(.*)/))) {
      const n = m[1].length, text = m[2];
      if (n === 1 && firstH1) { firstH1 = false; i++; continue; } // the page header already says the name
      const id = slug(text);
      if (n === 2) toc.push({ id, text });
      out.push(`<h${n} id="${id}">${inline(text)}</h${n}>`); i++; continue;
    }
    if (/^<img\s/.test(l)) { i++; continue; } // logo sits in the hero instead
    if (/^\|/.test(l)) {
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const [head, , ...body] = rows;
      out.push(`<div class="rd-table"><table><thead><tr>${cells(head).map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^[-*]\s/.test(l)) {
      const items = [];
      while (i < lines.length && /^[-*]\s/.test(lines[i])) items.push(lines[i++].replace(/^[-*]\s+/, ''));
      out.push(`<ul>${items.map((x) => `<li>${inline(x)}</li>`).join('')}</ul>`);
      continue;
    }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(#|```|\||[-*]\s|<img)/.test(lines[i])) buf.push(lines[i++]);
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }
  const hero = `<header class="rd-hero"><img src="brand/staged-icon.svg" width="56" height="56" alt=""><div><div class="rd-name">staged</div><div class="muted mono">README.md</div></div></header>`;
  return { html: hero + out.join('\n'), toc };
}
