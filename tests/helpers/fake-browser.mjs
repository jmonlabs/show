/**
 * A minimal browser and a recording Tone.js, so `src/` can be tested
 * without a real one.
 *
 * The point is not to test Tone — it is to test what the player *asks* Tone to
 * do. Every scheduled event, every node constructed and every parameter set is
 * recorded, which is exactly the layer that carries the library's own decisions:
 * when a note is placed, how a tempo map shifts it, which synth a track ends up
 * with, whether automation reaches a parameter.
 *
 * `player.js` touches very little of the DOM — `document.createElement`,
 * `document.head` and `requestAnimationFrame` — so the stub stays small enough
 * to trust.
 */

import io from "./io.mjs";

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function midiToNoteName(midi) {
  const rounded = Math.round(Number(midi));
  return `${NOTE_NAMES[((rounded % 12) + 12) % 12]}${Math.floor(rounded / 12) - 1}`;
}

function noteNameToMidi(value) {
  if (typeof value === "number") return value;
  const match = String(value).match(/^([A-G][#b]?)(-?\d+)$/);
  if (!match) return Number(value) || 60;
  const [, name, octave] = match;
  const index = NOTE_NAMES.indexOf(name.replace("b", "#"));
  return (index < 0 ? 0 : index) + (Number(octave) + 1) * 12;
}

/** A DOM node with just enough surface for the player's UI building. */
function element(tag = "div") {
  return {
    tagName: tag,
    style: {},
    dataset: {},
    children: [],
    handlers: {},
    textContent: "",
    innerHTML: "",
    className: "",
    appendChild(child) { this.children.push(child); return child; },
    append(...kids) { this.children.push(...kids); },
    addEventListener(event, fn) { this.handlers[event] = fn; },
    removeEventListener(event) { delete this.handlers[event]; },
    setAttribute(name, value) { this[name] = value; },
    getAttribute(name) { return this[name]; },
    remove() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}

/** A Tone `Param`/`Signal` that records what was written to it and when. */
class RecordingParam {
  constructor(value = 0, log = null, name = "") {
    this.value = value;
    this._log = log;
    this._name = name;
  }
  setValueAtTime(value, time) {
    this.value = value;
    this._log?.push({ param: this._name, value, time, kind: "set" });
    return this;
  }
  linearRampToValueAtTime(value, time) {
    this.value = value;
    this._log?.push({ param: this._name, value, time, kind: "ramp" });
    return this;
  }
  rampTo(value) { this.value = value; return this; }
  cancelScheduledValues() { return this; }
}

/**
 * Build a fake Tone.js and the record of everything done to it.
 *
 * @returns {{Tone: Object, record: Object}}
 */

/** FluidR3's fixed sample length, which is what the real ceiling is. */
const SAMPLE_SECONDS = 3.19;

/**
 * A stand-in for Tone's ToneBufferSource, with the parts the library reaches
 * for: an automatable playbackRate, a buffer it can measure, loop points, and
 * a stop() it can reschedule.
 */
function makeBufferSource(record, shape, seconds) {
  const rate = 4000;                     // enough resolution for the analysis
  const length = Math.round(rate * seconds);
  const data = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const t = i / length;
    // A decaying sample falls to near nothing; a sustaining one does not.
    const envelope = shape === "decaying" ? Math.exp(-4 * t) : 0.6 + 0.4 * Math.cos(t * 6);
    data[i] = Math.sin(i * 0.05) * envelope;
  }

  const source = {
    buffer: {
      duration: seconds,
      length,
      numberOfChannels: 1,
      getChannelData: () => data,   // live, so an edit to it is visible here
    },
    playbackRate: new RecordingParam(1, record.params, "Sampler.playbackRate"),
    loop: false,
    loopStart: 0,
    loopEnd: 0,
    stop(time) { record.stops.push({ time }); return this; },
  };
  record.sources.push(source);
  return source;
}

export function createFakeTone() {
  const record = {
    scheduled: [],     // { time, callback }
    nodes: [],         // { type, options }
    connections: [],   // { from, to }
    sources: [],       // Sampler voices, so loop points can be asserted
    stops: [],         // { time } — explicit stops scheduled on a voice
    params: [],        // { param, value, time, kind }
    triggered: [],     // { pitch, duration, time, velocity }
    transport: { starts: 0, stops: 0 },
  };

  class Node {
    constructor(type, options) {
      record.nodes.push({ type, options });
      this.type = type;
      this.volume = new RecordingParam(0, record.params, `${type}.volume`);
      this.wet = new RecordingParam(1, record.params, `${type}.wet`);
      this.frequency = new RecordingParam(440, record.params, `${type}.frequency`);
      this.depth = new RecordingParam(0, record.params, `${type}.depth`);
      // Real Tone synths expose `detune` as a rampable Signal, which is how a
      // glissando is performed. Not every instrument has one — see the
      // glissando tests, which remove it to model that.
      this.detune = new RecordingParam(0, record.params, `${type}.detune`);
      this.loaded = Promise.resolve();
    }
    toDestination() {
      record.connections.push({ from: this.type, to: "destination" });
      return this;
    }
    connect(target) {
      record.connections.push({ from: this.type, to: target?.type ?? "destination" });
      return this;
    }
    disconnect() { return this; }
    dispose() {}
    triggerAttackRelease(pitch, duration, time, velocity) {
      record.triggered.push({ pitch, duration, time, velocity });
    }
    triggerAttack() {} triggerRelease() {}
    set() { return this; }
  }

  const named = (type) => class extends Node { constructor(options) { super(type, options); } };

  /**
   * A Sampler shaped like Tone's real one, verified against 14.8.49: it has
   * no `detune` Signal, and it keeps its sounding voices in `_activeSources`,
   * each a buffer source whose `playbackRate` is an automatable Param. That
   * pair is what lets a slide resample the instrument instead of replacing it.
   */
  class FakeSampler extends Node {
    constructor(options) {
      super("Sampler", options);
      delete this.detune;
      this._activeSources = new Map();
      // Which shape the buffers have. `decaying` models a piano, whose tail
      // has fallen to a few percent of peak; the default models a string or
      // organ, which is still sounding at the end. analyseSustain tells them
      // apart, so the tests have to be able to build both.
      this.sampleShape = options?.sampleShape || "sustaining";
      this.sampleSeconds = options?.sampleSeconds ?? SAMPLE_SECONDS;
    }
    triggerAttack(notes, time, velocity) {
      for (const note of [].concat(notes)) {
        const midi = Math.round(noteNameToMidi(note));
        const source = makeBufferSource(record, this.sampleShape, this.sampleSeconds);
        if (!this._activeSources.has(midi)) this._activeSources.set(midi, []);
        this._activeSources.get(midi).push(source);
        record.triggered.push({ pitch: note, time, velocity });
      }
      return this;
    }
    triggerAttackRelease(notes, duration, time, velocity) {
      this.triggerAttack(notes, time, velocity);
      return this;
    }
    triggerRelease() { return this; }
  }

  /** PolySynth, likewise: options are set through `set()`, not a Signal. */
  class FakePolySynth extends Node {
    constructor(options) { super("PolySynth", options); delete this.detune; }
  }

  const Transport = {
    bpm: new RecordingParam(120, record.params, "transport.bpm"),
    timeSignature: [4, 4],
    position: 0,
    seconds: 0,
    PPQ: 192,
    state: "stopped",
    schedule(callback, time) {
      record.scheduled.push({ time, callback });
      return record.scheduled.length - 1;
    },
    scheduleOnce(callback, time) { return this.schedule(callback, time); },
    clear() {}, cancel() {},
    start() { record.transport.starts++; this.state = "started"; return this; },
    stop() { record.transport.stops++; this.state = "stopped"; return this; },
    pause() { this.state = "paused"; return this; },
  };

  const Tone = {
    Transport,
    Destination: { name: "destination", volume: new RecordingParam(0) },
    getTransport: () => Transport,
    getContext: () => ({ currentTime: 0, state: "running" }),
    context: { currentTime: 0, state: "running", resume: async () => {} },
    start: async () => {},
    loaded: async () => {},
    now: () => 0,
    // Enough of Tone.Frequency for the player: note names, MIDI numbers and
    // Hz all convert between each other. A glissando needs toFrequency() to
    // work out its interval in cents.
    Frequency: (value, units) => {
      const midi = units === "midi" ? Number(value) : noteNameToMidi(value);
      return {
        toNote: () => midiToNoteName(midi),
        toMidi: () => midi,
        toFrequency: () => 440 * Math.pow(2, (midi - 69) / 12),
        valueOf: () => midi,
      };
    },
    Time: () => ({ toTicks: () => 0, toSeconds: () => 0 }),
    Panner: class extends Node {
      constructor(pan) { super("Panner", { pan }); this.pan = new RecordingParam(pan ?? 0, record.params, "Panner.pan"); }
    },
  };

  for (const type of [
    "Synth", "MonoSynth", "FMSynth", "AMSynth", "DuoSynth",
    "MembraneSynth", "MetalSynth", "PluckSynth", "NoiseSynth",
    "Reverb", "Delay", "FeedbackDelay", "PingPongDelay", "Chorus", "Phaser",
    "Tremolo", "Vibrato", "Distortion", "Chebyshev", "BitCrusher", "Filter",
    "AutoFilter", "EQ3", "Compressor", "Limiter", "Gain", "Volume",
  ]) {
    Tone[type] = named(type);
  }

  Tone.Sampler = FakeSampler;
  Tone.PolySynth = FakePolySynth;

  return { Tone, record };
}

/**
 * Install the stub globals the player expects. Returns a function that puts
 * the environment back, so suites do not leak into each other.
 */
export function installFakeBrowser() {
  const saved = {
    document: globalThis.document,
    window: globalThis.window,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    Tone: globalThis.Tone,
  };

  globalThis.document = {
    createElement: (tag) => element(tag),
    head: element("head"),
    body: element("body"),
    addEventListener() {}, removeEventListener() {},
  };
  globalThis.window = globalThis;
  globalThis.requestAnimationFrame = () => 0;
  globalThis.cancelAnimationFrame = () => {};

  return function restore() {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  };
}

/** Walk a stub element tree and collect every registered handler. */
export function collectHandlers(node, depth = 0, found = []) {
  if (!node || depth > 8) return found;
  if (node.handlers && Object.keys(node.handlers).length > 0) found.push(node.handlers);
  for (const child of node.children || []) collectHandlers(child, depth + 1, found);
  return found;
}

/**
 * Build a player and start it, returning the record of what it asked Tone for.
 * Starting is what builds the audio graph and schedules the notes — before the
 * first gesture a player has only built its UI.
 */
export async function playAndRecord(composition, options = {}) {
  const restore = installFakeBrowser();
  try {
    const { Tone, record } = createFakeTone();
    globalThis.Tone = Tone;

    const { createPlayer } = await import("../../src/player.js");
    const ui = createPlayer(composition, { Tone, io, ...options });

    const handlers = collectHandlers(ui);
    const play = handlers.find((h) => typeof h.click === "function");
    if (!play) throw new Error("no play handler found on the player UI");
    await play.click();

    return { record, ui, Tone };
  } finally {
    restore();
  }
}

/**
 * A stand-in for the `jmon/sound` provider, which records what the player
 * asked of it.
 *
 * The split it enforces is the point: **jmon/algo's job is to call the
 * contract correctly**, and that is all these tests can honestly assert.
 * Whether resampling actually bends a note, or a loop joins without a click,
 * is jmon/sound's own business and is tested there against real buffers.
 *
 * @param {Object} record - the recording from {@link createFakeTone}
 * @param {Object} [Tone] - the fake Tone, so it can build a real fake Sampler
 * @returns {Object} a provider plus `record.sound`, its call log
 */
export function createRecordingSound(record, Tone) {
  record.sound = { created: [], prepared: [], bent: [], held: [] };

  const gmProgram = (spec) => {
    if (typeof spec === "number") return spec;
    if (spec && typeof spec === "object" && typeof spec.gm === "number") return spec.gm;
    return null;
  };

  return {
    create(spec, ToneLib) {
      if (gmProgram(spec) === null) return null;
      record.sound.created.push(spec);
      const node = new (ToneLib || Tone).Sampler({ ...(spec.options || {}), spec });
      return { node, isLoadable: true };
    },
    async prepare(specs) {
      record.sound.prepared.push(specs);
      return "https://example.test/samples";
    },
    bendVoices(node, midi, time, anchors, baseCents) {
      record.sound.bent.push({ node, midi, time, anchors, baseCents });
      return true;
    },
    holdVoices(node, midi, time, seconds) {
      record.sound.held.push({ node, midi, time, seconds });
      return true;
    },
  };
}
