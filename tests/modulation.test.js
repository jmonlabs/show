/**
 * Vibrato and tremolo ease in and out by their depth instead of switching
 * their wet signal, which clicked at every note's start and end.
 *
 * node:test + assert. Run with: node --test tests/modulation.test.js
 */

import test from "node:test";
import assert from "node:assert/strict";
import { FALL, RISE, modulationOff, modulationOn, prepareModulation } from "../src/audio/modulation.js";

/** A Tone-shaped param that records what is scheduled on it. */
const param = () => {
  const events = [];
  return {
    value: 0.5,
    events,
    setValueAtTime(v, t) { events.push(["set", v, t]); },
    linearRampToValueAtTime(v, t) { events.push(["ramp", v, t]); },
    cancelScheduledValues(t) { events.push(["cancel", t]); },
    getValueAtTime() { return 0; },
  };
};
const effect = () => ({ wet: { value: 0 }, depth: param(), frequency: param() });

test("the effect is fully wet, with no depth until a note asks for one", () => {
  const e = effect();
  prepareModulation(e);
  assert.equal(e.wet.value, 1);
  assert.equal(e.depth.value, 0);
});

test("a note's vibrato rises to its depth, and falls back to 0 when it ends", () => {
  const e = effect();
  modulationOn(e, 10, { frequency: 5.5, depth: 0.2 });
  assert.deepEqual(e.frequency.events, [["set", 5.5, 10]]);
  assert.deepEqual(e.depth.events, [["cancel", 10], ["set", 0, 10], ["ramp", 0.2, 10 + RISE]]);
  modulationOff(e, 12);
  assert.deepEqual(e.depth.events.slice(3), [["cancel", 12], ["set", 0, 12], ["ramp", 0, 12 + FALL]]);
});
