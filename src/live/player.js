// player.js — JMON Live Player (iframe module)
//
// Time-driven scheduler built on Tone.Transport. Notes are scheduled in ticks
// (so tempo changes don't displace them), the pattern loops on its musical
// duration rather than its event count, and pattern swaps default to taking
// effect at the next loop boundary so live edits don't tear the bar.
//
// Routing: tracks with `midiChannel` set go out via Web MIDI (drive a DAW via
// an OS virtual MIDI port — IAC on macOS, loopMIDI on Windows, snd-virmidi on
// Linux); everything else plays through Tone.js audio. Synth construction is
// delegated to `../synth-factory.js`, the same factory the offline
// `music-player` and `wav` renderers use, with the same `jmon/sound` provider
// behind it — so a track sounds identical live and offline.

import { Session } from "./session.js";
import { createTrackSynth } from "../synth-factory.js";

// Tone.js — ESM build via jsDelivr (matches the rest of algo). Tone's ESM
// build exposes Transport via getTransport() rather than as a namespace
// property, so we normalize once and use `Tone.Transport` throughout.
import * as ToneRaw from "https://cdn.jsdelivr.net/npm/tone@14.8.49/+esm";
const Tone = ToneRaw.Transport
  ? ToneRaw
  : Object.assign({}, ToneRaw, {
      Transport:
        typeof ToneRaw.getTransport === "function"
          ? ToneRaw.getTransport()
          : ToneRaw.Transport,
      context:
        typeof ToneRaw.getContext === "function"
          ? ToneRaw.getContext()
          : ToneRaw.context
    });

// Sampled instruments — General MIDI, drum kits — come from jmon/sound,
// fetched the same way Tone is. Optional on purpose: if it cannot be reached,
// a track asking for a GM program falls back to a synth rather than the whole
// player failing to start.
let io = null;
try {
  const mod = await import("https://cdn.jsdelivr.net/gh/jmonlabs/io@main/src/index.js");
  io = mod.default || mod;
} catch (e) {
  console.error("jmon/io is required to read a composition.", e);
  throw e;
}
const { tempoSegments, automationChannels, parseAutomationTarget, timeSignatureSegments } = io.format;

let sound = null;
try {
  const mod = await import("https://cdn.jsdelivr.net/gh/jmonlabs/sound@main/src/index.js");
  sound = mod.default || mod;
} catch (e) {
  console.warn("jmon/sound unavailable — General MIDI tracks will use a synth.", e);
}

const statusEl = document.getElementById("status");
const patternLenEl = document.getElementById("pattern-length");
const playedEl = document.getElementById("events-played");
const positionEl = document.getElementById("position");
const enableAudioBtn = document.getElementById("enable-audio");

const session = new Session();

// One synth per track label, lazily created via createTrackSynth.
const trackSynths = new Map();

// Tag describing the synth spec that built each entry in trackSynths, so we
// can detect a spec change (e.g. user swaps "synth: 40" for "synth: 47") and
// rebuild rather than serve a stale instrument.
const trackSynthTags = new Map();

// One Tone.Panner per track label, in line between the synth and destination.
// Survives synth rebuilds so per-track pan stays sticky across hot swaps.
const trackPanners = new Map();

// Staging cache for the next pattern's synths. When a pattern arrives that
// changes a track's synth spec, we build the new synth into staging and start
// loading its samples in parallel — the active loop keeps playing the old
// synth while loading proceeds. Once loaded, the swap promotes staging into
// the active cache so the new pattern doesn't lose its first notes.
const stagingSynths = new Map();
const stagingSynthTags = new Map();

// Sequence number so a late-arriving applyPattern doesn't overwrite a newer
// one. Each applyPattern bumps this; after the async `await` it checks
// whether it's still the active token before committing.
let applyToken = 0;

// Maximum time we'll hold a swap waiting for samples. If a CDN fetch hangs,
// it's better to swap with silent first notes than to leave the user stuck
// hearing the previous loop forever.
const SAMPLE_LOAD_TIMEOUT_MS = 8000;

// Last MIDI program / pan sent on each channel, so we only emit a control
// change when the value actually moves.
const channelPrograms = new Map();
const channelPans = new Map();

