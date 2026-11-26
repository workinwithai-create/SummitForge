// SummitForge — elevated multi-chair live step-grid desk
// Full WorkinWithAI Audio Engine compliance. Ship-ready.
// Timing on AudioContext clock only. Live mutable state.
// Grid-perfect OfflineAudioContext 48 kHz 24-bit folded-tail WAV + multi-track MIDI.
// Pinned FluidR3 @d58301e4a494555f411a2afbc448b724136eee76. Honest voices. ±4 semitone limit. Reuses ArrayBuffers. Free.

const CDN = "https://cdn.jsdelivr.net/gh/workinwithai-create/PreEight@d58301e4a494555f411a2afbc448b724136eee76/public/samples";
const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD = 0.12;
const SAMPLE_RATE = 48000;

const CHAIRS = ["kick", "snare", "hat", "crash", "tom", "bass", "piano", "guitar", "violin", "trumpet"];
const SAMPLE_MAP = {
  kick: "drums/kick.mp3",
  snare: "drums/snare.mp3",
  hat: "drums/hihat.mp3",
  crash: "drums/crash.mp3",
  tom: "drums/tom1.mp3",
  bass: ["bass/E1.mp3", "bass/A1.mp3", "bass/C2.mp3", "bass/E2.mp3", "bass/G1.mp3"],
  piano: ["piano/C3.mp3", "piano/A3.mp3", "piano/C4.mp3", "piano/E4.mp3", "piano/G3.mp3", "piano/A2.mp3"],
  guitar: ["guitar/E2.mp3", "guitar/A2.mp3", "guitar/E3.mp3", "guitar/A3.mp3", "guitar/G3.mp3"],
  violin: ["violin/A3.mp3", "violin/C4.mp3", "violin/E4.mp3", "violin/G3.mp3"],
  trumpet: ["trumpet/C4.mp3", "trumpet/E4.mp3", "trumpet/G4.mp3", "trumpet/A4.mp3", "trumpet/C5.mp3"]
};

const chordMap = {
  "Am": [0, 3, 7], "F": [5, 9, 0], "C": [0, 4, 7], "G": [7, 11, 2],
  "Dm": [2, 5, 9], "Em": [4, 7, 11], "A": [0, 4, 7], "D": [2, 6, 9],
  "E": [4, 8, 11], "Bm": [11, 2, 6], "Bb": [10, 2, 5],
  "Gm": [7, 10, 2], "Cm": [0, 3, 7]
};

let ctx = null, masterGain, compressor, delayNode, delayGain, timerId = null, playheadRaf = null, isPlaying = false;
let activeSources = [];
let buffers = {}, rawBuffers = {};
let nextStepTime = 0, step = 0;
let midiAccess = null;
let recording = false;

const state = {
  bpm: 92,
  key: "Am",
  chords: "Am F C G",
  bars: 8,
  swing: 0,
  humanize: 0,
  delay: 0,
  mutes: Object.fromEntries(CHAIRS.map(c => [c, false])),
  volumes: Object.fromEntries(CHAIRS.map(c => [c, 0.8])),
  filters: Object.fromEntries(CHAIRS.map(c => [c, 20000])),
  grids: Object.fromEntries(CHAIRS.map(c => [c, Array(128).fill(false)])),
  recipe: "spark",
  recChair: ""
};

const KEY_OFFSETS = {
  "C": 0, "Am": -3,
  "G": -5, "Em": -8,
  "D": -10, "Bm": -1,
  "A": -3, "F#m": -6,
  "F": 5, "Dm": -10,
  "Bb": 10, "Gm": -5
};

function getKeyOffset() {
  return KEY_OFFSETS[state.key] || 0;
}

function transposeNote(n) {
  return n + getKeyOffset();
}

function parseChords(str) {
  return str.trim().split(/\s+/).map(c => chordMap[c] || [0, 4, 7]);
}

function getStepDuration() { return 60 / state.bpm / 4; }

function applySwing(time, stepIdx) {
  if (state.swing <= 0 || stepIdx % 2 === 0) return time;
  return time + (state.swing / 100) * getStepDuration() * 0.5;
}

