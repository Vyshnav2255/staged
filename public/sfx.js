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

// A commit in a batch is made: a soft note that climbs with each one, so a batch plays a little run.
export function sfxTick(i) {
  note(hz(PENTA[i % PENTA.length] + 7), { dur: 0.32, vol: 0.075 });
}
// Let go of a hold too early: the charge drains away with a soft falling note.
export function sfxDrain() {
  note(hz(2), { dur: 0.22, vol: 0.05, glide: 0.6, wet: false });
}
// The card is accepted: the two quick bright beeps of a card reader.
export function sfxApproved() {
  note(hz(19), { dur: 0.09, vol: 0.06, type: 'triangle', wet: false });
  note(hz(19), { at: 0.13, dur: 0.16, vol: 0.06, type: 'triangle', wet: false });
}
// A motor, the way real printers sound: a stepper motor is a fast train of tiny mechanical
// clicks, and the printer's body rings at a few fixed pitches with each one. Built sample by
// sample so it buzzes like the real thing instead of sounding like a pure tone.
function motor({ at = 0, dur = 1, rate = 700, rateTo = 0, res = [2400, 4000], decay = 0.0015, vol = 0.05, noise = 0.3, jitter = 0.04, gate = null, accel = 0.08, fadeIn = 0.02, fadeOut = 0.06, lp = 7000 } = {}) {
  const a = audio();
  if (!a || dur <= 0) return;
  const sr = a.sampleRate, len = Math.ceil(sr * dur), buf = a.createBuffer(1, len, sr), d = buf.getChannelData(0);
  const klen = Math.ceil(decay * 6 * sr), w = res.map((f) => 2 * Math.PI * f / sr), shape = new Float32Array(klen);
  let t = 0, peak = 0;
  while (t < dur) {
    const r = (rate + ((rateTo || rate) - rate) * (t / dur)) * Math.min(1, 0.35 + 0.65 * (t / accel));
    if (!gate || gate(t)) {
      const i0 = Math.floor(t * sr), amp = 0.85 + Math.random() * 0.3, ph = Math.random() * 6.28;
      for (let k = 0; k < klen && i0 + k < len; k++) {
        let s = noise * (Math.random() * 2 - 1);
        for (let j = 0; j < w.length; j++) s += Math.sin(w[j] * k + ph * j) / (1 + j * 0.6);
        d[i0 + k] += s * Math.exp(-k / (decay * sr)) * amp;
      }
    }
    t += (1 / r) * (1 + (Math.random() - 0.5) * jitter);
  }
  for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(d[i]));
  if (peak) for (let i = 0; i < len; i++) d[i] /= peak;
  const T = a.currentTime + 0.01 + at;
  const src = a.createBufferSource(); src.buffer = buf;
  const f = a.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp;
  const g = a.createGain();
  g.gain.setValueAtTime(0, T); g.gain.linearRampToValueAtTime(vol, T + fadeIn);
  g.gain.setValueAtTime(vol, T + Math.max(fadeIn, dur - fadeOut)); g.gain.linearRampToValueAtTime(0, T + dur);
  src.connect(f).connect(g).connect(out); g.connect(room);
  src.start(T);
}
// The printer: a label printer's light, quick feed that runs exactly as long as the paper is
// moving (so a long receipt prints for longer), then the snip of its blade.
export function sfxLaser(warmMs = 380, feedMs = 2000) {
  const w = warmMs / 1000, f = feedMs / 1000;
  motor({ at: w, dur: f, rate: 950, res: [2800, 4700], decay: 0.001, vol: 0.035, noise: 0.25, accel: 0.06 });
  tick({ at: w + f + 0.06, vol: 0.05 }); tick({ at: w + f + 0.11, vol: 0.04 });
}
// The page is out: the billing counter's beep-beep-beep, a little piezo buzzer in the printer.
// Square wave near 2.7kHz with flat, instant on/off (no soft fade), softened so it isn't shrill.
export function sfxBeeps(at = 0) {
  const a = audio();
  if (!a) return;
  const t0 = a.currentTime + 0.01 + at;
  const o = a.createOscillator(); o.type = 'square'; o.frequency.value = 2730;
  const bp = a.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2730; bp.Q.value = 2.5;
  const lp = a.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 5200;
  const g = a.createGain(); g.gain.setValueAtTime(0, t0);
  for (let i = 0; i < 3; i++) {
    const s = t0 + i * 0.2;
    g.gain.setValueAtTime(0, s); g.gain.linearRampToValueAtTime(0.032, s + 0.003);
    g.gain.setValueAtTime(0.032, s + 0.1); g.gain.linearRampToValueAtTime(0, s + 0.104);
  }
  o.connect(bp).connect(lp).connect(g).connect(out);
  o.start(t0); o.stop(t0 + 0.65);
}
// A tiny mechanical click: a few milliseconds of bright noise.
function tick({ at = 0, vol = 0.04 } = {}) {
  const a = audio();
  if (!a) return;
  const t = a.currentTime + 0.01 + at, len = Math.ceil(a.sampleRate * 0.012);
  const buf = a.createBuffer(1, len, a.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  const src = a.createBufferSource(); src.buffer = buf;
  const f = a.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 2500;
  const g = a.createGain(); g.gain.value = vol;
  src.connect(f).connect(g).connect(out);
  src.start(t);
}
// The rubber stamp: a dull thump with a little ink squish.
export function sfxStamp() {
  note(hz(-31), { dur: 0.16, vol: 0.14, type: 'sine', glide: 0.6, wet: true });
  air({ dur: 0.07, vol: 0.06, from: 900, to: 300, q: 1.2 });
}
// Tearing the receipt off: a quick papery rip.
export function sfxTear() {
  air({ dur: 0.16, vol: 0.07, from: 2200, to: 6500, q: 0.7 });
  air({ at: 0.05, dur: 0.12, vol: 0.05, from: 4000, to: 9000, q: 0.9 });
}

// Discard: a quick soft swish downwards.
export function sfxDiscard() {
  air({ dur: 0.2, vol: 0.06, from: 3200, to: 500, q: 0.9 });
  note(hz(-5), { dur: 0.14, vol: 0.06, glide: 0.6, wet: false });
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

// A tape deck key going down (Play) or popping back up (Stop): a short plastic clunk.
export function sfxClunk(up = false) {
  air({ dur: 0.05, vol: 0.08, from: up ? 2600 : 1800, to: 400, q: 1.4 });
  note(hz(up ? -17 : -22), { dur: 0.08, vol: 0.09, type: 'sine', glide: 0.7, wet: false });
}
// The scale settles after a run of Shrink: one short soft beep, like a kitchen scale reading a weight.
export function sfxSettle() {
  note(hz(19), { at: 0.95, dur: 0.09, vol: 0.05, type: 'triangle', wet: false });
}
// Warming up, for as long as a dev server is getting ready: like an amp's valves coming on, a low soft hum
// that swells in, lifts a little, then breathes quietly until the server is live (or fails, or is stopped).
// warmHum(true) starts it if it isn't playing; warmHum(false) fades it out. It gives up on its own after 90 s.
let hum = null;
export function warmHum(on) {
  if (!on) {
    if (!hum) return;
    const { a, g, oscs, cap } = hum; hum = null; clearTimeout(cap);
    const t = a.currentTime;
    g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(g.gain.value, t); g.gain.linearRampToValueAtTime(0, t + 0.3);
    for (const o of oscs) o.stop(t + 0.35);
    return;
  }
  if (hum) return;
  const a = audio();
  if (!a) return;
  const t = a.currentTime + 0.06;
  const g = a.createGain();
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.04, t + 0.6); g.gain.linearRampToValueAtTime(0.026, t + 1.4);
  g.connect(out); g.connect(room);
  const oscs = [];
  for (const [f, type, lvl] of [[hz(-29), 'sine', 1], [hz(-17), 'triangle', 0.3]]) {
    const o = a.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f * 0.9, t); o.frequency.exponentialRampToValueAtTime(f, t + 0.8);
    const lg = a.createGain(); lg.gain.value = lvl;
    o.connect(lg).connect(g); o.start(t); oscs.push(o);
  }
  // a slow breath on the volume so the hold doesn't sound like a test tone
  const lfo = a.createOscillator(), depth = a.createGain();
  lfo.frequency.value = 0.45; depth.gain.value = 0.008;
  lfo.connect(depth).connect(g.gain); lfo.start(t); oscs.push(lfo);
  air({ at: 0.08, dur: 0.7, vol: 0.016, from: 300, to: 1400, q: 0.6 });
  hum = { a, g, oscs, cap: setTimeout(() => warmHum(false), 90000) };
}
// Something failed: two soft, slightly buzzy notes falling a minor third, with a dull knock under the first.
export function sfxError() {
  note(hz(-9), { dur: 0.16, vol: 0.07, type: 'triangle', wet: true });
  note(hz(-12), { at: 0.15, dur: 0.32, vol: 0.07, type: 'triangle', wet: true });
  note(hz(-33), { dur: 0.1, vol: 0.08, glide: 0.5, wet: false });
}
// A small deck key (output, the … menu): a light plastic tick, a touch higher when it opens.
export function sfxKey(open = true) {
  tick({ vol: 0.05 });
  note(hz(open ? -12 : -15), { dur: 0.06, vol: 0.05, type: 'triangle', glide: 0.8, wet: false });
}
// Opening the live page: two quick bright notes going up, like a tab popping open.
export function sfxOpen() {
  note(hz(7), { dur: 0.12, vol: 0.07, wet: true });
  note(hz(14), { at: 0.07, dur: 0.22, vol: 0.06, wet: true });
}
// Copied: a short soft snip.
export function sfxCopy() {
  tick({ vol: 0.045 });
  note(hz(19), { at: 0.015, dur: 0.07, vol: 0.04, wet: false });
}
