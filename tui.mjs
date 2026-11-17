// Small terminal helpers: colours, the staged logo, cards, a spinner and an arrow-key picker.
// No dependencies. Colour and motion step aside for NO_COLOR, dumb terminals and pipes.
import readline from 'node:readline';

const tty = !!process.stdout.isTTY;
const on = tty && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
export const motion = on && !process.env.CI && !process.env.STAGED_NO_MOTION;
const wrap = (open, close = 39) => (s) => (on ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
const rgb = (r, g, b) => wrap(`38;2;${r};${g};${b}`);
const bg = (r, g, b) => wrap(`48;2;${r};${g};${b}`, 49);

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  muted: rgb(137, 135, 129),
  faint: rgb(88, 87, 82),
  ink: rgb(240, 239, 236),
  orange: rgb(235, 104, 52),
  green: rgb(27, 175, 122),
  blue: rgb(57, 135, 229),
  amber: rgb(237, 161, 0),
  red: rgb(230, 103, 103),
  lime: rgb(196, 227, 90),
  leaf: rgb(76, 187, 108),
  forest: rgb(31, 154, 106),
  sel: bg(34, 34, 32),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Visible width: ignores colour codes and link wrappers.
export const width = (s) => String(s).replace(/\x1b\]8;;[^\x07]*\x07/g, '').replace(/\x1b\[[\d;]*m/g, '').length;
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - width(s)));

// The logo, drawn as pixels with half blocks: each character holds two pixels stacked, so the
// mark and a small bitmap wordmark come out crisp, about four lines tall. The mark is the app icon:
// a lime line, a leaf line and a forest box with a tinted fill. The wordmark fades lime to forest.
const LIME = [196, 227, 90], LEAF = [76, 187, 108], FOREST = [31, 154, 106], TINT = [17, 44, 34], GLINT = [250, 250, 245];
const MARK = [
  'LLLLLLLLLLLL',
  '............',
  'EEEEEEEEEEEE',
  '............',
  '.FFFFFFFFFF.',
  'FttttttttttF',
  'FttttttttttF',
  '.FFFFFFFFFF.',
];
// Lowercase letters, 4 pixels wide. Rows 0–2 are the ascender, 3–7 the x-height, 8–9 the descender.
const GLYPHS = {
  s: ['....', '....', '....', '.###', '#...', '.##.', '...#', '###.', '....', '....'],
  t: ['....', '.#..', '.#..', '###.', '.#..', '.#..', '.#..', '..##', '....', '....'],
  a: ['....', '....', '....', '.##.', '...#', '.###', '#..#', '.###', '....', '....'],
  g: ['....', '....', '....', '.###', '#..#', '#..#', '#..#', '.###', '...#', '.##.'],
  e: ['....', '....', '....', '.##.', '#..#', '####', '#...', '.###', '....', '....'],
  d: ['...#', '...#', '...#', '.###', '#..#', '#..#', '#..#', '.###', '....', '....'],
};
const H = 10, GAP = 4, MW = MARK[0].length;
const WORD = [...'staged'].map((ch) => GLYPHS[ch]);
const WW = WORD.length * 5 - 1;
const mix = (a, b, k) => a.map((v, j) => Math.round(v + (b[j] - v) * k));
const ramp = (t) => (t < 0.5 ? mix(LIME, LEAF, t * 2) : mix(LEAF, FOREST, (t - 0.5) * 2));

