import test from "node:test";
import assert from "node:assert/strict";

// What a track's control changes turn into.
//
// The player cannot be imported in a test — it loads Tone.js and a browser's Web
// MIDI at module scope — so the decision of what to send lives here, where it can
// be checked, and the player only schedules it. That is the same arrangement the
// pitch-curve helpers use.
//
// The two things this has to get right, both of which were silent failures: a
// step that lands after its note leaves the plugin on the old cutoff for the first
// note of every sweep, and a track with no channel drops its controllers entirely
// with nothing to say so.
import { ccStepsFor, ccToBytes } from "../src/live/sink.js";

const hex = (bytes) => bytes.map((b) => b.toString(16).padStart(2, "0")).join(" ");

test("a track's steps become one send per step, at its own beat", () => {
  const steps = ccStepsFor({
    label: "lead", midiChannel: 0,
    cc: [
      { controller: 74, value: 0, time: 0 },
      { controller: 74, value: 0.5, time: 2 },
      { controller: 74, value: 1, time: 4 },
    ],
  });
  assert.equal(steps.length, 3);
  assert.deepEqual(steps.map((s) => s.time), [0, 2, 4], "beats from the top of the loop");
  assert.deepEqual(steps.map((s) => hex(s.bytes)), ["b0 4a 00", "b0 4a 40", "b0 4a 7f"]);
});

test("the channel is the track's, and `channel` is accepted for it", () => {
  assert.equal(hex(ccStepsFor({ midiChannel: 5, cc: [{ controller: 1, value: 0, time: 0 }] })[0].bytes), "b5 01 00");
  assert.equal(hex(ccStepsFor({ channel: 3, cc: [{ controller: 1, value: 0, time: 0 }] })[0].bytes), "b3 01 00");
});

test("a track with no channel reports it instead of dropping the sweep", () => {
  // Its notes go to a Tone synth, and on the audio path a control change means
  // nothing on its own. Silently doing nothing here is the failure this exists to
  // remove, so it comes back as an error the caller can show.
  const steps = ccStepsFor({ label: "pad", cc: [{ controller: 74, value: 0.5, time: 0 }] });
  assert.equal(steps.length, 1, "one message, not one per step");
  assert.ok(steps[0].error, "and it is an error");
  assert.match(steps[0].error, /pad has cc but no midiChannel/);
  assert.equal(steps[0].bytes, undefined, "and no bytes to send");
});

test("one bad entry does not cost the sweep around it", () => {
  // A list of four where the second is unusable should still move the parameter
  // three times. Dropping the whole track would read as a plugin that ignores CC.
  const steps = ccStepsFor({
    label: "lead", midiChannel: 0,
    cc: [
      { controller: 74, value: 0, time: 0 },
      { controller: 75, time: 1 },   // no value
      { controller: 74, value: 0.5, time: 2 },
      null,
      { controller: 74, value: 1, time: 4 },
    ],
  });
  const sent = steps.filter((s) => s.bytes);
  const errors = steps.filter((s) => s.error);
  assert.equal(sent.length, 3, "the three good ones still go");
  assert.equal(errors.length, 2, "and the two bad ones are reported");
  assert.match(errors[0].error, /lead: .*controller and a value/);
  // And the good ones keep their own beats, so the sweep is not shifted by the
  // hole where a bad entry was.
  assert.deepEqual(sent.map((s) => s.time), [0, 2, 4]);
});

test("a missing time is the top of the loop, not nowhere", () => {
  // NaN would become a tick no scheduler can place, and the step would be
  // silently lost; 0 puts it with the first note, which is what an author who
  // left the time out means.
  const steps = ccStepsFor({ midiChannel: 0, cc: [{ controller: 74, value: 0.5 }] });
  assert.equal(steps[0].time, 0);
  assert.ok(steps[0].bytes, "and it is still sent");
});

test("a track with no cc contributes nothing and complains about nothing", () => {
  assert.deepEqual(ccStepsFor({ label: "bass", midiChannel: 0 }), []);
  assert.deepEqual(ccStepsFor({ label: "bass", cc: [] }), []);
  assert.deepEqual(ccStepsFor({ label: "bass", cc: "not a list" }), []);
  assert.deepEqual(ccStepsFor(undefined), []);
  // A synth-only track is the common case and must stay silent about it.
  assert.deepEqual(ccStepsFor({ label: "pad", synth: "PolySynth" }), []);
});

test("every step is a complete controller message", () => {
  // Three bytes, status in the B0 range, and the value inside 7 bits. A short or
  // mistyped array here is a byte stream the plugin reads as something else.
  for (const step of ccStepsFor({
    midiChannel: 0,
    cc: [
      { controller: 0, value: 0, time: 0 },
      { controller: 127, value: 1, time: 1 },
      { controller: 74, value: 0.5, time: 2 },
    ],
  })) {
    assert.equal(step.bytes.length, 3, "three bytes");
    assert.equal(step.bytes[0] & 0xf0, 0xb0, "control change on the channel");
    assert.ok(step.bytes[1] >= 0 && step.bytes[1] <= 127, "controller in range");
    assert.ok(step.bytes[2] >= 0 && step.bytes[2] <= 127, "value in range");
  }
});

test("ccStepsFor and ccToBytes cannot disagree", () => {
  // The player sends what ccStepsFor returns; the sink encodes with ccToBytes.
  // They share the encoder, and this is the assertion that they still do.
  const change = { controller: 74, value: 0.4, channel: 2 };
  assert.deepEqual(
    ccStepsFor({ midiChannel: 2, cc: [change] })[0].bytes,
    ccToBytes(change),
  );
});
