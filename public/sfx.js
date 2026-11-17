// Sounds for the little moments, made on the fly with Web Audio (no files to load).
// Kept soft: rounded sine tones, a touch of room, nothing louder than a keyboard click.
// Off switch in ⌘K ("Turn sounds off"), remembered in localStorage.
const KEY = 'staged-sound';
let ctx = null, out = null, room = null;

export const soundOn = () => { try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; } };
export function setSound(on) { try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch {} if (on) chime(); }

function audio() {
  if (!soundOn() || document.hidden) return null;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!ctx) {
    ctx = new AC();
    out = ctx.createGain();
    out.gain.value = 1;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18; comp.ratio.value = 3;
    out.connect(comp).connect(ctx.destination);
    // A small, warm room: decaying noise as an impulse response.
    room = ctx.createConvolver();
    const len = Math.floor(ctx.sampleRate * 1.1), ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
    }
    room.buffer = ir;
    const wet = ctx.createGain();
    wet.gain.value = 0.22;
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass'; tone.frequency.value = 5000;
    room.connect(tone).connect(wet).connect(out);
  }
  if (ctx.state === 'suspended') ctx.resume?.()?.catch?.(() => {});
  return ctx;
}

// One soft note: a sine with a whisper of its octave, quick attack, smooth fall.
function note(freq, { at = 0, dur = 0.5, vol = 0.2, glide = 0, type = 'sine', wet = true, pan = 0 } = {}) {
  const a = audio();
  if (!a) return;
  const t = a.currentTime + 0.01 + at;
  const g = a.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  const p = a.createStereoPanner ? a.createStereoPanner() : null;
  if (p) p.pan.value = pan;
  const chain = p ? (g.connect(p), p) : g;
  chain.connect(out);
  if (wet) chain.connect(room);
  for (const [mult, lvl] of [[1, 1], [2, 0.18]]) {
    const o = a.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq * mult, t);
    if (glide) o.frequency.exponentialRampToValueAtTime(freq * mult * glide, t + Math.min(dur, 0.18));
    const lg = a.createGain();
    lg.gain.value = lvl;
    o.connect(lg).connect(g);
    o.start(t); o.stop(t + dur + 0.05);
  }
}

// A breath of filtered noise: whooshes and taps.
function air({ at = 0, dur = 0.25, vol = 0.08, from = 800, to = 3000, q = 0.8 } = {}) {
  const a = audio();
  if (!a) return;
  const t = a.currentTime + 0.01 + at;
  const len = Math.ceil(a.sampleRate * dur), buf = a.createBuffer(1, len, a.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const src = a.createBufferSource();
  src.buffer = buf;
  const f = a.createBiquadFilter();
  f.type = 'bandpass'; f.Q.value = q;
  f.frequency.setValueAtTime(from, t);
  f.frequency.exponentialRampToValueAtTime(to, t + dur);
  const g = a.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + dur * 0.35);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(out);
  src.start(t); src.stop(t + dur + 0.02);
}

const hz = (semis) => 523.25 * Math.pow(2, semis / 12); // semitones from C5
const PENTA = [0, 2, 4, 7, 9, 12, 14, 16];

// Commit, subtle. Card closes: a soft tuck.
export function sfxFold() {
  air({ dur: 0.22, vol: 0.05, from: 2400, to: 700, q: 1.2 });
  note(hz(-12), { dur: 0.16, vol: 0.12, glide: 0.7, wet: false });
}
// The dot lands on the banner: two warm notes, a fifth apart.
export function sfxLand() {
  note(hz(7), { dur: 0.5, vol: 0.13 });
  note(hz(14), { at: 0.07, dur: 0.75, vol: 0.1 });
}

// Push. Each commit lifts off: a little rising bloop, climbing the scale.
export function sfxLift(i, n) {
  const pan = n > 1 ? (i / (n - 1) - 0.5) * 0.5 : 0;
  note(hz(PENTA[i % PENTA.length]), { dur: 0.22, vol: 0.09, glide: 1.5, pan });
  if (i === 0) air({ dur: 0.5, vol: 0.035, from: 500, to: 2600 });
}
// A dot reaches the remote: a tiny pluck.
export function sfxCatch(i) {
  note(hz(PENTA[(i + 3) % PENTA.length] + 12), { dur: 0.14, vol: 0.05, type: 'triangle', wet: false });
}
// All there: a bright little bloom with a few glints.
export function sfxBurst() {
  [0, 4, 7, 12].forEach((s, k) => note(hz(s + 12), { at: k * 0.035, dur: 1.1, vol: 0.075, pan: (k - 1.5) * 0.15 }));
  for (let k = 0; k < 5; k++) note(hz(24 + PENTA[(k * 3) % PENTA.length]), { at: 0.12 + k * 0.05 + Math.random() * 0.03, dur: 0.25, vol: 0.03, type: 'triangle', pan: (Math.random() - 0.5) * 0.8 });
  air({ dur: 0.45, vol: 0.04, from: 3000, to: 9000, q: 0.6 });
}

// Discard: a quick soft swish downwards.
export function sfxDiscard() {
  air({ dur: 0.2, vol: 0.06, from: 3200, to: 500, q: 0.9 });
  note(hz(-5), { dur: 0.14, vol: 0.06, glide: 0.6, wet: false });
}
// A message has been written for you: a light two-step sparkle.
export function sfxWrote() {
  note(hz(19), { dur: 0.25, vol: 0.035, type: 'triangle' });
  note(hz(24), { at: 0.06, dur: 0.35, vol: 0.03, type: 'triangle' });
}

// Changes sorted into commits: soft wooden taps as each pile settles, then a low warm landing.
export function sfxGrouped(n = 3) {
  const steps = [0, 3, 7, 10].slice(0, Math.max(2, Math.min(4, n)));
  air({ dur: 0.3, vol: 0.03, from: 1800, to: 600, q: 0.7 });
  steps.forEach((s, k) => note(hz(s - 17), { at: 0.05 + k * 0.075, dur: 0.12, vol: 0.07, type: 'triangle', wet: false, pan: (k - (steps.length - 1) / 2) * 0.2 }));
  note(hz(-5), { at: 0.08 + steps.length * 0.075, dur: 0.55, vol: 0.06 });
}

// Played when sounds are turned on, so you hear the volume.
function chime() { note(hz(7), { dur: 0.4, vol: 0.12 }); note(hz(12), { at: 0.08, dur: 0.6, vol: 0.1 }); }