// Builds the pixel grid. `mark` (0–1) draws the lines and box out from the left, `word` (0–1)
// wipes the name in, and `glint` is the column of the shine running across the name.
function pixels(mark = 1, word = 1, glint = -99) {
  const grid = Array.from({ length: H }, () => Array(MW + GAP + WW).fill(null));
  const mcols = Math.round(MW * mark);
  MARK.forEach((r, y) => [...r].forEach((p, x) => {
    if (x >= mcols) return;
    grid[y][x] = p === 'L' ? LIME : p === 'E' ? LEAF : p === 'F' ? FOREST : p === 't' ? TINT : null;
  }));
  const wcols = Math.round(WW * word);
  WORD.forEach((g, i) => g.forEach((r, y) => [...r].forEach((p, x) => {
    const col = i * 5 + x;
    if (p !== '#' || col >= wcols) return;
    const near = Math.abs(col - glint);
    grid[y][MW + GAP + col] = near < 1 ? GLINT : near < 2.5 ? mix(ramp(col / WW), GLINT, 0.45) : ramp(col / WW);
  })));
  return grid;
}
// Two pixel rows make one line of text: the top pixel is the ▀ glyph, the bottom one its background.
function render(grid) {
  const fg = (c) => `\x1b[38;2;${c.join(';')}m`, bgc = (c) => `\x1b[48;2;${c.join(';')}m`;
  const out = [];
  for (let y = 0; y < H; y += 2) {
    let line = '';
    for (let x = 0; x < grid[0].length; x++) {
      const t = grid[y][x], b = grid[y + 1][x];
      line += t && b ? `${fg(t)}${bgc(b)}▀\x1b[49m` : t ? `${fg(t)}▀` : b ? `${fg(b)}▄` : ' ';
    }
    out.push('   ' + line.replace(/ +$/, '') + '\x1b[39m');
  }
  return out;
}
function logoLines(subtitle, mark, word, glint, sub = true) {
  const pad = ' '.repeat(3 + MW + GAP);
  return ['', ...render(pixels(mark, word, glint)), sub ? pad + c.muted(subtitle) : '', ''];
}
export function logo(subtitle = 'every change across your git repos') {
  if (!on) return `\n   staged\n   ${subtitle}\n`;
  return logoLines(subtitle, 1, 1).join('\n');
}

// The logo draws itself in: the lines slide out, the name wipes on, then a shine runs across it.
export async function animateLogo(subtitle = 'every change across your git repos') {
  // Start on a clean screen, so staged is the only thing in view. Scrollback is kept, so nothing
  // you had before is lost. Pipes and CI are left alone.
  if (tty && !process.env.CI) process.stdout.write('\x1b[2J\x1b[H');
  if (!motion) return console.log(logo(subtitle));
  const out = process.stdout;
  out.write('\x1b[?25l');
  let drawn = 0;
  const frame = (lines) => { if (drawn) out.write(`\x1b[${drawn}A`); out.write(lines.map((l) => '\r\x1b[2K' + l).join('\n') + '\n'); drawn = lines.length; };
  const ease = (k) => 1 - Math.pow(1 - k, 3);
  for (let i = 1; i <= 8; i++) { frame(logoLines(subtitle, ease(i / 8), 0, -99, false)); await sleep(22); }
  for (let i = 1; i <= 10; i++) { frame(logoLines(subtitle, 1, ease(i / 10), -99, false)); await sleep(22); }
  for (let g = -3; g <= WW + 3; g += 2) { frame(logoLines(subtitle, 1, 1, g, g > WW / 2)); await sleep(18); }
  frame(logoLines(subtitle, 1, 1));
  out.write('\x1b[?25h');
}

// A rounded card. Lines can hold colour; the card sizes itself to the widest one.
export function card(lines, { tone = c.faint, min = 48 } = {}) {
  const w = Math.max(min, ...lines.map(width));
  return [tone(`╭${'─'.repeat(w + 4)}╮`), ...lines.map((l) => `${tone('│')}  ${pad(l, w)}  ${tone('│')}`), tone(`╰${'─'.repeat(w + 4)}╯`)].map((l) => '  ' + l).join('\n');
}
// A muted label and its value, for rows inside a card.
export const row = (label, value, w = 10) => `${c.muted(pad(label, w))}${value}`;

// A spinner on one line. Returns stop(finalLine).
export function spinner(text) {
  if (!motion) return (final) => final && console.log(final);
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  process.stdout.write('\x1b[?25l');
  const draw = () => process.stdout.write(`\r\x1b[2K  ${c.leaf(frames[i++ % frames.length])} ${c.muted(text)}`);
  draw();
  const t = setInterval(draw, 70);
  return (final) => { clearInterval(t); process.stdout.write('\r\x1b[2K\x1b[?25h'); if (final) console.log(final); };
}