// Tone.Transport schedule IDs currently in flight, so we can clear on
// immediate swaps / resets without losing track.
let scheduledIds = [];

let audioStarted = false;
let pendingPattern = null;       // queued pattern
let pendingMode = null;          // "next-loop" | "next-bar"
let pendingBarSwapId = null;     // Transport schedule id for the bar-swap one-shot
let lastPatternSig = null;       // JSON signature of last applied pattern (for diff-skip)
let eventsPlayed = 0;
let currentIteration = 0;

// Web MIDI state
let midiAccess = null;
let midiOutput = null;

// Fire the loop boundary callback this many beats before the boundary, so the
// next iteration's events are scheduled with a comfortable lookahead.
const LOOKAHEAD_BEATS = 0.25;

function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
}

function beatsToTicks(beats) {
  const ppq = Tone.Transport.PPQ;
  return Math.max(0, Math.round(beats * ppq)) + "i";
}

function currentTransportBeats() {
  return Tone.Time(Tone.Transport.position).toTicks() / Tone.Transport.PPQ;
}

function toToneNote(pitch) {
  if (Array.isArray(pitch)) return pitch.map(toToneNote);
  if (typeof pitch === "number") return Tone.Frequency(pitch, "midi").toNote();
  return pitch;
}

function toMidiNumber(pitch) {
  if (typeof pitch === "number") return pitch;
  return Tone.Frequency(pitch).toMidi();
}

// Convert an AudioContext-domain time (what Tone callbacks hand us) to a
// performance.now()-domain time, which Web MIDI uses for `output.send()`.
function audioTimeToPerfTime(audioTime) {
  return performance.now() + (audioTime - Tone.context.currentTime) * 1000;
}

// Tag the synth cache by spec shape so we can detect a spec change (e.g. the
// user swaps "synth: 40" for "synth: 47") and rebuild rather than reuse the
// wrong instrument.
function synthSpecTag(spec) {
  if (spec == null) return "default";
  if (typeof spec === "number") return `gm:${spec | 0}`;
  if (typeof spec === "string") return `str:${spec}`;
  return `obj:${JSON.stringify(spec)}`;
}

function getOrCreatePanner(label) {
  let panner = trackPanners.get(label);
  if (!panner) {
    panner = new Tone.Panner(0).toDestination();
    trackPanners.set(label, panner);
  }
  return panner;
}

// Build (and connect) a fresh synth for a track using the shared factory.
// Returns { synth, loaded } — loaded is a promise that resolves when sample
// data is ready (or immediately for non-Sampler synths).
function buildTrackSynth(label, spec) {
  const panner = getOrCreatePanner(label);
  const { synth } = createTrackSynth(
    { synth: spec }, Tone, null, session.pattern?.customPresets, sound,
  );
  synth.connect(panner);
  // Tone.Sampler exposes .loaded as a Promise that resolves once all sample
  // URLs are fetched and decoded. Non-Sampler synths don't have it; treat as
  // already loaded.
  const loaded = (synth && typeof synth.loaded?.then === "function")
    ? synth.loaded
    : Promise.resolve();
  return { synth, loaded };
}

function getSynth(trackLabel, trackSynthSpec) {
  const key = trackLabel || "_default";
  const tag = synthSpecTag(trackSynthSpec);
  if (trackSynthTags.get(key) === tag) {
    return trackSynths.get(key);
  }
  // Fallback path — staging+promote should normally have installed the right
  // synth before the active session references this spec. If we get here
  // (spec drift, unstaged track), build inline. Old synth gets disposed; a
  // brief silence on this track is the trade for not throwing.
  const oldSynth = trackSynths.get(key);
  if (oldSynth && typeof oldSynth.dispose === "function") {
    try { oldSynth.dispose(); } catch (_) {}
  }
  const { synth } = buildTrackSynth(key, trackSynthSpec);
  trackSynths.set(key, synth);
  trackSynthTags.set(key, tag);
  return synth;
}

