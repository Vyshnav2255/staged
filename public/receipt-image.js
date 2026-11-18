// Turns a receipt or statement spec (see receipt.js) into a share-ready picture, 1080 wide, drawn
// straight onto a canvas so it looks the same everywhere: paper torn at both ends, lying on a soft
// backdrop, with the staged lockup, the green stamp and the QR code.
import { MARK, qrMatrix } from './receipt.js';

const W = 1080, PAPER = 640, PAD = 52, TOOTH = 14;
const INK = '#1b1b19', MUTED = '#7a786f', RULE = '#cfccc2', GREEN = '#2f8f4e';
const mono = (s) => `500 ${s}px "Geist Mono", ui-monospace, monospace`;
const sans = (w, s) => `${w} ${s}px Akt, ui-sans-serif, system-ui, sans-serif`;

async function fonts() {
  try { await Promise.all(['600 36px Akt', '400 26px Akt', '500 20px "Geist Mono"'].map((f) => document.fonts.load(f))); } catch {}
}
function markImage() {
  const svg = MARK.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ').replace('width="22" height="22"', 'width="240" height="240"');
  return new Promise((ok) => { const img = new Image(); img.onload = () => ok(img); img.onerror = () => ok(null); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); });
}
function fit(ctx, text, max) {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > max) t = t.slice(0, -1);
  return t.trimEnd() + '…';
}

// A tile of soft speckle, the grain of the paper.
function grain() {
  const t = document.createElement('canvas'); t.width = t.height = 160;
  const g = t.getContext('2d'), img = g.createImageData(160, 160);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random();
    img.data[i] = 105; img.data[i + 1] = 96; img.data[i + 2] = 78; img.data[i + 3] = v > 0.5 ? (v - 0.5) * 34 : 0;
  }
  g.putImageData(img, 0, 0);
  return t;
}