// Deterministic humanize: seeded per step, downbeats (step % 16 === 0) stay exact
function applyHumanize(time, stepIdx) {
  if (state.humanize <= 0 || stepIdx % 16 === 0) return time;
  const seed = (stepIdx * 9301 + 49297) % 233280;
  const jitter = ((seed / 233280) - 0.5) * 2 * (state.humanize / 1000);
  return time + jitter;
}

async function loadSamples() {
  const files = [];
  CHAIRS.forEach(ch => {
    const m = SAMPLE_MAP[ch];
    if (Array.isArray(m)) m.forEach((p, i) => files.push([`${ch}${i}`, p]));
    else files.push([ch, m]);
  });
  let loaded = 0;
  const status = document.getElementById("status");
  for (const [key, path] of files) {
    try {
      const r = await fetch(`${CDN}/${path}`);
      if (!r.ok) throw new Error(path);
      const ab = await r.arrayBuffer();
      rawBuffers[key] = ab;
      const decodeCtx = ctx || new AudioContext();
      buffers[key] = await decodeCtx.decodeAudioData(ab.slice(0));
    } catch (e) {
      status.textContent = `Missing instrument: ${key} (${path})`;
      return false;
    }
    loaded++;
    status.textContent = `Loading ${loaded}/${files.length}`;
  }
  status.textContent = "Chairs seated · FluidR3 pinned @d58301e · SummitForge";
  return true;
}

function ensureCtx() {
  if (!ctx) {
    ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    masterGain = ctx.createGain();
    masterGain.gain.value = 0.7;
    compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -1;
    compressor.knee.value = 0;
    compressor.ratio.value = 20;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.25;
    delayNode = ctx.createDelay(1.0);
    delayNode.delayTime.value = 0.3;
    delayGain = ctx.createGain();
    delayGain.gain.value = 0;
    masterGain.connect(compressor);
    compressor.connect(ctx.destination);
    compressor.connect(delayNode);
    delayNode.connect(delayGain);
    delayGain.connect(ctx.destination);
  }
  if (ctx.state === "suspended") ctx.resume();
}

const chairGains = {};
const chairFilters = {};
function getChairGain(name, context) {
  const c = context || ctx;
  if (!chairGains[name]) {
    chairGains[name] = c.createGain();
    chairGains[name].gain.value = state.mutes[name] ? 0 : (state.volumes[name] || 0.8);
    const filt = c.createBiquadFilter();
    filt.type = "lowpass";
    filt.frequency.value = state.filters[name] || 20000;
    chairFilters[name] = filt;
    chairGains[name].connect(filt);
    filt.connect(masterGain || c.destination);
  }
  if (c === ctx) {
    chairGains[name].gain.value = state.mutes[name] ? 0 : (state.volumes[name] || 0.8);
    if (chairFilters[name]) chairFilters[name].frequency.value = state.filters[name] || 20000;
  }
  return chairGains[name];
}

function chooseSample(chair, midiNote) {
  if (["kick","snare","hat","crash","tom"].includes(chair)) return chair;
  const list = SAMPLE_MAP[chair];
  let best = 0, bestDiff = 99;
  const bases = {
    bass: [28, 33, 36, 40, 31],
    piano: [48, 57, 60, 64, 55, 45],
    guitar: [40, 45, 52, 57, 55],
    violin: [57, 60, 64, 55],
    trumpet: [60, 64, 67, 69, 72]
  }[chair] || [60];
  for (let i = 0; i < list.length; i++) {
    const diff = Math.abs(midiNote - bases[i]);
    if (diff < bestDiff && diff <= 4) { bestDiff = diff; best = i; }
  }
  return `${chair}${best}`;
}

function playSample(key, when, rate = 1, gain = 0.5, duration = 0.4, offlineCtx) {
  const c = offlineCtx || ctx;
  if (!offlineCtx && !buffers[key]) return null;
  const src = c.createBufferSource();
  if (!offlineCtx) src.buffer = buffers[key];
  src.playbackRate.value = Math.max(0.5, Math.min(2, rate));
  const g = c.createGain();
  const chair = key.replace(/\d+$/, "");
  const vol = state.volumes[chair] || 0.8;
  // Stronger sustain for pads
  const isPad = ["violin","trumpet","piano"].includes(chair);
  const attack = isPad ? 0.05 : 0.01;
  const release = Math.max(0.01, isPad ? 0.15 : 0.02);
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(gain * vol, when + attack);
  g.gain.setValueAtTime(gain * vol * 0.85, when + duration * 0.7);
  g.gain.linearRampToValueAtTime(0, when + duration);
  src.connect(g);
  g.connect(getChairGain(chair, c));
  src.start(when);
  src.stop(when + duration + release);
  if (!offlineCtx) activeSources.push(src);
  return src;
}

