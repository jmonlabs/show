/**
 * The offline player, driven against a recording Tone.js.
 *
 * `src/` had no automated coverage because it needs a browser and an
 * audio library. It needs very little of either: `document.createElement`,
 * `document.head`, `requestAnimationFrame`, and a Tone-shaped object. Stubbing
 * those runs the player's real logic and lets the interesting layer be
 * asserted — what it schedules, when, on which node.
 *
 * This tests the library's decisions, not Tone's behaviour.
 *
 * node:test + assert. Run with: node --test tests/player.test.js
 */

import test from "node:test";
import assert from "node:assert/strict";

import { playAndRecord, installFakeBrowser, createFakeTone, collectHandlers } from "./helpers/fake-browser.mjs";
import io from "./helpers/io.mjs";

const note = (pitch, time, duration = 1, velocity = 0.8) => ({ pitch, duration, time, velocity });

const piece = (tracks, extra = {}) => ({
  format: "jmon", version: "1.0", tempo: 120, tracks, ...extra,
});

/** Scheduled times, sorted, rounded past float noise. */
const times = (record) =>
  record.scheduled.map((e) => Number(Number(e.time).toFixed(6))).sort((a, b) => a - b);

/* --- construction -------------------------------------------------------- */

test("the player rejects what it cannot play", async () => {
  const restore = installFakeBrowser();
  try {
    const { Tone } = createFakeTone();
    globalThis.Tone = Tone;
    const { createPlayer } = await import("../src/player.js");

    assert.throws(() => createPlayer(null, { Tone, io }), /Invalid piece/);
    assert.throws(() => createPlayer("nope", { Tone, io }), /Invalid piece/);
    assert.throws(() => createPlayer({ tracks: "not an array" }, { Tone, io }), /must be an array/);
  } finally {
    restore();
  }
});

test("a bare array of pitches is accepted as a piece", async () => {
  const { record } = await playAndRecord([60, 62, 64]);
  assert.equal(record.scheduled.length, 3, "one event per pitch");
});

/* --- lifecycle ------------------------------------------------------------ */

test("the returned element exposes a way to tear the player down", async () => {
  // Dispose has to run against the same fake browser the player was built
  // with, so this cannot go through playAndRecord — it restores the globals
  // as soon as play() resolves, before a caller gets a chance to dispose.
  const restore = installFakeBrowser();
  try {
    const { Tone, record } = createFakeTone();
    globalThis.Tone = Tone;

    const { createPlayer } = await import("../src/player.js");
    const ui = createPlayer(
      piece([{ label: "lead", notes: [note(60, 0), note(64, 1)] }]),
      { Tone, io },
    );

    const handlers = collectHandlers(ui);
    const play = handlers.find((h) => typeof h.click === "function");
    await play.click();

    assert.equal(typeof ui.stop, "function");
    assert.equal(typeof ui.dispose, "function");
    assert.ok(record.nodes.length > 0, "playing should have built at least one audio node");

    ui.dispose();

    assert.ok(record.transport.stops > 0, "dispose() should stop the shared transport");
    assert.equal(record.disposed.length, record.nodes.length,
      "dispose() should dispose every node it built");
  } finally {
    restore();
  }
});

/* --- scheduling ---------------------------------------------------------- */

test("notes are scheduled at their beat positions converted to seconds", async () => {
  // 120 BPM: one beat is half a second.
  const { record } = await playAndRecord(
    piece([{ label: "lead", notes: [note(60, 0), note(64, 1), note(67, 2)] }]),
  );

  assert.deepEqual(times(record), [0, 0.5, 1]);
});

test("the tempo governs the conversion", async () => {
  const { record } = await playAndRecord(
    piece([{ label: "lead", notes: [note(60, 0), note(64, 2)] }], { tempo: 60 }),
  );

  // 60 BPM: one beat is a full second, so beat 2 is at 2s.
  assert.deepEqual(times(record), [0, 2]);
});