// Walk the upcoming pattern's tracks; for any whose synth spec differs from
// what's currently cached, build the new synth into staging and collect its
// load promise. Resolves once every staged sampler has finished loading (or
// the global timeout fires).
async function prepareStaging(tracks) {
  disposeStaging();
  const pending = [];
  for (const track of (tracks || [])) {
    const label = track.label || "_default";
    const tag = synthSpecTag(track.synth);
    if (trackSynthTags.get(label) === tag) continue; // unchanged — reuse active
    const { synth, loaded } = buildTrackSynth(label, track.synth);
    stagingSynths.set(label, synth);
    stagingSynthTags.set(label, tag);
    pending.push(loaded);
  }
  if (pending.length === 0) return;
  // Race the load against a timeout so a stuck CDN can't hang the player.
  const timeout = new Promise((r) => setTimeout(r, SAMPLE_LOAD_TIMEOUT_MS));
  await Promise.race([Promise.all(pending).catch(() => {}), timeout]);
}

// Move staging → active. Old active synths get disposed (their panners
// survive — panner is per-track, not per-synth, so per-track pan persists).
function promoteStaging() {
  for (const [label, newSynth] of stagingSynths) {
    const oldSynth = trackSynths.get(label);
    trackSynths.set(label, newSynth);
    trackSynthTags.set(label, stagingSynthTags.get(label));
    if (oldSynth && oldSynth !== newSynth && typeof oldSynth.dispose === "function") {
      try { oldSynth.dispose(); } catch (_) {}
    }
  }
  stagingSynths.clear();
  stagingSynthTags.clear();
}

// Tear down any unpromoted staging (e.g. a superseded applyPattern).
function disposeStaging() {
  for (const [, s] of stagingSynths) {
    if (typeof s.dispose === "function") {
      try { s.dispose(); } catch (_) {}
    }
  }
  stagingSynths.clear();
  stagingSynthTags.clear();
}

function syncTrackPans() {
  if (!session.tracks) return;
  session.tracks.forEach((track) => {
    const key = track.label || "_default";
    const panner = trackPanners.get(key);
    if (!panner) return;
    const pan = typeof track.pan === "number" ? track.pan : 0;
    panner.pan.value = Math.max(-1, Math.min(1, pan));
  });
}

function playAudioNote(note, time) {
  const synth = getSynth(note.trackLabel, note.trackSynth);
  const pitch = toToneNote(note.pitch);
  const duration = note.duration || "8n";
  const velocity = note.velocity ?? 0.8;
  synth.triggerAttackRelease(pitch, duration, time, velocity);
}

function playMidiNote(note, time) {
  if (!midiOutput) return;
  // JMON spec: midiChannel is an integer in [0, 15].
  const channel = Math.max(0, Math.min(15, note.trackMidiChannel | 0));
  const velocity = Math.max(1, Math.min(127, Math.round((note.velocity ?? 0.8) * 127)));
  const pitches = Array.isArray(note.pitch) ? note.pitch : [note.pitch];
  const durSec = session.quarterNotesToSeconds(
    session.parseDuration(note.duration || "8n")
  );
  const startMs = audioTimeToPerfTime(time);
  const endMs = startMs + durSec * 1000;

  // Emit a program change / pan CC just ahead of the note-on, only when the
  // value has moved since the last note on this channel.
  if (Number.isInteger(note.trackMidiProgram)) {
    const program = Math.max(0, Math.min(127, note.trackMidiProgram));
    if (channelPrograms.get(channel) !== program) {
      midiOutput.send([0xC0 | channel, program], startMs - 1);
      channelPrograms.set(channel, program);
    }
  }
  if (typeof note.trackPan === "number") {
    const pan = Math.max(-1, Math.min(1, note.trackPan));
    if (channelPans.get(channel) !== pan) {
      const cc10 = Math.max(0, Math.min(127, Math.round((pan + 1) * 63.5)));
      midiOutput.send([0xB0 | channel, 10, cc10], startMs - 1);
      channelPans.set(channel, pan);
    }
  }

  pitches.forEach((p) => {
    const midi = Math.max(0, Math.min(127, toMidiNumber(p)));
    midiOutput.send([0x90 | channel, midi, velocity], startMs);
    midiOutput.send([0x80 | channel, midi, 0], endMs);
  });
}

