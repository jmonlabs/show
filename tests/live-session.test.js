/**
 * The live session's pattern bookkeeping — pure logic, no DOM, no Tone.
 *
 * Per-track looping (JMON spec: tracks[].loop / tracks[].loopEnd): a track
 * marked `loop` cycles on its own length under the longest track, instead of
 * playing once and waiting for the global loop to come around.
 *
 * node:test + assert. Run with: node --test tests/live-session.test.js
 */

import test from "node:test";
import assert from "node:assert/strict";

import { Session } from "../src/live/session.js";

const note = (pitch, time, duration = 1, velocity = 0.8) => ({ pitch, duration, time, velocity });

const piece = (tracks, extra = {}) => ({
  format: "jmon", version: "1.0", tempo: 120, tracks, ...extra,
});

/** Times of one track's notes, sorted, rounded past float noise. */
const timesOf = (session, label) =>
  session.flattenedNotes
    .filter((n) => n.trackLabel === label)
    .map((n) => Number(n.time.toFixed(6)))
    .sort((a, b) => a - b);

test("a short track without `loop` plays once and waits", () => {
  const session = new Session();
  session.setPattern(piece([
    { label: "bass", notes: [note(36, 0, 8), note(36, 8, 8)] },              // 4 bars
    { label: "drums", notes: [note(38, 0), note(38, 4)] },    // 2 bars' worth
  ]));

  assert.equal(session.loopDuration, 16);
  assert.deepEqual(timesOf(session, "drums"), [0, 4], "no loop flag — no tiling");
});

test("`loop: true` cycles a track on its own bar-rounded length", () => {
  const session = new Session();
  session.setPattern(piece([
    { label: "bass", notes: [note(36, 0, 8), note(36, 8, 8)] },              // 4 bars
    // Extent 7.75+0.25 = 8 → cycles every 2 bars.
    { label: "drums", loop: true, notes: [note(36, 0, 0.25), note(38, 7.75, 0.25)] },
  ]));

  assert.equal(session.loopDuration, 16, "the global loop is still the longest track");
  assert.deepEqual(
    timesOf(session, "drums"),
    [0, 7.75, 8, 15.75],
    "the 2-bar drum loop plays twice under the 4-bar bass",
  );
  assert.deepEqual(timesOf(session, "bass"), [0, 8], "non-looping tracks are untouched");
});

test("a musical-duration `loop` value sets the cycle length explicitly", () => {
  const session = new Session();
  session.setPattern(piece([
    { label: "pad", notes: [note(60, 0, 8), note(60, 8, 8)] },               // 4 bars
    { label: "hat", loop: "1:0:0", notes: [note(42, 0, 0.25)] }, // cycle every bar
  ]));

  assert.deepEqual(timesOf(session, "hat"), [0, 4, 8, 12]);
});

test("a cycle that does not divide the pattern resets at the boundary", () => {
  const session = new Session();
  session.setPattern(piece([
    { label: "pad", notes: [note(60, 0, 8)] },                // 2 bars
    { label: "clave", loop: 3, notes: [note(37, 0, 0.25)] },  // 3-beat cycle
  ]));

  assert.deepEqual(
    timesOf(session, "clave"),
    [0, 3, 6],
    "tiled inside the global loop; the next iteration restarts the phase",
  );
});

test("`loop: true` on the longest track changes nothing", () => {
  const build = (loop) => {
    const session = new Session();
    session.setPattern(piece([
      { label: "drums", ...(loop ? { loop: true } : {}), notes: [note(36, 0), note(38, 4)] },
    ]));
    return session;
  };
  const plain = build(false);
  const looped = build(true);
  assert.deepEqual(timesOf(looped, "drums"), timesOf(plain, "drums"));
  assert.equal(looped.loopDuration, plain.loopDuration);
});

// ─── sending a Session somewhere else ──────────────────────────────────────

