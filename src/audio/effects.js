/**
 * Audio Effects Constants
 * Supported Tone.js effects for the JMON audio graph
 */

// Core reverb effects
export const REVERB_EFFECTS = [
  "Reverb",
  "JCReverb", 
  "Freeverb"
];

// Delay-based effects
export const DELAY_EFFECTS = [
  "Delay",
  "FeedbackDelay",
  "PingPongDelay"
];

// Modulation effects  
export const MODULATION_EFFECTS = [
  "Chorus",
  "Phaser",
  "Tremolo",
  "Vibrato",
  "AutoWah"
];

// Distortion and dynamics
export const DISTORTION_EFFECTS = [
  "Distortion",
  "Chebyshev",
  "BitCrusher"
];

export const DYNAMICS_EFFECTS = [
  "Compressor",
  "Limiter",
  "Gate",
  "MidSideCompressor"
];

// Filter effects
export const FILTER_EFFECTS = [
  "Filter",
  "AutoFilter"
];

// Advanced effects
export const ADVANCED_EFFECTS = [
  "FrequencyShifter",
  "PitchShift",
  "StereoWidener"
];

// Utility nodes — routing / level control (not really effects but
// supported as audioGraph nodes for per-track buses, sub-mixes, etc.)
export const UTILITY_NODES = [
  "Gain",
  "Volume",
  "Channel",
  "EQ3"
];

// All supported effects (combined)
export const ALL_EFFECTS = [
  ...REVERB_EFFECTS,
  ...DELAY_EFFECTS,
  ...MODULATION_EFFECTS,
  ...DISTORTION_EFFECTS,
  ...DYNAMICS_EFFECTS,
  ...FILTER_EFFECTS,
  ...ADVANCED_EFFECTS,
  ...UTILITY_NODES
];

// Synthesizer types
export const SYNTHESIZER_TYPES = [
  "Synth",
  "PolySynth",
  "MonoSynth",
  "AMSynth",
  "FMSynth",
  "DuoSynth",
  "PluckSynth",
  "NoiseSynth"
];

// Special audio graph node types
export const SPECIAL_NODE_TYPES = [
  "Sampler",
  "Destination"
];

// All supported audioGraph node types
export const ALL_AUDIO_GRAPH_TYPES = [
  ...SYNTHESIZER_TYPES,
  ...ALL_EFFECTS,
  ...SPECIAL_NODE_TYPES
];

export default {
  REVERB_EFFECTS,
  DELAY_EFFECTS,
  MODULATION_EFFECTS,
  DISTORTION_EFFECTS,
  DYNAMICS_EFFECTS,
  FILTER_EFFECTS,
  ADVANCED_EFFECTS,
  UTILITY_NODES,
  ALL_EFFECTS,
  SYNTHESIZER_TYPES,
  SPECIAL_NODE_TYPES,
  ALL_AUDIO_GRAPH_TYPES
};