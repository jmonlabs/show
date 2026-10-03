/**
 * Shared synth/routing factory used by the live player (`music-player.js`)
 * and the offline renderer (`wav.js`).
 *
 * Both paths must produce identical synth choices and audioGraph routing,
 * otherwise pieces sound different live vs. exported. Centralizing the
 * dispatch here is the only way to keep them in sync.
 */

import { ALL_EFFECTS } from "./audio/effects.js";

/**
 * Resolve where a track's synth should connect.
 *
 * Priority:
 *   1. `track.output` — explicit per-track bus reference
 *   2. `audioGraph` node with `default: true`
 *   3. First effect node in `audioGraph` not targeted by anything (legacy)
 *   4. `fallbackTarget`
 */
export function resolveConnectTarget(track, audioGraph, graphNodes, fallbackTarget) {
  if (track && track.output) {
    if (graphNodes && graphNodes[track.output]) return graphNodes[track.output];
    console.warn(`[track ${track.label || ""}] output "${track.output}" not found in audioGraph`);
  }
  if (audioGraph && audioGraph.length > 0 && graphNodes) {
    const defaultNode = audioGraph.find((n) => n.default === true);
    if (defaultNode && graphNodes[defaultNode.id]) return graphNodes[defaultNode.id];

    const targetedIds = new Set(audioGraph.map((n) => n.target).filter(Boolean));
    const effectEntry = audioGraph.find(
      (n) => ALL_EFFECTS.includes(n.type) && !targetedIds.has(n.id),
    );
    if (effectEntry && graphNodes[effectEntry.id]) return graphNodes[effectEntry.id];
  }
  return fallbackTarget;
}

/**
 * Create a Tone.js synth/sampler for a track.
 *
 * @param {Object} track — JMON track object (uses `synth` field)
 * @param {Object} ToneLib — Tone.js library namespace
 * @param {Object|null} [sharedSynth] — pre-existing node to reuse (e.g., from
 *   audioGraph via `synthRef`); when provided and `track.synth` is unset,
 *   it is returned as the track's synth without creating a new instance.
 *
 * @returns {{synth: Object, isLoadable: boolean, isShared: boolean}}
 *   - `synth` — the Tone.js node ready to be connected to a target
 *   - `isLoadable` — true if the synth uses samples; caller should await
 *     `synth.loaded` before scheduling notes
 *   - `isShared` — true if the synth came from `sharedSynth`; caller should
 *     not disconnect or reconfigure its routing
 */
/**
 * Resolve a track's `synth` field against a piece's `customPresets`.
 *
 * A preset is `{ id, type, options }`. A track referencing it by id — as a
 * bare string or as `{ preset: "id" }` — gets the preset's `{ type, options }`
 * in its place, with any inline options layered on top so a track can borrow
 * a preset and still adjust one value.
 *
 * Pure and exported so it can be tested without Tone.js.
 *
 * @param {*} synthSpec - The track's `synth` field
 * @param {Array<{id: string, type: string, options: Object}>} [presets]
 * @returns {*} The spec with any preset reference expanded
 */
/**
 * Expand a preset into the spec it stands for.
 *
 * A preset's `type` is a Tone class name, or a General MIDI program number —
 * the same two things a track's `synth` accepts, so there is one rule to
 * learn rather than one per place. A GM preset may also carry `strategy`,
 * `noteRange` and `baseUrl`, which is how a named instrument asks for a
 * sample density other than the default.
 */
function expandPreset(preset, extra = {}, inlineOptions = undefined) {
  const options = { ...preset.options, ...inlineOptions };

  if (typeof preset.type === "number") {
    return {
      gm: preset.type,
      ...(preset.strategy !== undefined && { strategy: preset.strategy }),
      ...(preset.noteRange !== undefined && { noteRange: preset.noteRange }),
      ...(preset.baseUrl !== undefined && { baseUrl: preset.baseUrl }),
      ...extra,
      options,
    };
  }

  return { type: preset.type, ...extra, options };
}

export function resolveSynthPreset(synthSpec, presets) {
  if (!Array.isArray(presets) || presets.length === 0) return synthSpec;

  const find = (id) => presets.find((preset) => preset && preset.id === id);

  if (typeof synthSpec === "string") {
    const preset = find(synthSpec);
    return preset ? expandPreset(preset) : synthSpec;
  }

  if (synthSpec && typeof synthSpec === "object" && typeof synthSpec.preset === "string") {
    const preset = find(synthSpec.preset);
    if (!preset) {
      console.warn(`Unknown preset "${synthSpec.preset}". Falling back to the inline spec.`);
      const { preset: _ignored, ...rest } = synthSpec;
      return rest;
    }
    const { preset: _dropped, options: inline, ...rest } = synthSpec;
    return expandPreset(preset, rest, inline);
  }

  return synthSpec;
}