test("a note becomes note-on and note-off bytes, chords included", async () => {
  const { noteToBytes } = await import("../src/live/sink.js");
  const single = noteToBytes({ pitch: 60, velocity: 0.8 }, 0);
  assert.deepEqual(single.on, [0x90, 60, 102], "0x90 with a velocity, on channel 0");
  assert.deepEqual(single.off, [0x80, 60, 0]);

  const chord = noteToBytes({ pitch: [60, 64, 67], velocity: 1 }, 5);
  assert.deepEqual(chord.on, [0x95, 60, 127, 0x95, 64, 127, 0x95, 67, 127],
    "a chord is three note-ons, and the channel is in the status byte");
  assert.equal(chord.on.filter((_, i) => i % 3 === 0).every((b) => (b & 0x0f) === 5), true);

  assert.equal(noteToBytes({ pitch: 60, velocity: 0 }, 0).on[2], 1,
    "velocity 0 would read as note-off, so it is floored at 1");
  assert.equal(noteToBytes({ pitch: 60, velocity: 1 }, 99).on[0] & 0x0f, 15,
    "a channel above 15 is clamped, because there are only 16");
});

test("the Web MIDI sink says why, rather than throwing something to decode", async () => {
  const { createWebMidiSink } = await import("../src/live/sink.js");

  const empty = createWebMidiSink({ access: { outputs: new Map() } });
  await assert.rejects(() => empty.open(), /no output ports/);

  const missing = createWebMidiSink({ portName: "IAC Driver Bus 2", access: {
    outputs: new Map([["a", { name: "IAC Driver Bus 1", send() {}, open() {} }]]),
  } });
  await assert.rejects(() => missing.open(), /no port named.*IAC Driver Bus 1/s,
    "and it says what there is");

  const beforeOpen = createWebMidiSink({ access: { outputs: new Map() } });
  assert.throws(() => beforeOpen.noteOn({ pitch: 60 }), /before open/);
});

test("the sink sends the bytes it was given", async () => {
  const { createWebMidiSink } = await import("../src/live/sink.js");
  const sent = [];
  const port = { name: "IAC Driver Bus 1", open() {}, send: (bytes) => sent.push([...bytes]) };
  const sink = createWebMidiSink({ portName: "IAC Driver Bus 1", access: { outputs: new Map([[1, port]]) } });
  await sink.open();
  assert.equal(sink.name, "IAC Driver Bus 1");
  sink.noteOn({ pitch: 62, velocity: 0.5 });
  sink.noteOff({ pitch: 62, velocity: 0.5 });
  assert.deepEqual(sent[0], [0x90, 62, 64]);
  assert.deepEqual(sent[1], [0x80, 62, 0]);
});

test("a Session plays into any sink, on a clock the caller owns", async () => {
  const { Session, playSessionTo } = await import("../src/index.js");
  const { createWebMidiSink: unused } = { createWebMidiSink: null };
  void unused;

  const session = new Session();
  session.setPattern({
    format: "jmon", version: "1.0", tempo: 120,
    tracks: [{ label: "L", notes: [
      { pitch: 60, duration: 1, time: 0, velocity: 0.8 },
      { pitch: 64, duration: 1, time: 1, velocity: 0.8 },
    ] }],
  });

  const on = [];
  const off = [];
  let opened = 0;
  const sink = {
    open: () => { opened++; },
    noteOn: (n) => on.push(n.pitch),
    noteOff: (n) => off.push(n.pitch),
  };

  // A clock we move by hand, so the whole thing is testable with no audio.
  let now = 0;
  const transport = playSessionTo(session, sink, { clock: () => now, lookahead: 0.5 });

  await transport.start();
  assert.equal(opened, 1, "the sink is opened once");

  now = 0;
  transport.tick();
  assert.deepEqual(on, [60], "the note at beat 0, scheduled a window early");

  now = 0.5;
  transport.tick();
  assert.deepEqual(on, [60], "and not twice while it is still held");

  now = 1.2;
  transport.tick();
  assert.deepEqual(on, [60, 64], "the note at beat 1");
  assert.deepEqual(off, [60], "and the first has been released");

  transport.stop();
  assert.deepEqual(off, [60, 64], "stopping releases everything still held");
  assert.equal(transport.pending(), 0);
});
