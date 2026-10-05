/**
 * The audioGraph's `Channel`, keeping a stereo signal stereo when it is panned.
 *
 * Tone.js pans a Channel with a StereoPannerNode. On a stereo input, that node
 * does not move the image: it folds part of one side into the other. A
 * sampled instrument's own width, or a reverb before the Channel, then
 * narrows towards mono as soon as `pan` leaves 0 (measured on a violin with
 * its reverb: the correlation between the sides went from 0.24 to 0.59 at
 * pan 0.3, and the sound did not move to the right).
 *
 * When a Channel says `channelCount: 2` and has a pan, the pan becomes a
 * balance instead: the far side is turned down (by `pan`, linearly), and
 * nothing is folded across. Pan 0, or a Channel without `channelCount: 2`,
 * is Tone's own Channel, unchanged. The balance is set once: the Channel's
 * `pan` signal stays at 0 and moving it later does nothing.
 */

/**
 * @param {Object} ToneLib - The Tone.js namespace
 * @param {Object} [options] - Tone.Channel options
 * @returns {Object} a Tone.Channel
 */
export function createChannel(ToneLib, options = {}) {
  const pan = options.pan ?? 0;
  if (options.channelCount !== 2 || !pan) return new ToneLib.Channel(options);

  const channel = new ToneLib.Channel({ ...options, pan: 0 });
  const split = new ToneLib.Split(2);
  const merge = new ToneLib.Merge(2);
  const left = new ToneLib.Gain(pan > 0 ? 1 - pan : 1);
  const right = new ToneLib.Gain(pan < 0 ? 1 + pan : 1);

  // Between the Channel's solo stage and its pan and volume stage.
  channel._solo.disconnect(channel._panVol);
  channel._solo.connect(split);
  split.connect(left, 0, 0);
  split.connect(right, 1, 0);
  left.connect(merge, 0, 0);
  right.connect(merge, 0, 1);
  merge.connect(channel._panVol);

  const dispose = channel.dispose.bind(channel);
  channel.dispose = () => {
    for (const node of [split, merge, left, right]) node.dispose();
    return dispose();
  };
  return channel;
}

/**
 * Build one audioGraph node of a Tone.js type: a Channel through
 * createChannel, anything else as Tone builds it.
 *
 * @param {Object} ToneLib - The Tone.js namespace
 * @param {string} type - A Tone.js class name
 * @param {Object} [options]
 */
export function createGraphNode(ToneLib, type, options = {}) {
  return type === "Channel" ? createChannel(ToneLib, options) : new ToneLib[type](options);
}
