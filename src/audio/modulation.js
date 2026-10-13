/**
 * Vibrato and tremolo on a note, without clicks.
 *
 * A track's vibrato (or tremolo) is one effect, switched on for the notes that
 * ask for it. Switching it by its `wet` jumps from the dry signal to the
 * modulated one in a single sample: with a vibrato, whose wet signal runs
 * through a moving delay, that jump is a click at the start and at the end of
 * every note (measured on a melody line: every click fell on a vibrato note's
 * start or end).
 *
 * So the effect stays fully wet, and its depth moves instead: from 0 up to the
 * note's depth as the note starts (`rise`), back to 0 as it ends (`fall`). A
 * depth of 0 leaves the sound untouched, apart from the vibrato's small fixed
 * delay. The depth ramps smoothly, as a player's hand eases into a vibrato.
 */

/** Seconds for the depth to reach its value, and to go back to 0. */
export const RISE = 0.12;
export const FALL = 0.04;

/** Make an effect ready: fully wet, with no depth until a note asks for it. */
export function prepareModulation(effect) {
  effect.wet.value = 1;
  effect.depth.value = 0;
}

/**
 * The note's modulation, from `time` (seconds, audio context time).
 *
 * @param {Object} effect - A Tone.Vibrato or Tone.Tremolo
 * @param {number} time
 * @param {Object} options
 * @param {number} options.frequency - Hz
 * @param {number} options.depth - 0..1
 */
export function modulationOn(effect, time, { frequency, depth }) {
  effect.frequency.setValueAtTime(frequency, time);
  effect.depth.cancelScheduledValues(time);
  effect.depth.setValueAtTime(effect.depth.getValueAtTime?.(time) ?? 0, time);
  effect.depth.linearRampToValueAtTime(depth, time + RISE);
}

/** The modulation fades out, from `time`. */
export function modulationOff(effect, time) {
  effect.depth.cancelScheduledValues(time);
  effect.depth.setValueAtTime(effect.depth.getValueAtTime?.(time) ?? 0, time);
  effect.depth.linearRampToValueAtTime(0, time + FALL);
}
