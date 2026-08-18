/**
 * Mastering presets.
 *
 * Each preset defines a set of values for the standard mastering stages.
 * `null` means "skip this stage". `intensity` is a global multiplier
 * applied to wet amounts and EQ gains at apply time.
 *
 * Stage order is fixed by the chain builder:
 *   EQ (low-shelf, high-shelf) -> Saturation -> BitCrusher -> Chorus
 *   -> Compressor -> StereoWidener -> Reverb -> Delay -> Limiter -> destination
 */
export const PRESETS = {
  /**
   * dark — low-shelf boost, high-shelf cut, long reverb, narrow image.
   * Dark, confined. Good for drones and deep ambient.
   */
  dark: {
    eq: { lowShelf: 2, highShelf: -3 },
    saturation: { drive: 0.30, wet: 0.25 },
    bitcrusher: null,
    chorus: null,
    compressor: { threshold: -20, ratio: 3 },
    stereo: { width: 0.4 },
    reverb: { decay: 8, wet: 0.50 },
    delay: null,
    limiter: { threshold: -2 },
  },

  /**
   * light — high-shelf boost, short reverb, wide image.
   * Airy, bright. Good for solo piano and clear vocals.
   */
  light: {
    eq: { lowShelf: -1, highShelf: 2 },
    saturation: null,
    bitcrusher: null,
    chorus: null,
    compressor: { threshold: -18, ratio: 2 },
    stereo: { width: 0.8 },
    reverb: { decay: 1.5, wet: 0.30 },
    delay: null,
    limiter: { threshold: -2 },
  },

  /**
   * warm — bass-friendly EQ, soft saturation, medium reverb + delay.
   * Warm, organic. Good for acoustic ensembles.
   */
  warm: {
    eq: { lowShelf: 1.5, highShelf: -1 },
    saturation: { drive: 0.15, wet: 0.18 },
    bitcrusher: null,
    chorus: null,
    compressor: { threshold: -18, ratio: 2.5 },
    stereo: { width: 0.7 },
    reverb: { decay: 5, wet: 0.40 },
    delay: { time: "8n.", feedback: 0.22, wet: 0.16 },
    limiter: { threshold: -2 },
  },

  /**
   * cinematic — huge reverb, wide stereo, medium saturation.
   * Grandiose, film-score feel. Good for orchestral ensembles.
   */
  cinematic: {
    eq: { lowShelf: 0, highShelf: 0 },
    saturation: { drive: 0.20, wet: 0.20 },
    bitcrusher: null,
    chorus: null,
    compressor: { threshold: -16, ratio: 2.5 },
    stereo: { width: 0.9 },
    reverb: { decay: 12, wet: 0.55 },
    delay: { time: "4n.", feedback: 0.18, wet: 0.18 },
    limiter: { threshold: -1.5 },
  },

  /**
   * intimate — minimal reverb, narrow stereo, soft compression.
   * Close, dry, almost untreated. Good for intimate solo piano.
   */
  intimate: {
    eq: { lowShelf: 0, highShelf: -1 },
    saturation: null,
    bitcrusher: null,
    chorus: null,
    compressor: { threshold: -20, ratio: 2 },
    stereo: { width: 0.5 },
    reverb: { decay: 1, wet: 0.20 },
    delay: null,
    limiter: { threshold: -3 },
  },

  /**
   * broadcast — tight compression, no reverb, ceiling −1dB.
   * Radio-ready, flat, punchy.
   */
  broadcast: {
    eq: { lowShelf: 0, highShelf: 0 },
    saturation: { drive: 0.10, wet: 0.10 },
    bitcrusher: null,
    chorus: null,
    compressor: { threshold: -14, ratio: 4 },
    stereo: { width: 0.6 },
    reverb: null,
    delay: null,
    limiter: { threshold: -1 },
  },

  /**
   * vinyl — light bit-crush, sharp high cut, near-mono.
   * Analog lo-fi, vintage 33-rpm feel.
   */
  vinyl: {
    eq: { lowShelf: 0, highShelf: -3 },
    saturation: { drive: 0.20, wet: 0.25 },
    bitcrusher: { bits: 8, wet: 0.15 },
    chorus: null,
    compressor: { threshold: -16, ratio: 3 },
    stereo: { width: 0.4 },
    reverb: { decay: 1.5, wet: 0.15 },
    delay: null,
    limiter: { threshold: -2 },
  },

  /**
   * lush — chorus, smiley EQ, ping-pong delay, wide stereo.
   * Modern pop, dream-pop, shoegaze.
   */
  lush: {
    eq: { lowShelf: 1, highShelf: 1 },
    saturation: { drive: 0.15, wet: 0.15 },
    bitcrusher: null,
    chorus: { frequency: 1.5, depth: 0.4, wet: 0.20 },
    compressor: { threshold: -18, ratio: 2.5 },
    stereo: { width: 0.85 },
    reverb: { decay: 4, wet: 0.40 },
    delay: { time: "8n", feedback: 0.25, wet: 0.20 },
    limiter: { threshold: -2 },
  },
};

export const PRESET_NAMES = Object.keys(PRESETS);