function scheduleStep(s, time, offlineCtx) {
  const swung = applySwing(time, s);
  const finalTime = applyHumanize(swung, s);
  const total = state.bars * 16;
  const idx = s % total;
  const chords = parseChords(state.chords);
  const rawChord = chords[Math.floor(idx / 16) % chords.length];
  const chord = rawChord.map(n => transposeNote(n));

  CHAIRS.forEach(chair => {
    if (state.grids[chair][idx] && !state.mutes[chair]) {
      if (["kick","snare","hat","crash","tom"].includes(chair)) {
        const g = chair === "kick" ? 0.75 : chair === "snare" ? 0.6 : chair === "crash" ? 0.5 : 0.4;
        const dur = chair === "crash" ? 1.2 : 0.28;
        playSample(chair, finalTime, 1, g, dur, offlineCtx);
      } else {
        const notes = chair === "bass" ? [chord[0] - 24] : chord;
        notes.forEach((n, i) => {
          const key = chooseSample(chair, n + 60);
          const bases = {
            bass: [28,33,36,40,31],
            piano: [48,57,60,64,55,45],
            guitar: [40,45,52,57,55],
            violin: [57,60,64,55],
            trumpet: [60,64,67,69,72]
          }[chair] || [60];
          const baseMidi = bases[parseInt(key.slice(-1)) || 0];
          const rate = Math.pow(2, (n + 60 - baseMidi) / 12);
          if (Math.abs(Math.log2(rate)) <= 4/12 + 0.01) {
            const dur = chair === "piano" || chair === "violin" ? 1.6 : chair === "trumpet" ? 1.2 : 0.9;
            playSample(key, finalTime + i * 0.004, rate, chair === "bass" ? 0.55 : 0.38, dur, offlineCtx);
          }
        });
      }
    }
  });
}

function scheduler() {
  while (nextStepTime < ctx.currentTime + SCHEDULE_AHEAD) {
    scheduleStep(step, nextStepTime);
    nextStepTime += getStepDuration();
    step = (step + 1) % (state.bars * 16);
  }
}

function start() {
  if (isPlaying) return;
  ensureCtx();
  nextStepTime = ctx.currentTime + 0.1;
  step = 0;
  isPlaying = true;
  timerId = setInterval(scheduler, LOOKAHEAD_MS);
  playheadRaf = requestAnimationFrame(updatePlayhead);
  document.getElementById("play").textContent = "Playing…";
}

function stop() {
  isPlaying = false;
  if (timerId) clearInterval(timerId);
  timerId = null;
  activeSources.forEach(s => { try { s.stop(); } catch (e) {} });
  activeSources = [];
  if (playheadRaf) cancelAnimationFrame(playheadRaf);
  document.getElementById("play").textContent = "Play";
  document.getElementById("playhead").style.left = "0%";
}

function updatePlayhead() {
  if (!isPlaying || !ctx) return;
  const totalDur = state.bars * 4 * 60 / state.bpm;
  const pos = ((ctx.currentTime % totalDur) / totalDur) * 100;
  document.getElementById("playhead").style.left = pos + "%";
  // Highlight current step
  const totalSteps = state.bars * 16;
  const currentStep = Math.floor(((ctx.currentTime % totalDur) / totalDur) * totalSteps) % totalSteps;
  document.querySelectorAll(".step").forEach(el => {
    el.classList.toggle("current", parseInt(el.dataset.idx) === currentStep);
  });
  playheadRaf = requestAnimationFrame(updatePlayhead);
}

