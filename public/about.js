// About: a postcard from the maker. The note on the left; the staged stamp, the coffee P.S. and a few links on the right.
// Nothing here phones home: the photo ships with staged and the links just open in the browser.
import { icon } from './icons.js';
import { esc } from './ui.js';
import { MARK } from './receipt.js';
import { checkNow } from './update.js';

const REPO = 'https://github.com/Vyshnav2255/staged';
const COFFEE = 'https://buymeacoffee.com/vyshnav';
let host = null, ctx = null;

const INK = '#17694c', PAPER = '#fdfbf4';

// Perforated stamp paper: a rect with round bites along every edge.
function perf(W, H) {
  const nx = Math.round(W / 9.6), ny = Math.round(H / 9.6);
  let h = '';
  for (let i = 0; i <= nx; i++) h += `<circle cx="${(i * W / nx).toFixed(2)}" cy="0" r="3"/><circle cx="${(i * W / nx).toFixed(2)}" cy="${H}" r="3"/>`;
  for (let i = 1; i < ny; i++) h += `<circle cx="0" cy="${(i * H / ny).toFixed(2)}" r="3"/><circle cx="${W}" cy="${(i * H / ny).toFixed(2)}" r="3"/>`;
  return `<mask id="abPerf"><rect width="${W}" height="${H}" fill="#fff"/><g fill="#000">${h}</g></mask><rect width="${W}" height="${H}" fill="${PAPER}" mask="url(#abPerf)"/>`;
}

// The staged mark at any size (same geometry as the logo, 24-unit grid).
const logo = (x, y, sc) => `<g transform="translate(${x} ${y}) scale(${sc})" fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.75"><path d="M18 18H6C5.05719 18 4.58579 18 4.29289 17.7071C4 17.4142 4 16.9428 4 16C4 15.0572 4 14.5858 4.29289 14.2929C4.58579 14 5.05719 14 6 14H18C18.9428 14 19.4142 14 19.7071 14.2929C20 14.5858 20 15.0572 20 16C20 16.9428 20 17.4142 19.7071 17.7071C19.4142 18 18.9428 18 18 18Z" fill="#1f9a6a" fill-opacity=".3" stroke="#1f9a6a"/><path d="M4 10H20" stroke="#4cbb6c"/><path d="M4 6H20" stroke="#c4e35a"/></g>`;

// The engraved staged stamp: sunburst, the mark in a roundel, microtext between the frame lines.
function stamp() {
  const W = 120, H = 148;
  const rays = Array.from({ length: 72 }, (_, i) => { const a = i * Math.PI / 36, c = Math.cos(a), s = Math.sin(a); return `<path d="M${(60 + c * 30).toFixed(2)} ${(66 + s * 30).toFixed(2)}L${(60 + c * 80).toFixed(2)} ${(66 + s * 80).toFixed(2)}"/>`; }).join('');
  const rings = [31.5, 33.5, 35.5].map((r, i) => `<circle cx="60" cy="66" r="${r}" stroke="${INK}" stroke-width="${[.9, .35, .35][i]}" fill="none"/>`).join('');
  const micro = 'STAGED · NO ACCOUNT · NO TRACKING · NO AI · STAYS ON YOUR COMPUTER · '.repeat(4).slice(0, 207);
  return `<svg class="ab-stamp" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">
    <defs>
      <filter id="abInkTex" x="-5%" y="-5%" width="110%" height="110%"><feTurbulence type="fractalNoise" baseFrequency="1.3" numOctaves="2" seed="7" result="n"/><feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -.75 1.28" result="a"/><feComposite in="SourceGraphic" in2="a" operator="in"/></filter>
      <filter id="abInkWorn" x="-5%" y="-5%" width="110%" height="110%"><feTurbulence type="fractalNoise" baseFrequency=".55" numOctaves="3" seed="11" result="n"/><feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -2.1 1.85" result="a"/><feComposite in="SourceGraphic" in2="a" operator="in"/></filter>
      <clipPath id="abField"><rect x="15.5" y="28" width="89" height="77"/></clipPath>
    </defs>
    ${perf(W, H)}
    <g filter="url(#abInkTex)">
      <rect x="9" y="9" width="102" height="130" fill="#eef3dc"/>
      <g clip-path="url(#abField)" stroke="${INK}" stroke-width=".45" opacity=".55">${rays}</g>
      <circle cx="60" cy="66" r="29.5" fill="${PAPER}"/>${rings}
      ${logo(60 - 21.6, 66 - 21.6, 1.8)}
      <rect x="9" y="9" width="102" height="130" fill="none" stroke="${INK}" stroke-width="1"/>
      <rect x="15.5" y="15.5" width="89" height="117" fill="none" stroke="${INK}" stroke-width=".5"/>
      <path id="abMicro" d="M14.4 14.4H105.6V133.6H14.4Z" fill="none"/>
      <text font-size="2.5" letter-spacing=".12" fill="${INK}"><textPath href="#abMicro" textLength="417">${micro}</textPath></text>
      <text x="60" y="24.4" text-anchor="middle" font-size="4.6" font-weight="500" letter-spacing="1.5" fill="${INK}">LOCALHOST POST</text>
      <path d="M15.5 28H104.5M15.5 105H104.5" stroke="${INK}" stroke-width=".5"/>
      <rect x="15.5" y="105" width="89" height="27.5" fill="${INK}"/>
      <text class="w" x="60" y="124" text-anchor="middle" font-size="17" fill="${PAPER}">staged</text>
    </g>
  </svg>`;
}