function playNote(note, time) {
  try {
    // JMON spec: tracks have either `synth`/`synthRef` (audio) or
    // `midiChannel` (MIDI). We route on midiChannel presence so a track
    // can have both audio and MIDI fields without ambiguity (audio wins
    // unless midiChannel is explicitly set).
    if (Number.isInteger(note.trackMidiChannel)) playMidiNote(note, time);
    else playAudioNote(note, time);
  } catch (err) {
    console.warn("Failed to play note:", note, err);
  }
  eventsPlayed++;
  if (playedEl) playedEl.textContent = eventsPlayed;
}

function clearAllScheduled() {
  scheduledIds.forEach((id) => Tone.Transport.clear(id));
  scheduledIds = [];
}

function emitLoopEvent(iteration, beat, time) {
  try {
    window.parent.postMessage(
      { type: "loop", iteration, beat, audioTime: time },
      "*"
    );
  } catch (_) {}
}

function scheduleIteration(startBeat) {
  const loopDur = session.loopDuration;
  if (!loopDur || !session.flattenedNotes.length) return;

  session.flattenedNotes.forEach((note) => {
    const id = Tone.Transport.schedule(
      (time) => playNote(note, time),
      beatsToTicks(startBeat + note.time)
    );
    scheduledIds.push(id);
  });

  // Automation is re-armed for every iteration, so its curve repeats with the
  // loop the way the notes do.
  applyAutomation(session.pattern, startBeat);

  const boundary = startBeat + loopDur;
  const triggerAt = Math.max(startBeat, boundary - LOOKAHEAD_BEATS);
  const boundaryId = Tone.Transport.schedule((time) => {
    if (pendingPattern && pendingMode === "next-loop") {
      // Staging samplers finished loading before applyPattern returned, so
      // promotion is just a cache swap here (no waiting).
      promoteStaging();
      session.setPattern(pendingPattern, true);
      syncTrackPans();
      pendingPattern = null;
      pendingMode = null;
    }
    currentIteration++;
    if (positionEl) positionEl.textContent = `loop ${currentIteration}`;
    emitLoopEvent(currentIteration, boundary, time);
    scheduleIteration(boundary);
  }, beatsToTicks(triggerAt));
  scheduledIds.push(boundaryId);
}

function restartScheduling() {
  clearAllScheduled();
  if (pendingBarSwapId !== null) {
    Tone.Transport.clear(pendingBarSwapId);
    pendingBarSwapId = null;
  }
  if (!session.flattenedNotes.length) return;
  const now = currentTransportBeats();
  const bpb = session.beatsPerBar || 4;
  // Start the new pattern at the next bar boundary so immediate swaps are
  // still musically aligned.
  const startBeat = Math.ceil(now / bpb) * bpb;
  currentIteration = 0;
  scheduleIteration(startBeat);
}

function scheduleBarSwap() {
  if (pendingBarSwapId !== null) Tone.Transport.clear(pendingBarSwapId);
  const now = currentTransportBeats();
  const bpb = session.beatsPerBar || 4;
  const swapBeat = Math.ceil((now + 0.001) / bpb) * bpb;
  const triggerAt = Math.max(now, swapBeat - LOOKAHEAD_BEATS);
  pendingBarSwapId = Tone.Transport.schedule(() => {
    pendingBarSwapId = null;
    if (pendingPattern && pendingMode === "next-bar") {
      promoteStaging();
      session.setPattern(pendingPattern, true);
      syncTrackPans();
      pendingPattern = null;
      pendingMode = null;
    }
    clearAllScheduled();
    currentIteration = 0;
    scheduleIteration(swapBeat);
  }, beatsToTicks(triggerAt));
}

// Tempo-map and automation schedule ids, cleared whenever a new pattern lands.
let timelineIds = [];

function clearTimeline() {
  for (const id of timelineIds) {
    try { Tone.Transport.clear(id); } catch (_) {}
  }
  timelineIds = [];
}

/**
 * Follow a pattern's tempoMap.
 *
 * Notes here are scheduled in transport ticks, so moving `Transport.bpm` is all
 * it takes — Tone re-derives the wall-clock position of every pending event.
 * That is the whole reason this player schedules in ticks rather than seconds.
 */