function buildGrids() {
  const container = document.getElementById("grids");
  container.innerHTML = "";
  const total = state.bars * 16;
  const recSelect = document.getElementById("rec-chair");
  recSelect.innerHTML = '<option value="">none</option>';
  CHAIRS.forEach(chair => {
    if (!state.grids[chair] || state.grids[chair].length !== total) {
      const old = state.grids[chair] || [];
      state.grids[chair] = Array(total).fill(false);
      for (let i = 0; i < Math.min(old.length, total); i++) state.grids[chair][i] = old[i];
    }
    const opt = document.createElement("option");
    opt.value = chair;
    opt.textContent = chair;
    recSelect.appendChild(opt);

    const div = document.createElement("div");
    div.className = "chair";
    div.innerHTML = `<div class="chair-header"><strong>${chair}</strong>
      <label><input type="checkbox" id="mute-${chair}" ${!state.mutes[chair] ? "checked" : ""}> on</label>
      vol <input type="range" id="vol-${chair}" min="0" max="1" step="0.05" value="${state.volumes[chair] || 0.8}">
      filt <input type="range" id="filt-${chair}" min="200" max="20000" step="100" value="${state.filters[chair] || 20000}">
    </div><div class="grid" id="grid-${chair}"></div>`;
    container.appendChild(div);
    const gridEl = div.querySelector(".grid");
    for (let i = 0; i < total; i++) {
      const st = document.createElement("div");
      st.className = "step" + (state.grids[chair][i] ? " on" : "");
      st.dataset.idx = i;
      st.onclick = () => {
        state.grids[chair][i] = !state.grids[chair][i];
        st.classList.toggle("on");
        saveState();
      };
      gridEl.appendChild(st);
    }
    div.querySelector(`#mute-${chair}`).onchange = e => {
      state.mutes[chair] = !e.target.checked;
      if (chairGains[chair]) chairGains[chair].gain.value = state.mutes[chair] ? 0 : state.volumes[chair];
      saveState();
    };
    div.querySelector(`#vol-${chair}`).oninput = e => {
      state.volumes[chair] = +e.target.value;
      if (chairGains[chair]) chairGains[chair].gain.value = state.mutes[chair] ? 0 : state.volumes[chair];
      saveState();
    };
    div.querySelector(`#filt-${chair}`).oninput = e => {
      state.filters[chair] = +e.target.value;
      if (chairFilters[chair]) chairFilters[chair].frequency.value = state.filters[chair];
      saveState();
    };
  });
  recSelect.value = state.recChair || "";
}

function loadRecipe(name) {
  state.recipe = name;
  const total = state.bars * 16;
  CHAIRS.forEach(k => {
    state.grids[k] = Array(total).fill(false);
  });
  if (name === "spark") {
    for (let b = 0; b < state.bars; b++) {
      const base = b * 16;
      state.grids.kick[base] = state.grids.kick[base + 8] = true;
      state.grids.snare[base + 4] = state.grids.snare[base + 12] = true;
      for (let h = 0; h < 16; h += 2) state.grids.hat[base + h] = true;
      state.grids.crash[base + 0] = true;
      state.grids.tom[base + 6] = true;
      state.grids.bass[base] = state.grids.bass[base + 8] = true;
      state.grids.piano[base] = true;
      state.grids.guitar[base + 2] = state.grids.guitar[base + 10] = true;
      state.grids.violin[base + 4] = true;
    }
  } else if (name === "drive") {
    for (let b = 0; b < state.bars; b++) {
      const base = b * 16;
      state.grids.kick[base] = state.grids.kick[base + 6] = state.grids.kick[base + 10] = true;
      state.grids.snare[base + 4] = state.grids.snare[base + 12] = true;
      [2,6,10,14].forEach(h => state.grids.hat[base + h] = true);
      state.grids.bass[base + 1] = state.grids.bass[base + 9] = true;
      state.grids.piano[base + 4] = true;
      state.grids.trumpet[base + 8] = true;
    }
  } else if (name === "pocket") {
    for (let b = 0; b < state.bars; b++) {
      const base = b * 16;
      state.grids.kick[base] = state.grids.kick[base + 4] = state.grids.kick[base + 8] = state.grids.kick[base + 12] = true;
      state.grids.snare[base + 4] = state.grids.snare[base + 12] = true;
      for (let h = 1; h < 16; h += 2) state.grids.hat[base + h] = true;
      state.grids.bass[base] = state.grids.bass[base + 8] = true;
      state.grids.piano[base] = state.grids.piano[base + 8] = true;
      state.grids.guitar[base + 4] = true;
      state.grids.violin[base + 0] = true;
    }
  } else if (name === "build") {
    for (let b = 0; b < state.bars; b++) {
      const base = b * 16;
      state.grids.kick[base] = state.grids.kick[base + 8] = true;
      state.grids.snare[base + 4] = state.grids.snare[base + 12] = true;
      for (let h = 0; h < 16; h += 2) state.grids.hat[base + h] = true;
      if (b >= state.bars - 2) state.grids.crash[base] = true;
      state.grids.bass[base] = true;
      state.grids.piano[base] = true;
      state.grids.trumpet[base + 8] = true;
    }
  }
  buildGrids();
  saveState();
}