test("the transport takes the piece's tempo", async () => {
  const { record, Tone } = await playAndRecord(
    piece([{ label: "lead", notes: [note(60, 0)] }], { tempo: 144 }),
  );
  assert.equal(Tone.Transport.bpm.value, 144);
  assert.ok(record.transport.starts > 0, "the transport should have been started");
});

test("every track is scheduled, not just the first", async () => {
  const { record } = await playAndRecord(piece([
    { label: "lead", notes: [note(60, 0), note(64, 1)] },
    { label: "bass", notes: [note(36, 0), note(38, 1), note(40, 2)] },
  ]));

  assert.equal(record.scheduled.length, 5);
});

test("rests are not scheduled", async () => {
  const { record } = await playAndRecord(piece([{
    label: "lead",
    notes: [note(60, 0), { pitch: null, duration: 1, time: 1 }, note(64, 2)],
  }]));

  assert.equal(record.scheduled.length, 2, "a rest is silence, not an event");
});

/* --- tempo maps ---------------------------------------------------------- */

test("a tempoMap moves the notes that follow it", async () => {
  const { record } = await playAndRecord(piece(
    [{ label: "lead", notes: [note(60, 0), note(62, 2), note(64, 4), note(65, 6)] }],
    { tempoMap: [{ time: 0, tempo: 120 }, { time: 4, tempo: 60 }] },
  ));

  // Beats 0, 2, 4 at 120 BPM → 0s, 1s, 2s. Beat 6 is two beats into the
  // 60 BPM section, so 2s + 2s = 4s rather than the 3s a flat rate gives.
  const scheduled = times(record);
  assert.ok(scheduled.includes(0));
  assert.ok(scheduled.includes(1));
  assert.ok(scheduled.includes(2));
  assert.ok(scheduled.includes(4), `expected a 4s event, got ${scheduled.join(", ")}`);
  assert.ok(!scheduled.includes(3), "the flat-rate position should not appear");
});

test("without a tempoMap the schedule is unchanged", async () => {
  const notes = [note(60, 0), note(62, 1), note(64, 2), note(65, 3)];
  const flat = await playAndRecord(piece([{ label: "lead", notes }]));
  const mapped = await playAndRecord(piece([{ label: "lead", notes }], {
    tempoMap: [{ time: 0, tempo: 120 }],
  }));

  assert.deepEqual(times(mapped.record), times(flat.record));
});

/* --- synths -------------------------------------------------------------- */


test("an explicit synth type is honoured", async () => {
  const { record } = await playAndRecord(piece([
    { label: "pad", synth: { type: "FMSynth", options: { detune: 3 } }, notes: [note(60, 0)] },
  ]));

  const built = record.nodes.find((n) => n.type === "FMSynth");
  assert.ok(built, `FMSynth not built; got ${record.nodes.map((n) => n.type).join(", ")}`);
  assert.equal(built.options?.detune, 3, "constructor options should be passed through");
});

test("a customPreset resolves to its type and options", async () => {
  const { record } = await playAndRecord(piece(
    [{ label: "lead", synth: "warmPad", notes: [note(60, 0)] }],
    { customPresets: [{ id: "warmPad", type: "MonoSynth", options: { detune: 7 } }] },
  ));

  const built = record.nodes.find((n) => n.type === "MonoSynth");
  assert.ok(built, "the preset's type should have been constructed");
  assert.equal(built.options?.detune, 7);
});

test("inline options layer over a referenced preset", async () => {
  const { record } = await playAndRecord(piece(
    [{ label: "lead", synth: { preset: "warmPad", options: { detune: 1 } }, notes: [note(60, 0)] }],
    { customPresets: [{ id: "warmPad", type: "MonoSynth", options: { detune: 7, portamento: 0.2 } }] },
  ));

  const built = record.nodes.find((n) => n.type === "MonoSynth");
  assert.equal(built.options?.detune, 1, "the inline value should win");
  assert.equal(built.options?.portamento, 0.2, "the preset's other options should survive");
});