// Round postmark; its wavy cancel lines run on across the stamp.
const postmark = () => `<svg class="ab-pmark" width="178" height="92" viewBox="0 0 178 92" fill="none" aria-hidden="true"><g filter="url(#abInkWorn)">
  <circle cx="46" cy="46" r="44" stroke="currentColor" stroke-width="1.6"/><circle cx="46" cy="46" r="28.5" stroke="currentColor" stroke-width="1"/>
  <defs><path id="abPmA" d="M46 46m-34.6 0a34.6 34.6 0 1 1 69.2 0"/><path id="abPmB" d="M46 46m-39.4 0a39.4 39.4 0 0 0 78.8 0"/></defs>
  <text><textPath href="#abPmA" startOffset="50%" text-anchor="middle">STAGED</textPath></text>
  <text><textPath href="#abPmB" startOffset="50%" text-anchor="middle">LOCALHOST</textPath></text>
  <path d="M15.5 46h3M73.5 46h3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
  <text class="c1" x="46" y="45.5" text-anchor="middle">FREE</text><text class="c2" x="46" y="56.5" text-anchor="middle">ALWAYS</text>
  ${[25, 35.5, 46, 56.5, 67].map((y) => `<path d="M95 ${y}c5-4.6 10 4.6 15 0s10 4.6 15 0 10 4.6 15 0 10 4.6 15 0 10 4.6 15 0" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`).join('')}
</g></svg>`;

export function mountAbout(el, context) {
  host = el; ctx = context || {};
  if (!host.dataset.bound) { host.addEventListener('click', onClick); host.dataset.bound = '1'; }
  draw();
}

function draw() {
  const v = ctx.version || '';
  const mark = (px) => MARK.replace('width="22" height="22"', `width="${px}" height="${px}"`);
  const notes = v ? `${REPO}/releases/tag/v${esc(v)}` : `${REPO}/releases`;
  host.innerHTML = `<div class="ab">
    <article class="ab-note">
      <div class="ab-body">
        <div class="ab-kicker">${mark(20)}<span>A note from the maker</span></div>
        <p class="ab-hi">Hi, I'm Vyshnav. I make staged.</p>
        <p>It sorts every change across your git repos into commits, and it does all of it <mark>on your computer</mark>. There is <mark>no account</mark> to make and <mark>no tracking</mark> of any kind. It <mark>needs no AI</mark> either. The grouping and the messages come from your own history.</p>
        <p>It is free, and it stays free.</p>
        <div class="ab-sign">
          <span class="ab-ava"><img src="brand/maker.webp" alt="" onerror="this.remove()"><b>V</b></span>
          <span class="ab-who"><b>Vyshnav Gangadharan</b><span>Made with ♥ in the open</span></span>
        </div>
      </div>
      <div class="ab-side">
        <div class="ab-top">${postmark()}${stamp()}</div>
        <div class="ab-ps">
          <h3><span>P.S.</span>Buy me a coffee</h3>
          <p>If staged saves you time, a coffee keeps it going.</p>
          <a class="ab-pay" href="${COFFEE}" target="_blank" rel="noopener">${icon('Coffee02', 15)}<span>Buy me a coffee</span></a>
        </div>
        <div class="ab-addr">
          <div class="ab-k">Elsewhere</div>
          <a href="${REPO}" target="_blank" rel="noopener">${icon('Github', 15)}GitHub<span class="go">${icon('LinkSquare02', 13)}</span></a>
          <a href="${notes}" target="_blank" rel="noopener">${icon('Note01', 15)}Release notes<span class="go">${icon('LinkSquare02', 13)}</span></a>
          <a href="${REPO}/blob/main/LICENSE" target="_blank" rel="noopener">${icon('License', 15)}License<small>Source-available</small></a>
          <button type="button" data-check>${icon('Refresh01', 14)}Check for updates<small>${esc(v)}</small></button>
        </div>
      </div>
    </article>
  </div>`;
}

function onClick(e) {
  if (e.target.closest('[data-check]')) checkNow();
}