/**
 * Build the instrument a track asks for.
 *
 * Tone's own classes are built here. Sampled instruments — a General MIDI
 * program, a drum kit — are not this package's business: they are asked of
 * the `sound` provider, injected the way Tone.js and Verovio are. Without one,
 * a track asking for General MIDI falls back to a `PolySynth`, which is
 * audible and in time but not the instrument that was written.
 *
 * @param {Object} track - A JMON track
 * @param {Object} ToneLib - The Tone.js namespace
 * @param {Object} [sharedSynth] - An audioGraph instrument this track rides on
 * @param {Array} [presets] - piece.customPresets
 * @param {Object} [sound] - The sampled-instrument provider, or null
 * @returns {{synth: Object, isLoadable: boolean, isShared: boolean}}
 */
export function createTrackSynth(track, ToneLib, sharedSynth = null, presets = null, sound = null) {
  if (sharedSynth && (!track || track.synth === undefined)) {
    return { synth: sharedSynth, isLoadable: false, isShared: true };
  }

  const synthSpec = resolveSynthPreset(track && track.synth, presets);

  const sampled = sound?.create?.(synthSpec, ToneLib);
  if (sampled?.node) {
    return { synth: sampled.node, isLoadable: sampled.isLoadable !== false, isShared: false };
  }
  if (wantsSamples(synthSpec) && !sampled) {
    warnOnce(
      "This piece asks for sampled instruments. Pass a provider — " +
      "jm.play(piece, { Tone, sound }) — or tracks fall back to a synth. " +
      "See https://github.com/jmonlabs/sound",
    );
    return { synth: new ToneLib.PolySynth(), isLoadable: false, isShared: false };
  }

  if (typeof synthSpec === "string") {
    try {
      return { synth: new ToneLib[synthSpec](), isLoadable: false, isShared: false };
    } catch {
      return { synth: new ToneLib.PolySynth(), isLoadable: false, isShared: false };
    }
  }

  if (typeof synthSpec === "object" && synthSpec !== null) {
    const synthType = synthSpec.type || "PolySynth";
    const opts = synthSpec.options || {};
    try {
      if (synthType === "Sampler") {
        return { synth: new ToneLib.Sampler(opts), isLoadable: true, isShared: false };
      }
      return { synth: new ToneLib[synthType](opts), isLoadable: false, isShared: false };
    } catch {
      return { synth: new ToneLib.PolySynth(), isLoadable: false, isShared: false };
    }
  }

  return { synth: new ToneLib.PolySynth(), isLoadable: false, isShared: false };
}

/**
 * Whether a spec names a sampled instrument, so the missing provider can be
 * reported rather than silently swapped for a synth.
 *
 * Deliberately loose: the provider decides what it recognises. This only has
 * to spot the shapes Tone cannot build on its own — a bare program number, a
 * `{ gm }` object, the drums (`"drums"`, `{ drums }`), and a `kit:` reference.
 */
function wantsSamples(spec) {
  if (typeof spec === "number") return true;
  if (typeof spec === "string") return spec === "drums" || spec === "drumkit" || /^(drum)?kit:/i.test(spec);
  return !!(spec && typeof spec === "object"
    && (typeof spec.gm === "number" || typeof spec.program === "number" || typeof spec.drums === "number"
        || typeof spec.kit === "string" || typeof spec.drumkit === "string"));
}

let warned = new Set();
/** One warning per message, so a 12-track piece does not print twelve. */
function warnOnce(message) {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(message);
}

/**
 * True when a Tone.js node exposes a schedulable `detune` signal (cents).
 * Mono synths (Synth, MonoSynth, AMSynth, FMSynth) do; PolySynth and
 * Sampler do not — pitch curves on those need a dedicated glide voice.
 */
export function hasDetuneParam(synth) {
  return !!(synth && synth.detune && typeof synth.detune.setValueAtTime === "function");
}

/**
 * Create a dedicated monophonic voice for pitch curves (glissando,
 * portamento, bend, pitch envelopes) on tracks whose synth has no `detune`
 * signal (PolySynth, Sampler). Uses Tone.Synth — the same voice PolySynth
 * uses by default — with the track's nested voice options when present, so
 * the glide voice matches the track timbre as closely as possible. The
 * caller is responsible for connecting it to the track's effect chain.
 *
 * @param {Object} track — JMON track object
 * @param {Object} ToneLib — Tone.js library namespace
 * @returns {Object|null} a Tone.Synth, or null if construction failed
 */
export function createGlideVoice(track, ToneLib) {
  const spec = track && track.synth;
  // PolySynth object specs nest voice options under options.options
  const voiceOptions =
    (spec && typeof spec === "object" && spec.options && spec.options.options) || undefined;
  try {
    return new ToneLib.Synth(voiceOptions);
  } catch {
    try {
      return new ToneLib.Synth();
    } catch {
      return null;
    }
  }
}