/* --- audio graph --------------------------------------------------------- */

test("audioGraph nodes are constructed", async () => {
  const { record } = await playAndRecord(piece(
    [{ label: "lead", notes: [note(60, 0)] }],
    {
      audioGraph: [
        { id: "reverb", type: "Reverb", options: { decay: 2 } },
        { id: "out", type: "Destination" },
      ],
    },
  ));

  const reverb = record.nodes.find((n) => n.type === "Reverb");
  assert.ok(reverb, "the reverb should have been built");
  assert.equal(reverb.options?.decay, 2);
});

/* --- automation ---------------------------------------------------------- */

test("automation targeting an audioGraph node reaches its parameter", async () => {
  const { record } = await playAndRecord(piece(
    [{ label: "lead", notes: [note(60, 0), note(62, 4)] }],
    {
      audioGraph: [{ id: "reverb", type: "Reverb", options: {} }],
      automation: {
        global: [{
          id: "wet", target: "reverb.wet",
          anchorPoints: [{ time: 0, value: 0 }, { time: 4, value: 1 }],
        }],
      },
    },
  ));

  // Two anchor points become two scheduled events on top of the two notes.
  assert.equal(record.scheduled.length, 4, "automation points should be scheduled");

  for (const event of record.scheduled) event.callback(0);
  const wetWrites = record.params.filter((p) => p.param === "Reverb.wet");
  assert.ok(wetWrites.length >= 2, `expected writes to Reverb.wet, got ${wetWrites.length}`);
  assert.equal(wetWrites.at(-1).value, 1, "the curve should end at its last anchor");
});

test("a midi.cc channel drives nothing without a hint, and something with one", async () => {
  const base = {
    audioGraph: [{ id: "filter", type: "Filter", options: {} }],
    automation: {
      global: [{
        id: "cc1", target: "midi.cc1",
        anchorPoints: [{ time: 0, value: 0 }, { time: 2, value: 1 }],
      }],
    },
  };
  const tracks = [{ label: "lead", notes: [note(60, 0)] }];

  const unhinted = await playAndRecord(piece(tracks, base));
  assert.equal(unhinted.record.scheduled.length, 1, "only the note — the CC has no target");

  const hinted = await playAndRecord(piece(tracks, {
    ...base,
    converterHints: { tone: { cc1: { target: "filter", parameter: "frequency", range: [200, 2000] } } },
  }));
  assert.equal(hinted.record.scheduled.length, 3, "the note plus two automation points");

  for (const event of hinted.record.scheduled) event.callback(0);
  const writes = hinted.record.params.filter((p) => p.param === "Filter.frequency");
  assert.ok(writes.length >= 2);
  assert.equal(writes.at(-1).value, 2000, "value 1 should scale to the top of the range");
});

/* --- time signatures ----------------------------------------------------- */

test("the transport takes the piece's time signature", async () => {
  const { Tone } = await playAndRecord(piece(
    [{ label: "lead", notes: [note(60, 0)] }],
    { timeSignature: "7/8" },
  ));
  assert.deepEqual(Tone.Transport.timeSignature, [7, 8]);
});

/* --- the returned UI ----------------------------------------------------- */

test("the player returns a DOM element with controls attached", async () => {
  const { ui } = await playAndRecord(piece([{ label: "lead", notes: [note(60, 0)] }]));
  assert.ok(ui, "createPlayer should return an element");
  assert.ok(ui.children.length > 0, "the player should have built some UI");
});

/* --- glissando ----------------------------------------------------------- */