// One line in the activity log, with the time on the left.
export function log(icon, text) {
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  console.log(`  ${c.faint(time)}  ${icon}  ${text}`);
}

export const link = (url) => (on ? `\x1b]8;;${url}\x07${c.blue(url)}\x1b]8;;\x07` : url);
// A key, drawn like a keycap.
export const key = (k) => (on ? c.sel(c.ink(` ${k} `)) : `[${k}]`);

// Arrow-key menu. Resolves with the chosen option's value, or null on q / Esc / Ctrl+C.
export function pick(question, options) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) return resolve(options[0].value);
    let i = 0, drawn = 0;
    // An option can carry a small tag, such as "recommended", shown in green after its label.
    const full = (o) => o.label + (o.tag ? ` ${o.tag}` : '');
    const w = Math.max(...options.map((o) => full(o).length));
    const label = (o, sel) => { const t = o.tag ? ` ${c.leaf(o.tag)}` : '', l = sel ? c.bold(c.ink(o.label)) : o.label; return l + t + ' '.repeat(w - full(o).length); };
    // A line wider than the window wraps onto a second row, and the redraw would then move up too
    // few rows and leave a copy of the question behind. So hints are cut to fit, and rows are counted.
    const cols = () => process.stdout.columns || 80;
    const fit = (h) => { const room = Math.max(0, cols() - w - 12); return h.length > room ? (room > 1 ? h.slice(0, room - 1).trimEnd() + '…' : '') : h; };
    const rows = (l) => Math.max(1, Math.ceil(width(l) / cols()));
    const draw = () => {
      if (drawn) process.stdout.write(`\x1b[${drawn}A\r\x1b[0J`);
      const hints = options.map((o) => fit(o.hint || ''));
      const hw = Math.max(...hints.map((h) => h.length));
      const lines = [`  ${c.bold(question)}`, ''];
      options.forEach((o, k) => {
        const sel = k === i;
        const body = ` ${sel ? c.leaf(String(k + 1)) : c.faint(String(k + 1))}  ${label(o, sel)}   ${sel ? c.muted(hints[k].padEnd(hw)) : c.faint(hints[k].padEnd(hw))} `;
        lines.push(`  ${sel ? c.leaf('▍') : ' '}${sel ? c.sel(body) : body}`);
      });
      lines.push('', `  ${c.faint(`↑↓ move · enter choose · 1–${options.length} pick · q quit`)}`);
      process.stdout.write(lines.join('\n') + '\n');
      drawn = lines.reduce((n, l) => n + rows(l), 0);
    };
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdout.write('\x1b[?25l'); // hide cursor
    const done = (v) => {
      process.stdin.off('keypress', onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\x1b[?25h');
      if (drawn) process.stdout.write(`\x1b[${drawn}A\r\x1b[0J`);
      const o = options.find((x) => x.value === v);
      if (o) process.stdout.write(`  ${c.leaf('✓')} ${c.muted(question)} ${c.bold(o.label)}\n`);
      resolve(v);
    };
    const onKey = (_, k = {}) => {
      if (k.name === 'up' || k.name === 'k') { i = (i + options.length - 1) % options.length; draw(); }
      else if (k.name === 'down' || k.name === 'j' || k.name === 'tab') { i = (i + 1) % options.length; draw(); }
      else if (k.name === 'return') done(options[i].value);
      else if (k.name === 'escape' || k.name === 'q' || (k.ctrl && k.name === 'c')) done(null);
      else if (/^[1-9]$/.test(k.sequence || '') && options[+k.sequence - 1]) { i = +k.sequence - 1; draw(); setTimeout(() => done(options[i].value), 90); }
    };
    process.stdin.on('keypress', onKey);
    draw();
  });
}
