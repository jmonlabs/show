/**
 * A note sink: somewhere a Session's notes can be heard.
 *
 * The point of `Session` is that it is sink-agnostic — it holds a pattern,
 * swaps one in without interrupting, and answers "what is sounding at this
 * musical time". `play` is Web Audio; this is the same musical logic aimed at
 * something that is not the browser's own synthesiser, which is how you get
 * notes into a DAW and out through a sampled instrument.
 *
 * A sink is three methods, deliberately:
 *
 *     open()                 called once
 *     noteOn({pitch, ...})   one note, at a time the sink chooses
 *     noteOff({pitch, ...})  the same note
 *
 * Web MIDI is the built-in one, because the browser has the API and the
 * operating system has a loopback port and the DAW has an input. Anything else
 * — OSC, a virtual port, a test double — is the same three calls.
 */

/**
 * Turn a JMON note into the three raw MIDI messages that sound it, on
 * `channel`.
 *
 * Returned rather than sent, so the packing can be tested without a browser and
 * so a sink can send them on a timestamp of its own.
 *
 * @param {Object} note
 * @param {number} [channel=0] - 0-15
 * @returns {{on:number[], off:number[]}} status bytes with their data
 */
export function noteToBytes(note, channel = 0) {
  const ch = Math.max(0, Math.min(15, channel | 0));
  const velocity = Math.max(1, Math.min(127, Math.round((note.velocity ?? 0.8) * 127)));
  const pitches = Array.isArray(note.pitch) ? note.pitch : [note.pitch];
  const on = [];
  const off = [];
  for (const p of pitches) {
    if (typeof p !== "number") continue;
    // 0x90 is note-on with velocity > 0, which is also note-off in disguise
    // and is what every synth expects.
    on.push(0x90 | ch, p & 0x7f, velocity);
    off.push(0x80 | ch, p & 0x7f, 0);
  }
  return { on, off };
}

/**
 * A sink over a Web MIDI output.
 *
 * `requestMIDIAccess` needs a secure context and a user gesture, and it is not
 * in Safari at all, so `open()` reports the failure in words rather than
 * throwing something the caller has to decode.
 *
 * @param {Object} [options]
 * @param {string} [options.portName] - which output; the first if omitted
 * @param {number} [options.channel=0]
 * @param {Object} [options.access] - a `MIDIAccess`, for tests
 * @returns {{open:Function, noteOn:Function, noteOff:Function, close:Function, name:string|null}}
 */
export function createWebMidiSink({ portName, channel = 0, access } = {}) {
  let port = null;
  let name = null;

  return {
    get name() { return name; },

    async open() {
      if (port) return port;
      if (!access && typeof navigator === "undefined") {
        throw new Error("web midi: no navigator here; pass `access` in a headless caller");
      }
      if (!access && typeof navigator.requestMIDIAccess !== "function") {
        throw new Error(
          "web midi: this browser has no requestMIDIAccess. " +
          "It is Chrome, Edge, Opera and Firefox 108+ on a secure context — not Safari."
        );
      }
      const midi = access ?? await navigator.requestMIDIAccess();
      const outputs = [...midi.outputs.values()];
      if (outputs.length === 0) {
        throw new Error(
          "web midi: no output ports. On macOS, create one in Audio MIDI Setup — " +
          "IAC Driver Bus 1 is the usual loopback to a DAW."
        );
      }
      port = portName ? outputs.find((p) => p.name === portName) : outputs[0];
      if (!port) {
        throw new Error(
          `web midi: no port named "${portName}". Available: ${outputs.map((p) => p.name).join(", ")}`
        );
      }
      if (typeof port.open !== "function") await port.open();
      name = port.name;
      return port;
    },

    noteOn(note) {
      if (!port) throw new Error("web midi: noteOn before open()");
      port.send(new Uint8Array(noteToBytes(note, channel).on));
    },

    noteOff(note) {
      if (!port) throw new Error("web midi: noteOff before open()");
      port.send(new Uint8Array(noteToBytes(note, channel).off));
    },

    close() {
      if (port && typeof port.close === "function") port.close();
      port = null;
    },
  };
}

/**
 * Play a Session into a sink, on a clock.
 *
 * Notes are scheduled a little ahead of the clock rather than at the instant
 * they fall due, because a sink's timing is not the caller's: a browser's Web
 * MIDI queue and a DAW's input buffer both want a moment's warning. `lookahead`
 * is that moment, in beats.
 *
 * The clock is a function of wall time in beats, so it can be an AudioContext
 * clock, `performance.now()` converted, or a test's own counter. Nothing here
 * knows about audio.
 *
 * @param {Object} session - a `Session`
 * @param {Object} sink - `{ open, noteOn, noteOff }`
 * @param {Object} [options]
 * @param {number} [options.lookahead=0.25] - beats of warning
 * @param {Function} [options.clock] - `() => beats`, required
 * @param {number} [options.channel=0] - MIDI channel per note index
 * @returns {{start:Function, stop:Function, tick:Function, pending:Function}}
 */
export function playSessionTo(session, sink, { lookahead = 0.25, clock, channel = 0 } = {}) {
  if (typeof clock !== "function") throw new Error("playSessionTo: `clock` is required");
  if (!sink || typeof sink.noteOn !== "function") throw new Error("playSessionTo: a sink is required");

  // Notes are indexed so a channel can follow the note, and so a stopped
  // transport can release exactly what is still held.
  const held = new Map();
  let scheduled = 0; // beats already looked at
  let running = false;
  let nextChannel = channel;

  const channelFor = () => {
    // One channel per note, and it wraps: a sink that is not MPE will hear the
    // channel as a colour rather than a detune, which is still better than
    // everything on one line.
    const ch = nextChannel;
    nextChannel = (nextChannel + 1) % 16;
    return ch;
  };

  const tick = () => {
    if (!running) return;
    const now = clock();
    const horizon = now + lookahead;
    // Walk the pattern a window at a time, in half-beat steps, so a note is
    // caught whichever way the clock lands.
    const step = 0.5;
    for (let t = scheduled; t < horizon; t += step) {
      const notes = session.getNotesAtTime(t);
      for (const note of notes) {
        if (held.has(note)) continue;
        const ch = channelFor();
        held.set(note, { channel: ch, at: t });
        sink.noteOn({ ...note, channel: ch });
      }
    }
    // Anything whose time has passed and is not held again gets released.
    for (const [note, info] of held) {
      const length = note.duration ?? 0.5;
      if (now > info.at + length) {
        sink.noteOff({ ...note, channel: info.channel });
        held.delete(note);
      }
    }
    scheduled = Math.max(scheduled, horizon);
  };

  return {
    start() {
      if (running) return undefined;
      running = true;
      scheduled = clock();
      if (typeof sink.open !== "function") return undefined;
      // A sink's `open` may be synchronous — a test double, or a sink with
      // nothing to wait for — so this does not assume a thenable.
      return Promise.resolve(sink.open()).then(() => undefined);
    },
    stop() {
      running = false;
      for (const [note, info] of held) sink.noteOff({ ...note, channel: info.channel });
      held.clear();
      scheduled = clock();
    },
    tick,
    /** How many notes are currently held down. */
    pending: () => held.size,
  };
}