/** Play a slide with `detune` removed from the named synth types. */
async function slideWith(trackSpec, withoutDetune = [], extra = {}) {
  const restore = installFakeBrowser();
  try {
    const { Tone, record } = createFakeTone();
    for (const type of withoutDetune) {
      const Base = Tone[type];
      Tone[type] = class extends Base {
        constructor(options) { super(options); delete this.detune; }
      };
    }
    globalThis.Tone = Tone;

    const { createPlayer } = await import(`../src/player.js?${withoutDetune.join("-")}`);
    const ui = createPlayer(piece([{
      ...trackSpec,
      notes: [{ ...note(60, 0, 2), articulations: [{ type: "glissando", target: 67 }] }],
    }], extra), { Tone, io });

    const { collectHandlers } = await import("./helpers/fake-browser.mjs");
    const play = collectHandlers(ui).find((h) => typeof h.click === "function");
    await play.click();
    for (const event of record.scheduled) event.callback(0);

    return record;
  } finally {
    restore();
  }
}

test("a glissando is performed as a detune ramp in cents", async () => {
  const record = await slideWith({ label: "lead", synth: { type: "MonoSynth" } });
  const ramps = record.params.filter((p) => p.param.endsWith(".detune"));

  assert.ok(ramps.length >= 3, "expected a start value, a ramp and a reset");
  assert.equal(ramps[0].value, 0, "the slide starts at the written pitch");
  // 60 -> 67 is a perfect fifth: seven semitones, 700 cents.
  const arrival = Math.max(...ramps.map((r) => r.value));
  assert.ok(Math.abs(arrival - 700) < 1, `arrived at ${arrival} cents`);
});

test("the detune returns to its baseline once the slide is over", async () => {
  // Without this the whole track stays transposed by whatever the last slide
  // travelled: a glissando of a fifth leaves every following note a fifth
  // sharp, on the same voice.
  const record = await slideWith({ label: "lead", synth: { type: "MonoSynth" } });
  const ramps = record.params.filter((p) => p.param.endsWith(".detune"));

  assert.equal(ramps.at(-1).value, 0, "the signal ends where it started");
  const arrivalAt = ramps.findLast((r) => Math.abs(r.value - 700) < 1).time;
  assert.ok(ramps.at(-1).time > arrivalAt, "the reset comes after the arrival");
});

test("the slide runs on the track's own synth when it has a detune", async () => {
  const record = await slideWith({ label: "lead", synth: { type: "MonoSynth" } });

  assert.deepEqual(record.nodes.map((n) => n.type), ["MonoSynth"],
    "no extra instrument should be needed");
  assert.ok(record.params.some((p) => p.param === "MonoSynth.detune"));
});



test("a PolySynth slides on a glide voice too", async () => {
  // PolySynth sets options through set(), not through a Signal, so it takes
  // the same path as the Sampler.
  const record = await slideWith({ label: "lead" });
  const types = record.nodes.map((n) => n.type);

  assert.ok(types.includes("PolySynth"), "the track's own synth is still built");
  assert.ok(types.includes("Synth"), "a glide voice carries the slide");

  const ramps = record.params.filter((p) => p.param === "Synth.detune");
  const arrival = Math.max(...ramps.map((r) => r.value));
  assert.ok(Math.abs(arrival - 700) < 1, `arrived at ${arrival} cents`);
});

test("the glide voice goes through the track's effects, not straight out", async () => {
  // A slide that bypassed the chain would jump out of the mix — dry, and at
  // the wrong level — for exactly the notes that slide.
  const record = await slideWith(
    { label: "lead", synth: { type: "PolySynth" } },
    [],
    { audioGraph: [{ id: "reverb", type: "Reverb", options: { decay: 2 } }] },
  );

  const glideTargets = record.connections.filter((c) => c.from === "Synth").map((c) => c.to);
  const synthTargets = record.connections.filter((c) => c.from === "PolySynth").map((c) => c.to);

  assert.ok(glideTargets.length > 0, "the glide voice should be connected to something");
  assert.deepEqual(
    glideTargets, synthTargets,
    "the glide voice should land where the track synth lands",
  );
  assert.ok(glideTargets.includes("Reverb"), `routed to ${glideTargets.join(", ")}`);
});