/**
 * Let a sampled instrument's provider work on a note it has just started,
 * then release the note.
 *
 * Call it right after `triggerAttack`. Tone's Sampler takes a voice off its
 * list of sounding notes as soon as a release is *scheduled*, so with
 * `triggerAttackRelease` the provider found nothing: long notes were never
 * held past the end of their recording and loudness curves never applied.
 * Here the provider holds the voice (`holdVoices`) and shapes it
 * (`shapeVoices`) while it is still listed, and the note is released only if
 * the shaping did not already let it go — a later stop would cancel the curve.
 *
 * `triggerAttack` is given the note's duration as a fourth argument: Tone's
 * instruments ignore it, and an SFZ instrument plays a short note with its
 * staccato recording.
 *
 * @param {Object} synth — the track's Sampler
 * @param {Object} sound — the sampled-instrument provider
 * @param {Object} note
 * @param {string|number} note.name — what was passed to triggerAttack
 * @param {number} note.midi — the MIDI number the Sampler keys the voice by
 * @param {number} note.time — start, in seconds
 * @param {number} note.seconds — duration, in seconds
 * @param {number} note.velocity
 * @param {boolean} note.loopSustain — whether the track lets the sustain loop
 * @param {Array|null} note.loudness — from amplitudeAnchors
 */
export function finishNote(synth, sound, { name, midi, time, seconds, velocity, loopSustain, loudness }) {
  if (loopSustain) sound?.holdVoices?.(synth, midi, time, seconds);
  const shaped = loudness ? sound?.shapeVoices?.(synth, midi, time, loudness, { seconds, velocity }) : false;
  if (!shaped) synth.triggerRelease(name, time + seconds);
}

/**
 * Send one controller move (see io's controllerEvents) to a track's
 * instrument: a control change, a pitch bend or channel pressure. Only an
 * instrument that takes them — a SoundFont or SFZ instrument — does anything
 * with it; Tone's own synths have no controllers, and a lane meant for one of
 * their parameters goes through `converterHints` instead.
 *
 * @param {Object} synth
 * @param {{type: string, controller?: number, value: number}} move - value
 *   0..1, or -1..1 for a pitch bend
 * @param {number} time - seconds
 */
export function sendControllerMove(synth, move, time) {
  if (move.type === "cc") synth.controllerChange?.(move.controller, move.value, time);
  else if (move.type === "pitchBend") synth.pitchBend?.(move.value, time);
  else if (move.type === "aftertouch") synth.channelPressure?.(move.value, time);
}

/**
 * A note's loudness curve, from its compiled modulations, rebased to seconds
 * from the note's start — the form `sound.shapeVoices` takes. `null` when the
 * note has none, which is almost always.
 *
 * @param {Array} noteMods — the compiled modulations of one note
 * @param {number} secondsPerBeat
 * @returns {Array<{time:number,value:number}>|null} value as a multiple of
 *   the note's velocity
 */
export function amplitudeAnchors(noteMods, secondsPerBeat) {
  const envelope = (noteMods || []).find(
    (m) => m.type === "amplitude" && m.subtype === "envelope"
      && Array.isArray(m.anchors) && m.anchors.length > 0,
  );
  if (!envelope) return null;
  return envelope.anchors.map((a) => ({
    time: (a.time - envelope.start) * secondsPerBeat,
    value: a.value,
  }));
}

/**
 * Schedule a compiled pitch curve on a `detune` signal (cents), then reset
 * it to the baseline shortly after the curve ends so later notes on the
 * same voice start clean.
 *
 * @param {Object} detuneParam — Tone.js Signal/AudioParam in cents
 * @param {number} startTime — absolute time in seconds of the note start
 * @param {Array<{time:number,value:number}>} anchors — time in seconds
 *   relative to `startTime`, value in cents relative to the written pitch
 * @param {number} [baseCents=0] — baseline detune (e.g. tuning * 100)
 * @param {number} [resetDelay=0.05] — seconds after the last anchor at
 *   which the signal returns to `baseCents`
 */
export function applyPitchAnchors(detuneParam, startTime, anchors, baseCents = 0, resetDelay = 0.05) {
  if (!detuneParam || !Array.isArray(anchors) || anchors.length === 0) return;
  if (typeof detuneParam.cancelScheduledValues === "function") {
    detuneParam.cancelScheduledValues(startTime);
  }
  detuneParam.setValueAtTime(baseCents + anchors[0].value, startTime + Math.max(0, anchors[0].time));
  for (let k = 1; k < anchors.length; k++) {
    detuneParam.linearRampToValueAtTime(baseCents + anchors[k].value, startTime + anchors[k].time);
  }
  const last = anchors[anchors.length - 1];
  detuneParam.setValueAtTime(baseCents, startTime + last.time + resetDelay);
}
