/**
 * Pre-built audioGraph fragments for mastering chains.
 *
 * Each entry is a plain array of audioGraph nodes, wired in mastering
 * order (EQ -> Saturation -> ... -> Limiter), with the last node targeting
 * `"destination"`. To splice into a piece, use vanilla JS:
 *
 * ```js
 * piece.audioGraph = [
 *   ...piece.audioGraph.map(n =>
 *     n.target === "destination" ? { ...n, target: "master_lowshelf" } : n
 *   ),
 *   ...jm.audioGraph.master.lush,
 * ];
 * ```
 *
 * The first node's id is `"master_lowshelf"` for any preset that has an EQ
 * stage; otherwise it's whatever the first non-null stage produces. Inspect
 * `master.lush[0].id` if unsure.
 *
 * To use a different intensity than the default (1.0), `.map()` over the
 * fragment and scale the wet amounts:
 *
 * ```js
 * const subtle = jm.audioGraph.master.lush.map(n =>
 *   n.options?.wet !== undefined
 *     ? { ...n, options: { ...n.options, wet: n.options.wet * 0.5 } }
 *     : n
 * );
 * ```
 */

import { PRESETS, PRESET_NAMES } from "./presets.js";

function buildChain(p, intensity = 1) {
  const stages = [];
  const push = (id, type, options) => stages.push({ id, type, options });

  if (p.eq && p.eq.lowShelf) {
    push("master_lowshelf", "Filter", {
      type: "lowshelf",
      frequency: 250,
      gain: p.eq.lowShelf * intensity,
    });
  }
  if (p.eq && p.eq.highShelf) {
    push("master_highshelf", "Filter", {
      type: "highshelf",
      frequency: 8000,
      gain: p.eq.highShelf * intensity,
    });
  }
  if (p.saturation) {
    push("master_saturate", "Distortion", {
      distortion: p.saturation.drive,
      wet: p.saturation.wet * intensity,
      oversample: "2x",
    });
  }
  if (p.bitcrusher) {
    push("master_bitcrush", "BitCrusher", {
      bits: p.bitcrusher.bits,
      wet: p.bitcrusher.wet * intensity,
    });
  }
  if (p.chorus) {
    push("master_chorus", "Chorus", {
      frequency: p.chorus.frequency,
      depth: p.chorus.depth,
      wet: p.chorus.wet * intensity,
    });
  }
  if (p.compressor) {
    push("master_comp", "Compressor", {
      threshold: p.compressor.threshold,
      ratio: p.compressor.ratio,
      attack: 0.05,
      release: 0.25,
      knee: 6,
    });
  }
  if (p.stereo) {
    push("master_wide", "StereoWidener", { width: p.stereo.width });
  }
  if (p.reverb) {
    push("master_reverb", "Reverb", {
      decay: p.reverb.decay,
      wet: p.reverb.wet * intensity,
      preDelay: 0.03,
    });
  }
  if (p.delay) {
    push("master_delay", "FeedbackDelay", {
      delayTime: p.delay.time,
      feedback: p.delay.feedback,
      wet: p.delay.wet * intensity,
    });
  }
  if (p.limiter) {
    push("master_limit", "Limiter", { threshold: p.limiter.threshold });
  }

  // Wire targets: each stage points to the next; the last targets destination.
  for (let i = 0; i < stages.length; i++) {
    stages[i].target = i < stages.length - 1 ? stages[i + 1].id : "destination";
  }
  return stages;
}

/**
 * Pre-built mastering chains, indexed by preset name.
 * Built at intensity=1.0; use `.map()` to scale.
 */
export const master = Object.fromEntries(
  PRESET_NAMES.map((name) => [name, buildChain(PRESETS[name], 1)])
);

export const masterPresetNames = PRESET_NAMES;
