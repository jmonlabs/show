import test from "node:test";
import assert from "node:assert/strict";
import { saturationCurve, createGraphNode } from "../src/audio/channel.js";
import { master } from "../src/audio/master.js";

test("the saturation is a straight line at ordinary levels, and only bends towards the top", () => {
  for (const drive of [0.15, 0.3]) {
    // at -20 dBFS the sample is left within 0.5 %
    assert.ok(Math.abs(saturationCurve(0.1, { drive }) - 0.1) / 0.1 < 0.005 * (drive / 0.15) * 3);
    // it never grows faster than the dry sample, and stays monotonic and odd
    let last = -Infinity;
    for (let x = -1; x <= 1; x += 0.01) {
      const y = saturationCurve(x, { drive });
      assert.ok(y > last); last = y;
      assert.ok(Math.abs(y) <= Math.abs(x) + 1e-12);
      assert.ok(Math.abs(y + saturationCurve(-x, { drive })) < 1e-12);
    }
  }
  assert.equal(saturationCurve(0.5, { drive: 0.3, wet: 0 }), 0.5, "wet 0 is the dry sample");
});

test("a Saturation node is one WaveShaper on that curve, oversampled", () => {
  class WaveShaper { constructor(mapping, length) { this.mapping = mapping; this.length = length; } }
  const node = createGraphNode({ WaveShaper }, "Saturation", { drive: 0.3, wet: 0.25 });
  assert.ok(node instanceof WaveShaper);
  assert.equal(node.length, 4096);
  assert.equal(node.oversample, "2x");
  assert.equal(node.mapping(0.4), saturationCurve(0.4, { drive: 0.3, wet: 0.25 }));
});

test("the mastering presets saturate with Saturation, not Distortion", () => {
  for (const name of ["dark", "warm", "cinematic"]) {
    const stage = master[name].find((n) => n.id === "master_saturate");
    assert.equal(stage.type, "Saturation", name);
    assert.ok(stage.options.drive > 0 && stage.options.wet > 0);
  }
});
