/**
 * The audioGraph's Channel: a panned stereo Channel becomes a balance, so a
 * stereo signal is not folded towards mono.
 *
 * node:test + assert. Run with: node --test tests/channel.test.js
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createChannel, createGraphNode } from "../src/audio/channel.js";

/** A Tone-shaped namespace that records connections. */
function fakeTone() {
  const links = [];
  class Node {
    constructor(name, value) { this.name = name; this.value = value; this.disposed = false; }
    connect(to, out = 0, into = 0) { links.push([this.name, to.name, out, into]); return this; }
    disconnect(to) { const i = links.findIndex(([a, b]) => a === this.name && b === to.name); if (i >= 0) links.splice(i, 1); return this; }
    dispose() { this.disposed = true; }
  }
  let gains = 0;
  const Tone = {
    Channel: class extends Node {
      constructor(options) {
        super("channel");
        this.options = options;
        this._solo = new Node("solo");
        this._panVol = new Node("panVol");
        this._solo.connect(this._panVol);
      }
    },
    Split: class extends Node { constructor() { super("split"); } },
    Merge: class extends Node { constructor() { super("merge"); } },
    Gain: class extends Node { constructor(value) { super(["left", "right", "upmix"][gains++] ?? "gain", value); } },
    Reverb: class extends Node { constructor(options) { super("reverb"); this.options = options; } },
  };
  return { Tone, links };
}

test("a stereo Channel with a pan turns the far side down, without folding it across", () => {
  const { Tone, links } = fakeTone();
  const channel = createChannel(Tone, { pan: 0.3, volume: -2, channelCount: 2 });
  assert.equal(channel.options.pan, 0, "Tone's own panner stays centred");
  assert.equal(channel.options.volume, -2);
  assert.deepEqual(links, [
    ["solo", "upmix", 0, 0],
    ["upmix", "split", 0, 0],
    ["split", "left", 0, 0],
    ["split", "right", 1, 0],
    ["left", "merge", 0, 0],
    ["right", "merge", 0, 1],
    ["merge", "panVol", 0, 0],
  ]);
});

test("the balance follows the side of the pan", () => {
  const { Tone } = fakeTone();
  const made = [];
  const Gain = Tone.Gain;
  Tone.Gain = class extends Gain { constructor(value) { super(value); made.push(value); } };
  createChannel(Tone, { pan: -0.4, channelCount: 2 });
  assert.deepEqual(made.map((v) => Number(v.toFixed(6))), [1, 0.6, 1]);
});

test("a mono input is made stereo before the split, so it reaches both sides", () => {
  const { Tone } = fakeTone();
  const made = [];
  const Gain = Tone.Gain;
  Tone.Gain = class extends Gain { constructor(value) { super(value); made.push(this); } };
  createChannel(Tone, { pan: 0.9, channelCount: 2 });
  const upmix = made.find((g) => g.name === "upmix");
  assert.deepEqual([upmix.channelCount, upmix.channelCountMode, upmix.channelInterpretation], [2, "explicit", "speakers"]);
});

test("pan 0, or a Channel that is not stereo, is Tone's Channel unchanged", () => {
  const { Tone, links } = fakeTone();
  assert.equal(createChannel(Tone, { pan: 0, channelCount: 2 }).options.pan, 0);
  assert.equal(createChannel(Tone, { pan: 0.5 }).options.pan, 0.5);
  assert.deepEqual(links, [["solo", "panVol", 0, 0], ["solo", "panVol", 0, 0]]);
});

test("disposing the Channel disposes the balance too", () => {
  const { Tone } = fakeTone();
  const channel = createChannel(Tone, { pan: 0.2, channelCount: 2 });
  channel.dispose();
  assert.ok(channel.disposed);
});

test("other types are built as Tone builds them", () => {
  const { Tone } = fakeTone();
  const reverb = createGraphNode(Tone, "Reverb", { decay: 4 });
  assert.equal(reverb.name, "reverb");
  assert.deepEqual(reverb.options, { decay: 4 });
});
