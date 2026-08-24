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