function applyTempoMap(pattern) {
  clearTimeline();
  if (!pattern) return;

  const segments = tempoSegments(pattern);
  if (segments.length <= 1) return;

  for (const segment of segments) {
    if (segment.time === 0) {
      Tone.Transport.bpm.value = segment.tempo;
      continue;
    }
    timelineIds.push(Tone.Transport.schedule(() => {
      Tone.Transport.bpm.value = segment.tempo;
    }, beatsToTicks(segment.time)));
  }
}

/**
 * Follow a pattern's timeSignatureMap.
 *
 * Notes are placed in quarter notes, which the metre does not change, so this
 * is about the transport agreeing with the music: the loop-boundary readout
 * and the `next-bar` swap mode both ask the transport where the bar line is.
 */
function applyTimeSignatureMap(pattern) {
  if (!pattern) return;
  const segments = timeSignatureSegments(pattern);

  for (const segment of segments) {
    const value = [segment.numerator, segment.denominator];
    if (segment.time === 0) {
      Tone.Transport.timeSignature = value;
      continue;
    }
    timelineIds.push(Tone.Transport.schedule(() => {
      Tone.Transport.timeSignature = value;
    }, beatsToTicks(segment.time)));
  }
}

/**
 * Follow a pattern's automation channels.
 *
 * Targets resolve against what this player actually owns: `track.<label>.<param>`
 * reaches a track's synth or its panner, `tempo` reaches the transport. Nodes
 * from an `audioGraph` are not built here — the live player wires each track
 * straight to its panner — so those targets are reported rather than guessed at.
 */
function applyAutomation(pattern, startBeat = 0) {
  const channels = automationChannels(pattern || {});
  if (channels.length === 0) return;

  for (const channel of channels) {
    const parsed = parseAutomationTarget(channel.target);
    if (parsed.kind === "midi") continue;

    const param = resolveLiveAutomationParam(parsed, channel);
    if (!param) {
      setStatus(`automation target not found: ${channel.target}`);
      continue;
    }

    for (const point of channel.points) {
      timelineIds.push(Tone.Transport.schedule((time) => {
        if (typeof param.setValueAtTime === "function") {
          param.setValueAtTime(point.value, time);
        } else {
          param.value = point.value;
        }
      }, beatsToTicks(startBeat + point.time)));
    }
  }
}

function resolveLiveAutomationParam(parsed, channel) {
  if (parsed.kind === "tempo") return Tone.Transport.bpm;
  if (parsed.kind !== "track") return null;

  const label = parsed.node || channel.trackId;
  const synth = trackSynths.get(label);
  if (synth && synth[parsed.param]) return synth[parsed.param];

  const panner = trackPanners.get(label);
  if (panner && panner[parsed.param]) return panner[parsed.param];

  return null;
}

async function applyPattern(pattern, mode) {
  const token = ++applyToken;

  if (pattern && typeof pattern.tempo === "number") {
    Tone.Transport.bpm.value = pattern.tempo;
  }
  applyTempoMap(pattern);
  applyTimeSignatureMap(pattern);

  // Cheap diff: if the JSON is byte-identical to the last applied pattern,
  // don't tear down the running loop.
  const sig = JSON.stringify(pattern);
  if (sig === lastPatternSig && audioStarted && session.flattenedNotes.length) {
    return;
  }
  lastPatternSig = sig;

  // Build any new synths into staging and let their samples download. The
  // currently-playing loop keeps using its existing synths during the wait,
  // so users hear the old pattern repeat for an extra loop or two rather
  // than the new pattern starting with silent notes.
  setStatus("loading…");
  await prepareStaging(pattern.tracks || []);

  // A newer applyPattern may have arrived while we were loading; in that
  // case the newer call already disposed our staging, so just bail.
  if (token !== applyToken) return;

  const haveActiveLoop = audioStarted && session.flattenedNotes.length > 0;
  const swapNow = !haveActiveLoop || mode === "immediate";

  if (swapNow) {
    promoteStaging();
    session.setPattern(pattern, true);
    syncTrackPans();
    if (audioStarted) restartScheduling();
    setStatus(audioStarted ? "playing" : "ready (click to enable audio)");
    return;
  }

  // Panners survive synth rebuilds, so sync pans against whatever's already
  // in session — even before the new pattern swaps in.
  syncTrackPans();

  pendingPattern = pattern;
  if (mode === "next-bar") {
    pendingMode = "next-bar";
    scheduleBarSwap();
  } else {
    // Default: take effect at the end of the current loop.
    pendingMode = "next-loop";
  }
  setStatus(`queued (${pendingMode})`);
}