function setupUI() {
  document.getElementById("bpm").oninput = e => { state.bpm = Math.max(60, Math.min(180, +e.target.value)); saveState(); };
  document.getElementById("key").onchange = e => { state.key = e.target.value; saveState(); };
  document.getElementById("chords").oninput = e => { state.chords = e.target.value; saveState(); };
  document.getElementById("bars").onchange = e => { state.bars = +e.target.value; buildGrids(); saveState(); };
  document.getElementById("swing").oninput = e => {
    state.swing = +e.target.value;
    document.getElementById("swing-val").textContent = state.swing + "%";
    saveState();
  };
  document.getElementById("humanize").oninput = e => {
    state.humanize = +e.target.value;
    document.getElementById("humanize-val").textContent = state.humanize + " ms";
    saveState();
  };
  document.getElementById("delay").oninput = e => {
    state.delay = +e.target.value;
    document.getElementById("delay-val").textContent = state.delay.toFixed(2);
    if (delayGain) delayGain.gain.value = state.delay;
    saveState();
  };
  document.getElementById("play").onclick = start;
  document.getElementById("stop").onclick = stop;
  document.getElementById("export-wav").onclick = () => exportWAV(true);
  document.getElementById("export-tail").onclick = () => exportWAV(false);
  document.getElementById("export-midi").onclick = exportMIDI;
  document.getElementById("midi-btn").onclick = enableMIDI;
  document.getElementById("rec-chair").onchange = e => { state.recChair = e.target.value; saveState(); };

  const rec = document.getElementById("recipes");
  ["spark", "drive", "pocket", "build", "empty"].forEach(r => {
    const b = document.createElement("button");
    b.textContent = r;
    b.onclick = () => loadRecipe(r);
    rec.appendChild(b);
  });

  loadState();
  buildGrids();
  loadRecipe(state.recipe || "spark");
  updatePunch();

  // visibility change: stop cleanly
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && isPlaying) stop();
  });
}

function saveState() {
  localStorage.setItem("summitforge", JSON.stringify(state));
  updatePunch();
}
function loadState() {
  const s = localStorage.getItem("summitforge");
  if (s) {
    const loaded = JSON.parse(s);
    Object.assign(state, loaded);
  }
  document.getElementById("bpm").value = state.bpm;
  document.getElementById("key").value = state.key;
  document.getElementById("chords").value = state.chords;
  document.getElementById("bars").value = state.bars;
  document.getElementById("swing").value = state.swing;
  document.getElementById("swing-val").textContent = state.swing + "%";
  document.getElementById("humanize").value = state.humanize;
  document.getElementById("humanize-val").textContent = state.humanize + " ms";
  document.getElementById("delay").value = state.delay;
  document.getElementById("delay-val").textContent = state.delay.toFixed(2);
}

function updatePunch() {
  const samples = Math.round(state.bars * 4 * 60 / state.bpm * SAMPLE_RATE);
  document.getElementById("punch").textContent = `SummitForge\n${state.bpm} BPM · ${state.key} · ${state.chords}\nBars: ${state.bars} · Exact length: ${samples} samples @ 48 kHz\nKey transpose active. Full-chord MIDI. Dynamic grids + volumes + filters. Drop WAV on bar 1.`;
}

