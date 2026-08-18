/**
 * jmon/show — hearing and seeing a JMON composition.
 *
 * Playback, live coding, offline WAV rendering, and score engraving. Every
 * part of the library that touches Web Audio or the DOM lives here, and
 * nowhere else does.
 *
 * It imports nothing. Tone.js, `jmon/io` and `jmon/sound` are passed in,
 * because Node refuses `https://` imports and these modules are tested under
 * Node. That constraint turns out to be a good rule: the coupling between the
 * packages is visible at every call site.
 *
 *     import jm    from "https://cdn.jsdelivr.net/gh/jmonlabs/algo@main/src/index.js";
 *     import io    from "https://cdn.jsdelivr.net/gh/jmonlabs/io@main/src/index.js";
 *     import show  from "https://cdn.jsdelivr.net/gh/jmonlabs/show@main/src/index.js";
 *     import sound from "https://cdn.jsdelivr.net/gh/jmonlabs/sound@main/src/index.js";
 *     import * as Tone from "npm:tone";
 *
 *     show.play(composition, { Tone, io, sound });
 *
 * `io` is required: without it a piece would play, but its tempo map,
 * articulations and automation would be dropped in silence. `sound` is
 * optional, and a track asking for a sampled instrument falls back to a synth.
 *
 * @license GPL-3.0-or-later
 */

import { createPlayer } from "./player.js";
import { wav as wavInfo, downloadWav } from "./wav.js";
import { scoreSVG } from "./score.js";
import { score as renderScore } from "./score-renderer.js";
import { requireFormat } from "./format.js";
import { isBrowser } from "./env.js";
import * as masterModule from "./audio/master.js";
import { normalizeAudioGraph } from "./audio/normalize.js";
import { tonejs } from "./tonejs.js";
import { SYNTHESIZER_TYPES, ALL_EFFECTS } from "./audio/effects.js";

export const VERSION = "1.0.0";

export { createPlayer, downloadWav, scoreSVG, tonejs, requireFormat };

/**
 * A player element for a composition.
 *
 * @param {Object} composition - A JMON composition
 * @param {Object} options
 * @param {Object} options.Tone - The Tone.js namespace
 * @param {Object} options.io - `jmon/io`. Required.
 * @param {Object} [options.sound] - `jmon/sound`, for sampled instruments
 * @param {boolean} [options.autoplay=false]
 * @returns {HTMLElement}
 */
export function play(composition, options = {}) {
  return createPlayer(composition, options);
}

/**
 * Render a composition to WAV and return a download link.
 *
 * @param {Object} composition - A JMON composition
 * @param {Object} options - `{ Tone, io, sound, filename, duration }`
 */
export function wav(composition, options = {}) {
  const { Tone, filename = "composition.wav", duration } = options;
  return downloadWav(composition, Tone, filename, duration, options);
}

/**
 * Engrave a composition as a score.
 *
 * @param {Object} composition - A JMON composition
 * @param {Object} options - `{ io, verovio, VerovioToolkit }` and render options
 */
export function score(composition, options = {}) {
  return renderScore(composition, options);
}

/** The mastering chains: dark, light, warm, cinematic, intimate, broadcast, vinyl, lush. */
export const master = masterModule.master ?? masterModule.default ?? masterModule;

export const show = {
  VERSION,
  play,
  score,
  wav,
  master,

  // The pieces underneath, for anyone assembling their own path.
  createPlayer,
  scoreSVG,
  downloadWav,
  tonejs,
  normalizeAudioGraph,
  isBrowser,
  SYNTHESIZER_TYPES,
  ALL_EFFECTS,
};

export default show;