async function enableAudio() {
  if (audioStarted) return;
  await Tone.start();
  audioStarted = true;
  Tone.Transport.start();
  setStatus("playing");
  if (enableAudioBtn) enableAudioBtn.style.display = "none";
  if (session.flattenedNotes.length) restartScheduling();
}

// --- Web MIDI ---
async function enableMidi(preferredOutputName) {
  if (!navigator.requestMIDIAccess) {
    console.warn("Web MIDI not supported in this browser");
    return null;
  }
  if (!midiAccess) {
    midiAccess = await navigator.requestMIDIAccess({ sysex: false });
  }
  const outputs = Array.from(midiAccess.outputs.values());
  const previousOutput = midiOutput;
  if (preferredOutputName) {
    midiOutput =
      outputs.find((o) => o.name === preferredOutputName) || outputs[0] || null;
  } else if (!midiOutput) {
    midiOutput = outputs[0] || null;
  }
  if (midiOutput !== previousOutput) {
    // The new device has its own program/pan state; drop our cached view so
    // the next note re-asserts both.
    channelPrograms.clear();
    channelPans.clear();
  }
  return {
    selected: midiOutput ? midiOutput.name : null,
    outputs: outputs.map((o) => o.name)
  };
}

// --- Message handling ---
window.addEventListener("message", async (event) => {
  const data = event.data || {};
  switch (data.type) {
    case "update":
      applyPattern(data.pattern, data.mode || "next-loop");
      break;
    case "start":
      await enableAudio();
      Tone.Transport.start();
      setStatus("playing");
      break;
    case "stop":
      Tone.Transport.pause();
      setStatus("stopped");
      break;
    case "resume":
      if (!audioStarted) {
        await enableAudio();
      } else {
        Tone.Transport.start();
      }
      setStatus("playing");
      break;
    case "reset":
      Tone.Transport.stop();
      Tone.Transport.position = 0;
      eventsPlayed = 0;
      if (playedEl) playedEl.textContent = 0;
      if (positionEl) positionEl.textContent = 0;
      currentIteration = 0;
      if (audioStarted) {
        Tone.Transport.start();
        restartScheduling();
      }
      break;
    case "setTempo":
      if (typeof data.tempo === "number") {
        Tone.Transport.bpm.value = data.tempo;
      }
      break;
    case "enableMidi": {
      const info = await enableMidi(data.output);
      window.parent.postMessage({ type: "midi", info }, "*");
      break;
    }
    case "setMidiOutput": {
      const info = await enableMidi(data.output);
      window.parent.postMessage({ type: "midi", info }, "*");
      break;
    }
  }
});

// Browsers require a user gesture before audio can start. The button is
// the obvious affordance; a click anywhere in the iframe is the fallback.
function tryEnableAudio() {
  enableAudio().catch((err) => console.warn("enableAudio failed:", err));
}
if (enableAudioBtn) enableAudioBtn.addEventListener("click", tryEnableAudio);
document.body.addEventListener("click", tryEnableAudio);

// Ready handshake — fire immediately so parents can preload a pattern via
// `update` before the user-gesture click that enables audio. We also keep
// re-broadcasting ready every 500ms (capped at 30s) until the parent posts
// any message back: this absorbs the race where the parent installs its
// listener after our script has already loaded (e.g. an Observable cell
// that depends on the iframe cell will run after the iframe is mounted).
setStatus("ready (click to enable audio)");
function postReady() {
  try { window.parent.postMessage({ type: "ready" }, "*"); } catch (_) {}
}
postReady();
const readyTicker = setInterval(postReady, 500);
const stopReadyTicker = () => clearInterval(readyTicker);
setTimeout(stopReadyTicker, 30000);
window.addEventListener("message", stopReadyTicker, { once: true });