test("a descending slide ramps downwards", async () => {
  const restore = installFakeBrowser();
  try {
    const { Tone, record } = createFakeTone();
    globalThis.Tone = Tone;
    const { createPlayer } = await import("../src/player.js?down");
    const ui = createPlayer(piece([{
      label: "lead", synth: { type: "MonoSynth" },
      notes: [{ ...note(72, 0, 2), articulations: [{ type: "glissando", target: 60 }] }],
    }]), { Tone, io });

    const { collectHandlers } = await import("./helpers/fake-browser.mjs");
    await collectHandlers(ui).find((h) => typeof h.click === "function").click();
    for (const event of record.scheduled) event.callback(0);

    const ramps = record.params.filter((p) => p.param.endsWith(".detune"));
    const arrival = Math.min(...ramps.map((r) => r.value));
    assert.ok(Math.abs(arrival + 1200) < 1, `arrived at ${arrival} cents`);
    assert.equal(ramps.at(-1).value, 0, "and comes back to centre");
  } finally {
    restore();
  }
});

test("a note without a slide sets no detune ramp", async () => {
  const { record } = await playAndRecord(piece([
    { label: "lead", synth: { type: "MonoSynth" }, notes: [note(60, 0), note(64, 1)] },
  ]));
  for (const event of record.scheduled) event.callback(0);

  assert.equal(
    record.params.filter((p) => p.param.endsWith(".detune")).length, 0,
    "plain notes should leave detune alone",
  );
});






test("a preset naming a Tone class still resolves to that class", async () => {
  // The GM branch must not swallow the string case.
  const { record } = await playAndRecord(piece(
    [{ label: "lead", synth: "warm", notes: [note(60, 0)] }],
    { customPresets: [{ id: "warm", type: "MonoSynth", options: { detune: 7 } }] },
  ));

  assert.equal(record.nodes.find((n) => n.type === "MonoSynth")?.options?.detune, 7);
});











/* --- the sampled-instrument provider -------------------------------------- */

/**
 * Sampled instruments live in `jmon/sound`, injected the way Tone.js is. What
 * the player owes it is a correct call at the right moment; what the call
 * *does* is tested in that package, against real buffers.
 */
async function playWithSound(comp, { withSound = true } = {}) {
  const restore = installFakeBrowser();
  try {
    const { Tone, record } = createFakeTone();
    globalThis.Tone = Tone;
    const { createRecordingSound } = await import("./helpers/fake-browser.mjs");
    const sound = withSound ? createRecordingSound(record, Tone) : null;

    const { createPlayer } = await import(`../src/player.js?p=${Math.abs(JSON.stringify(comp).length)}${withSound}`);
    const ui = createPlayer(comp, { Tone, sound, io });

    const { collectHandlers } = await import("./helpers/fake-browser.mjs");
    await collectHandlers(ui).find((h) => typeof h.click === "function").click();
    for (const event of record.scheduled) event.callback(0);
    return record;
  } finally {
    restore();
  }
}

test("a General MIDI program is handed to the provider, not built here", async () => {
  const record = await playWithSound(piece([
    { label: "violin", synth: 40, notes: [note(67, 0)] },
  ]));

  assert.deepEqual(record.sound.created, [40]);
  assert.ok(record.nodes.some((n) => n.type === "Sampler"), "and its node is used");
});

test("the sampling options travel with the spec", async () => {
  // The player must not interpret `strategy` — how densely to sample is the
  // provider's decision, so the spec goes through whole.
  const record = await playWithSound(piece([
    { label: "violin", synth: { gm: 40, strategy: "complete" }, notes: [note(67, 0)] },
  ]));

  assert.deepEqual(record.sound.created, [{ gm: 40, strategy: "complete" }]);
});

