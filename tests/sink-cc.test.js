import test from "node:test";
import assert from "node:assert/strict";

// The sink's controller method.
//
// The sink is three calls, which is why a virtual port, an OSC endpoint and a
// test double are interchangeable to a transport. Those three are notes, and
// notes are not how a plugin is played: cutoff, mod wheel, wavetable position and
// send level are all controller changes, and MIDI CC is the one protocol every
// plugin maps. Without a way to send one, controlling a VST from here meant
// bypassing both JMON and the sink.
//
// So a fourth call, optional on the interface, because a sink that only plays
// notes has no reason to implement it.
import { ccToBytes, createWebMidiSink } from "../src/live/sink.js";

const hex = (bytes) => bytes.map((b) => b.toString(16).padStart(2, "0")).join(" ");

// A port that records what it was sent, so nothing needs a browser or a device.
function recordingPort(name = "test port") {
  const sent = [];
  return {
    sent,
    port: {
      name,
      open: async () => {},
      close: () => {},
      send: (bytes) => sent.push([...bytes]),
    },
  };
}

const sinkOver = (port, options = {}) =>
  createWebMidiSink({ access: { outputs: new Map([["id", port]]), inputs: new Map() }, ...options });

test("ccToBytes encodes a controller change", () => {
  assert.equal(hex(ccToBytes({ controller: 74, value: 0 })), "b0 4a 00");
  assert.equal(hex(ccToBytes({ controller: 74, value: 1 })), "b0 4a 7f");
  // 0.5 * 127 is 63.5, which rounds to 64 = 0x40. A controller has seven bits
  // and that is all it has, so this is exact rather than approximate.
  assert.equal(hex(ccToBytes({ controller: 74, value: 0.5 })), "b0 4a 40");
  assert.equal(hex(ccToBytes({ controller: 74, value: 0.4 })), "b0 4a 33");
});

test("ccToBytes carries the channel, and defaults it", () => {
  assert.equal(hex(ccToBytes({ controller: 7, value: 1, channel: 5 })), "b5 07 7f");
  assert.equal(hex(ccToBytes({ controller: 7, value: 1 }, 5)), "b5 07 7f");
  assert.equal(hex(ccToBytes({ controller: 7, value: 1 })), "b0 07 7f");
});

test("ccToBytes clamps rather than wrapping", () => {
  // A value over 1 that wrapped to a small number would close a filter on a
  // sweep upward, which is the opposite of what was asked for and sounds like a
  // fault in the plugin rather than in the number.
  assert.equal(ccToBytes({ controller: 74, value: 2 })[2], 127);
  assert.equal(ccToBytes({ controller: 74, value: -1 })[2], 0);
  // A channel past 15 clamps to the last one rather than wrapping to a low
  // channel, which would be a control change arriving where nobody asked for it.
  assert.equal(ccToBytes({ controller: 74, value: 0.5, channel: 200 })[0], 0xb0 | 15);
  assert.equal(ccToBytes({ controller: 74, value: 0.5, channel: -3 })[0], 0xb0 | 0);
});

test("ccToBytes refuses a change with no controller or no value", () => {
  // Writing silence instead would be worse than refusing: a filter that quietly
  // closed reads as an instrument that has stopped working.
  assert.throws(() => ccToBytes({ value: 0.5 }), /controller and a value/);
  assert.throws(() => ccToBytes({ controller: 74 }), /controller and a value/);
  assert.throws(() => ccToBytes({}), /controller and a value/);
  assert.throws(() => ccToBytes(undefined), /controller and a value/);
});

test("the sink sends a controller change on the port it opened", async () => {
  const { sent, port } = recordingPort();
  const sink = sinkOver(port);
  await sink.open();
  sink.cc({ controller: 74, value: 0.4 });
  assert.deepEqual(sent, [[0xb0, 0x4a, 0x33]]);
});

test("the sink's own channel is the default, and a per-change one overrides", async () => {
  const { sent, port } = recordingPort();
  const sink = sinkOver(port, { channel: 3 });
  await sink.open();
  sink.cc({ controller: 74, value: 1 });
  sink.cc({ controller: 74, value: 1, channel: 9 });
  assert.deepEqual(sent[0], [0xb3, 0x4a, 0x7f], "defaults to the sink's channel");
  assert.deepEqual(sent[1], [0xb9, 0x4a, 0x7f], "and an override wins");
});

test("cc before open is refused, like the note calls", () => {
  const { port } = recordingPort();
  const sink = sinkOver(port);
  assert.throws(() => sink.cc({ controller: 74, value: 0.5 }), /before open/);
});

test("cc is a step, not a span: it sends once and holds", async () => {
  // A controller is told a value and keeps it, so there is nothing to release
  // and no duration to write. Sending twice means the caller asked twice.
  const { sent, port } = recordingPort();
  const sink = sinkOver(port);
  await sink.open();
  sink.cc({ controller: 74, value: 0.25 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0][2], 32, "0.25 * 127 = 31.75 -> 32");
});
