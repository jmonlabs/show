/**
 * Tone.js pitch-curve scheduling helpers, shared by the live player
 * (player.js) and the offline WAV renderer (wav.js):
 *
 * - hasDetuneParam: PolySynth/Sampler have no detune signal, mono synths do
 * - createGlideVoice: dedicated voice for tracks whose synth can't bend
 * - applyPitchAnchors: detune automation with cancel + post-curve reset
 *
 * Runs standalone with `node` and under `deno test`.
 */

import assert from "node:assert";
import {
  applyPitchAnchors,
  createGlideVoice,
  hasDetuneParam,
} from "../src/synth-factory.js";

function fakeDetune() {
  const calls = [];
  return {
    calls,
    cancelScheduledValues: (t) => calls.push(["cancel", t]),
    setValueAtTime: (v, t) => calls.push(["set", v, t]),
    linearRampToValueAtTime: (v, t) => calls.push(["ramp", v, t]),
  };
}

// hasDetuneParam distinguishes bendable synths
{
  assert.strictEqual(hasDetuneParam(null), false);
  assert.strictEqual(hasDetuneParam({}), false); // PolySynth/Sampler shape
  assert.strictEqual(hasDetuneParam({ detune: {} }), false);
  assert.strictEqual(hasDetuneParam({ detune: fakeDetune() }), true);
  console.log("✓ hasDetuneParam detects a schedulable detune signal");
}

// applyPitchAnchors schedules cancel, set, ramps, and a reset to baseline
{
  const detune = fakeDetune();
  // Glissando 60→64 over 1s with +25 cents microtuning baseline
  applyPitchAnchors(detune, 10, [
    { time: 0, value: 0 },
    { time: 1, value: 400 },
  ], 25);

  assert.deepStrictEqual(detune.calls, [
    ["cancel", 10],
    ["set", 25, 10],        // baseline + first anchor, at note start
    ["ramp", 425, 11],      // baseline + 400 cents at note end
    ["set", 25, 11.05],     // reset to baseline so later notes start clean
  ]);
  console.log("✓ applyPitchAnchors ramps detune and resets after the curve");
}

// Multi-anchor envelopes ramp through every point
{
  const detune = fakeDetune();
  applyPitchAnchors(detune, 0, [
    { time: 0, value: 0 },
    { time: 0.5, value: 300 },
    { time: 1, value: 100 },
  ]);
  assert.deepStrictEqual(detune.calls, [
    ["cancel", 0],
    ["set", 0, 0],
    ["ramp", 300, 0.5],
    ["ramp", 100, 1],
    ["set", 0, 1.05],
  ]);
  console.log("✓ multi-anchor envelopes ramp through every point");
}

// Empty/invalid input is a no-op
{
  const detune = fakeDetune();
  applyPitchAnchors(detune, 0, []);
  applyPitchAnchors(detune, 0, undefined);
  applyPitchAnchors(null, 0, [{ time: 0, value: 0 }]);
  assert.deepStrictEqual(detune.calls, []);
  console.log("✓ applyPitchAnchors ignores empty curves");
}

// createGlideVoice mirrors PolySynth voice options
{
  class FakeSynth {
    constructor(options) {
      this.options = options;
      this.detune = fakeDetune();
    }
  }
  const ToneLib = { Synth: FakeSynth };

  const voice = createGlideVoice(
    { synth: { type: "PolySynth", options: { options: { oscillator: { type: "square" } } } } },
    ToneLib,
  );
  assert.ok(voice instanceof FakeSynth);
  assert.deepStrictEqual(voice.options, { oscillator: { type: "square" } });

  const plain = createGlideVoice({}, ToneLib);
  assert.ok(plain instanceof FakeSynth);
  assert.strictEqual(plain.options, undefined);
  console.log("✓ createGlideVoice builds a Synth with the track's voice options");
}

console.log("\nAll player pitch-curve helper tests passed");