test("a preset is expanded before the provider sees it", async () => {
  // The provider knows nothing about customPresets — that is JMON's business,
  // so what arrives is already a plain spec.
  const record = await playWithSound(piece(
    [{ label: "strings", synth: "violin", notes: [note(67, 0)] }],
    { customPresets: [{ id: "violin", type: 40, strategy: "complete" }] },
  ));

  assert.equal(record.sound.created.length, 1);
  assert.equal(record.sound.created[0].gm, 40);
  assert.equal(record.sound.created[0].strategy, "complete");
});

test("prepare is called once, with every track's resolved spec", async () => {
  const record = await playWithSound(piece(
    [
      { label: "violin", synth: "fiddle", notes: [note(67, 0)] },
      { label: "lead", synth: { type: "MonoSynth" }, notes: [note(60, 0)] },
    ],
    { customPresets: [{ id: "fiddle", type: 40 }] },
  ));

  assert.equal(record.sound.prepared.length, 1, "one call, not one per track");
  const specs = record.sound.prepared[0];
  assert.equal(specs.length, 2, "including the tracks it cannot help with");
  assert.equal(specs[0].gm, 40, "and presets already expanded");
});

test("a glissando on a sampled instrument goes through bendVoices", async () => {
  const record = await playWithSound(piece([{
    label: "violin", synth: 40,
    notes: [{ ...note(60, 0, 2), articulations: [{ type: "glissando", target: 67 }] }],
  }]));

  assert.equal(record.sound.bent.length, 1);
  const [call] = record.sound.bent;
  assert.equal(call.midi, 60, "the written pitch keys the sounding voices");
  const arrival = Math.max(...call.anchors.map((a) => a.value));
  assert.ok(Math.abs(arrival - 700) < 1, `anchors should be in cents, got ${arrival}`);
});

test("a held note goes through holdVoices, in seconds", async () => {
  const record = await playWithSound(piece(
    [{ label: "strings", synth: 48, notes: [note(60, 0, 8)] }],
    { tempo: 60 },
  ));

  assert.equal(record.sound.held.length, 1);
  assert.equal(record.sound.held[0].midi, 60);
  assert.equal(record.sound.held[0].seconds, 8, "8 beats at 60 BPM is 8 seconds");
});

test("loopSustain: false keeps the player from asking at all", async () => {
  const record = await playWithSound(piece(
    [{ label: "strings", synth: { gm: 48, loopSustain: false }, notes: [note(60, 0, 8)] }],
    { tempo: 60 },
  ));

  assert.equal(record.sound.held.length, 0);
});

test("without a provider, a GM track still plays — on a synth", async () => {
  // The piece must not fail to load. It loses the instrument, not the
  // notes, and says so once rather than per track.
  const record = await playWithSound(
    piece([
      { label: "violin", synth: 40, notes: [note(67, 0)] },
      { label: "cello", synth: 42, notes: [note(48, 0)] },
    ]),
    { withSound: false },
  );

  assert.equal(record.scheduled.length, 2, "both notes are still scheduled");
  assert.ok(!record.nodes.some((n) => n.type === "Sampler"), "no sampler without a provider");
  assert.ok(record.nodes.some((n) => n.type === "PolySynth"), "a synth stands in");
});

test("the provider decides what it recognises, not the player", async () => {
  // `prepare` is asked unconditionally and `create` is offered every spec,
  // because only the provider knows which of them are its business. Skipping
  // the network probe for a synth-only piece is its call, not the player's —
  // which is why nothing here second-guesses the spec.
  const record = await playWithSound(piece([
    { label: "lead", synth: { type: "MonoSynth" }, notes: [note(60, 0)] },
  ]));

  assert.deepEqual(record.sound.created, [], "it declined, so the player built the synth");
  assert.equal(record.sound.prepared.length, 1, "but it was still asked");
  assert.ok(record.nodes.some((n) => n.type === "MonoSynth"));
});