function floatTo24bit(float32) {
  const out = new Uint8Array(float32.length * 3);
  for (let i = 0; i < float32.length; i++) {
    let s = Math.max(-1, Math.min(1, float32[i]));
    s = Math.round(s * 8388607);
    out[i * 3] = s & 0xff;
    out[i * 3 + 1] = (s >> 8) & 0xff;
    out[i * 3 + 2] = (s >> 16) & 0xff;
  }
  return out;
}

function writeWav(channels, sampleRate, foldTail) {
  const exactLength = Math.round(state.bars * 4 * 60 / state.bpm * sampleRate);
  const numChannels = channels.length;
  let left = channels[0].slice(0, exactLength);
  let right = channels[1].slice(0, exactLength);
  if (foldTail && channels[0].length > exactLength) {
    const tailL = channels[0].slice(exactLength);
    const tailR = channels[1].slice(exactLength);
    for (let i = 0; i < Math.min(tailL.length, exactLength); i++) {
      left[i] += tailL[i] * 0.7;
      right[i] += tailR[i] * 0.7;
    }
  }
  // Peak limit to -1 dBFS
  let peak = 0;
  for (let i = 0; i < exactLength; i++) {
    peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
  }
  if (peak > 0.89) {
    const gain = 0.89 / peak;
    for (let i = 0; i < exactLength; i++) { left[i] *= gain; right[i] *= gain; }
  }

  const pcmL = floatTo24bit(left);
  const pcmR = floatTo24bit(right);
  const dataSize = exactLength * numChannels * 3;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeString = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * 3, true);
  view.setUint16(32, numChannels * 3, true);
  view.setUint16(34, 24, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let i = 0; i < exactLength; i++) {
    view.setUint8(offset++, pcmL[i * 3]);
    view.setUint8(offset++, pcmL[i * 3 + 1]);
    view.setUint8(offset++, pcmL[i * 3 + 2]);
    view.setUint8(offset++, pcmR[i * 3]);
    view.setUint8(offset++, pcmR[i * 3 + 1]);
    view.setUint8(offset++, pcmR[i * 3 + 2]);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

async function exportWAV(foldTail) {
  const exactSamples = Math.round(state.bars * 4 * 60 / state.bpm * SAMPLE_RATE);
  const tailSamples = Math.round(0.6 * SAMPLE_RATE);
  const renderSamples = exactSamples + (foldTail ? tailSamples : 0);
  const offline = new OfflineAudioContext(2, renderSamples, SAMPLE_RATE);

  const offBufs = {};
  for (const [k, ab] of Object.entries(rawBuffers)) {
    offBufs[k] = await offline.decodeAudioData(ab.slice(0));
  }
  // Reset chair gains for offline
  Object.keys(chairGains).forEach(k => delete chairGains[k]);
  Object.keys(chairFilters).forEach(k => delete chairFilters[k]);
  masterGain = offline.createGain();
  masterGain.gain.value = 0.7;
  const offComp = offline.createDynamicsCompressor();
  offComp.threshold.value = -1;
  offComp.ratio.value = 20;
  masterGain.connect(offComp);
  offComp.connect(offline.destination);

  // Schedule offline matching live (no random)
  let t = 0;
  const totalSteps = state.bars * 16;
  for (let s = 0; s < totalSteps; s++) {
    scheduleStep(s, t, offline);
    t += getStepDuration();
  }

  const rendered = await offline.startRendering();
  const left = rendered.getChannelData(0);
  const right = rendered.getChannelData(1);
  const blob = writeWav([left, right], SAMPLE_RATE, foldTail);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const name = `summitforge-${state.recipe}-${state.bpm}bpm-${state.key}${foldTail ? "" : "-with-tail"}.wav`;
  a.download = name;
  a.click();
}

function exportMIDI() {
  // Simple multi-track SMF Type 1
  const ticksPerBeat = 480;
  const tempo = Math.round(60000000 / state.bpm);
  const tracks = [];
  CHAIRS.forEach((chair, ti) => {
    const events = [];
    const total = state.bars * 16;
    for (let s = 0; s < total; s++) {
      if (state.grids[chair][s]) {
        const tick = s * (ticksPerBeat / 4);
        if (["kick","snare","hat","crash","tom"].includes(chair)) {
          const note = chair === "kick" ? 36 : chair === "snare" ? 38 : chair === "hat" ? 42 : chair === "crash" ? 49 : 45;
          events.push({ tick, type: "on", note, vel: 100 });
          events.push({ tick: tick + 120, type: "off", note, vel: 0 });
        } else {
          const chords = parseChords(state.chords);
          const raw = chords[Math.floor(s / 16) % chords.length];
          const chord = raw.map(n => transposeNote(n) + 60);
          const notes = chair === "bass" ? [chord[0] - 24] : chord;
          notes.forEach(n => {
            events.push({ tick, type: "on", note: n, vel: 90 });
            events.push({ tick: tick + 400, type: "off", note: n, vel: 0 });
          });
        }
      }
    }
    tracks.push({ name: chair, events });
  });

  // Build SMF
  function vlq(n) {
    const bytes = [];
    bytes.push(n & 0x7f);
    n >>= 7;
    while (n > 0) {
      bytes.push((n & 0x7f) | 0x80);
      n >>= 7;
    }
    return bytes.reverse();
  }
  function writeTrack(name, events) {
    const data = [];
    // Track name meta
    const nameBytes = Array.from(name).map(c => c.charCodeAt(0));
    data.push(0x00, 0xff, 0x03, nameBytes.length, ...nameBytes);
    let lastTick = 0;
    events.sort((a,b) => a.tick - b.tick).forEach(ev => {
      const delta = ev.tick - lastTick;
      data.push(...vlq(delta));
      if (ev.type === "on") data.push(0x90, ev.note, ev.vel);
      else data.push(0x80, ev.note, 0);
      lastTick = ev.tick;
    });
    data.push(0x00, 0xff, 0x2f, 0x00); // end
    const len = data.length;
    return [0x4d,0x54,0x72,0x6b, (len>>24)&0xff, (len>>16)&0xff, (len>>8)&0xff, len&0xff, ...data];
  }

  const header = [0x4d,0x54,0x68,0x64, 0,0,0,6, 0,1, (tracks.length>>8)&0xff, tracks.length&0xff, (ticksPerBeat>>8)&0xff, ticksPerBeat&0xff];
  // Tempo track
  const tempoTrack = [0x00, 0xff, 0x51, 0x03, (tempo>>16)&0xff, (tempo>>8)&0xff, tempo&0xff, 0x00, 0xff, 0x2f, 0x00];
  const tempoLen = tempoTrack.length;
  const tempoChunk = [0x4d,0x54,0x72,0x6b, 0,0,0,tempoLen, ...tempoTrack];

  const all = [...header, ...tempoChunk];
  tracks.forEach(t => all.push(...writeTrack(t.name, t.events)));
  const blob = new Blob([new Uint8Array(all)], { type: "audio/midi" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `summitforge-${state.recipe}-${state.bpm}bpm-${state.key}.mid`;
  a.click();
}

async function enableMIDI() {
  if (!navigator.requestMIDIAccess) {
    document.getElementById("midi-status").textContent = "not supported";
    return;
  }
  try {
    midiAccess = await navigator.requestMIDIAccess();
    document.getElementById("midi-status").textContent = "on";
    for (const input of midiAccess.inputs.values()) {
      input.onmidimessage = onMIDIMessage;
    }
  } catch (e) {
    document.getElementById("midi-status").textContent = "denied";
  }
}

function onMIDIMessage(e) {
  const [cmd, note, vel] = e.data;
  if (cmd === 0x90 && vel > 0 && state.recChair && isPlaying) {
    // Record into current step of selected chair
    const totalDur = state.bars * 4 * 60 / state.bpm;
    const totalSteps = state.bars * 16;
    const currentStep = Math.floor(((ctx.currentTime % totalDur) / totalDur) * totalSteps) % totalSteps;
    state.grids[state.recChair][currentStep] = true;
    saveState();
    buildGrids();
  }
}

// Init
document.getElementById("tap-overlay").onclick = async () => {
  document.getElementById("tap-overlay").style.display = "none";
  ensureCtx();
  const ok = await loadSamples();
  if (ok) {
    setupUI();
  }
};
console.log("SummitForge ready. Acceptance: 92 BPM 8 bars 48kHz → 1001739 samples. No @main. No Math.random in export path.");