export async function specImage(s) {
  await fonts();
  const mark = await markImage();
  const X0 = (W - PAPER) / 2, X1 = X0 + PAPER;
  const rows = [];
  const add = (h, draw) => rows.push({ h, draw });
  const pair = (l, r, { font = mono(19), color = MUTED, h = 34 } = {}) => add(h, (c, y) => {
    c.font = font; c.fillStyle = color;
    const rw = c.measureText(r).width;
    c.textAlign = 'left'; c.fillText(fit(c, l, PAPER - PAD * 2 - rw - 24), X0 + PAD, y + h * 0.7);
    c.textAlign = 'right'; c.fillText(r, X1 - PAD, y + h * 0.7);
  });
  const rule = () => add(34, (c, y) => { c.strokeStyle = RULE; c.lineWidth = 2; c.setLineDash([7, 6]); c.beginPath(); c.moveTo(X0 + PAD, y + 17); c.lineTo(X1 - PAD, y + 17); c.stroke(); c.setLineDash([]); });
  const center = (h, font, color, text, spacing = 0) => add(h, (c, y) => { c.font = font; c.fillStyle = color; c.textAlign = 'center'; c.letterSpacing = spacing + 'px'; c.fillText(text, W / 2, y + h * 0.64); c.letterSpacing = '0px'; });

  add(10, () => {});
  // lockup at the sidebar's proportions, scaled from 18px to 44px: the mark dips just below the baseline
  add(64, (c, y) => {
    const k = 44 / 18, size = 22 * k, base = y + 46;
    c.font = sans(600, 44); c.letterSpacing = '-1.5px';
    const tw = c.measureText('staged').width, x = W / 2 - (size - 1.3 * k + tw) / 2;
    if (mark) c.drawImage(mark, x - 2.9 * k, base + 5.65 * k - size, size, size);
    c.fillStyle = INK; c.textAlign = 'left'; c.fillText('staged', x - 2.9 * k + size + 1.6 * k, base); c.letterSpacing = '0px';
  });
  center(44, mono(17), MUTED, s.label.toUpperCase(), 4);
  add(12, () => {});
  for (const [l, r] of s.meta) pair(l, r);
  rule();
  if (!s.items.length) center(48, sans(400, 22), MUTED, s.empty || '');
  for (const it of s.items) {
    pair(it.l, it.r, { font: sans(400, 24), color: INK, h: 38 });
    pair(it.sl, it.sr, { h: 34 });
    add(10, () => {});
  }
  rule();
  for (const [l, r, b] of s.totals) pair(l, r, b ? { font: sans(600, 27), color: INK, h: 44 } : { font: sans(400, 23), color: INK, h: 36 });
  rule();
  if (s.ok) center(44, mono(18), GREEN, '✓ ' + s.ok.toUpperCase(), 4);
  center(40, sans(400, 22), MUTED, s.note);
  let stampAt = 0;
  if (s.qr) {
    const { n, dark } = qrMatrix(s.qr);
    add(230, (c, y) => {
      stampAt = y;
      const px = 180 / n, x0 = W / 2 - 90, y0 = y + 18;
      c.fillStyle = INK;
      for (let r = 0; r < n; r++) for (let q = 0; q < n; q++) if (dark(r, q)) c.fillRect(x0 + q * px, y0 + r * px, px + 0.4, px + 0.4);
      if (s.qrLabel) { c.font = mono(16); c.fillStyle = MUTED; c.textAlign = 'center'; c.fillText(s.qrLabel, W / 2, y + 222); }
    });
  } else {
    add(90, (c, y) => {
      stampAt = y;
      const bars = [...String(s.seed).replace(/\D/g, '').padEnd(20, '7').slice(0, 28)].map((ch) => 2 + (+ch % 4) * 1.5);
      const total = bars.reduce((t, b) => t + b + 3, 0);
      let x = W / 2 - total / 2;
      c.fillStyle = INK;
      for (const b of bars) { c.fillRect(x, y + 22, b, 52); x += b + 3; }
    });
  }

  const paperH = rows.reduce((t, r) => t + r.h, 0) + 40 + 30;
  const H = Math.max(1350, paperH + 340);
  const canvas = document.createElement('canvas');
  const scale = 2;
  canvas.width = W * scale; canvas.height = H * scale;
  const c = canvas.getContext('2d');
  c.scale(scale, scale);

  const bg = c.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#efece4'); bg.addColorStop(1, '#dedad0');
  c.fillStyle = bg; c.fillRect(0, 0, W, H);
  const glow = c.createRadialGradient(W / 2, H * 0.18, 40, W / 2, H * 0.3, W * 0.8);
  glow.addColorStop(0, 'rgba(255,255,255,.75)'); glow.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = glow; c.fillRect(0, 0, W, H);

  const top = Math.round((H - paperH) / 2) - 30;
  c.save();
  c.translate(W / 2, top + paperH / 2); c.rotate(-0.012); c.translate(-W / 2, -(top + paperH / 2));
  // torn at both ends, like a slip cut off a roll
  const shape = () => {
    c.beginPath();
    c.moveTo(X0, top + TOOTH);
    for (let x = X0, up = true; x < X1; x += TOOTH, up = !up) c.lineTo(Math.min(X1, x + TOOTH), top + (up ? 0 : TOOTH));
    c.lineTo(X1, top + paperH - TOOTH);
    for (let x = X1, up = false; x > X0; x -= TOOTH, up = !up) c.lineTo(Math.max(X0, x - TOOTH), top + paperH - (up ? TOOTH : 0));
    c.closePath();
  };
  c.shadowColor = 'rgba(40,36,25,.22)'; c.shadowBlur = 48; c.shadowOffsetY = 22;
  shape(); c.fillStyle = '#fbfaf6'; c.fill();
  c.shadowColor = 'transparent';
  // paper texture: fine grain, faint fibres, a little shading at the edges
  c.save(); shape(); c.clip();
  c.fillStyle = c.createPattern(grain(), 'repeat'); c.fillRect(X0, top, PAPER, paperH);
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  c.lineWidth = 0.8; c.lineCap = 'round';
  for (let i = 0; i < 260; i++) {
    const x = X0 + rnd() * PAPER, y0 = top + rnd() * paperH, len = 6 + rnd() * 18, ang = (rnd() - 0.5) * 0.9;
    c.strokeStyle = `rgba(110,100,80,${0.04 + rnd() * 0.05})`;
    c.beginPath(); c.moveTo(x, y0); c.quadraticCurveTo(x + len * 0.5, y0 + (rnd() - 0.5) * 4, x + Math.cos(ang) * len, y0 + Math.sin(ang) * len); c.stroke();
  }
  const edge = c.createLinearGradient(X0, 0, X1, 0);
  edge.addColorStop(0, 'rgba(120,110,90,.07)'); edge.addColorStop(0.1, 'rgba(120,110,90,0)'); edge.addColorStop(0.9, 'rgba(120,110,90,0)'); edge.addColorStop(1, 'rgba(120,110,90,.07)');
  c.fillStyle = edge; c.fillRect(X0, top, PAPER, paperH);
  c.restore();
  let y = top + 40;
  for (const r of rows) { r.draw(c, y); y += r.h; }
  // the green rubber stamp, a little crooked, beside the code at the bottom
  c.save();
  c.translate(X1 - 128, stampAt + (s.qr ? 70 : 40)); c.rotate(-0.19);
  c.globalAlpha = 0.85; c.strokeStyle = GREEN; c.fillStyle = GREEN; c.lineWidth = 4;
  c.beginPath(); c.roundRect(-92, -40, 184, 80, 14); c.stroke();
  c.font = mono(30); c.textAlign = 'center'; c.letterSpacing = '6px'; c.fillText(s.stamp[0].toUpperCase(), 3, 4);
  c.font = mono(15); c.letterSpacing = '4px'; c.fillText(s.stamp[1].toUpperCase(), 2, 28);
  c.restore();
  c.restore();

  c.font = mono(19); c.fillStyle = '#8d897e'; c.textAlign = 'center'; c.letterSpacing = '2px';
  c.fillText(s.kind === 'statement' ? 'shipped with staged' : 'pushed with staged', W / 2, H - 70); c.letterSpacing = '0px';

  return new Promise((ok) => canvas.toBlob(ok, 'image/png'));
}

// Saves the picture to Downloads and puts it on the clipboard, ready to paste into a post.
export async function shareSpec(s) {
  const blob = await specImage(s);
  if (!blob) throw new Error("Couldn't draw the picture");
  const a = document.createElement('a');
  a.download = `${s.file.replace(/[^\w.-]+/g, '-')}.png`;
  a.href = URL.createObjectURL(blob);
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  // the clipboard can ask for permission and never answer, so don't wait on it for long
  let copied = false;
  try { await Promise.race([navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]).then(() => { copied = true; }), new Promise((ok) => setTimeout(ok, 1500))]); } catch {}
  return { copied };
}
