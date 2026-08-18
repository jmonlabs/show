/**
 * Reading a composition is `jmon/io`'s job, not this package's.
 *
 * What a `tempoMap` does to a beat position, what an articulation compiles to,
 * how an automation target resolves: that is the meaning of the JMON format,
 * and it is defined in one place so the players, the exporters and the score
 * all agree. This package receives it rather than importing it, because Node
 * refuses `https://` imports and these modules are tested under Node.
 *
 * It is required, not optional. Without it a piece would still play, but its
 * tempo map, articulations and automation would be silently dropped, which is
 * worse than a clear failure.
 */

const MISSING =
  "jmon/show needs jmon/io to read a composition — its tempo map, time and key " +
  "signatures, automation and articulations.\n\n" +
  '  import io from "https://cdn.jsdelivr.net/gh/jmonlabs/io@main/src/index.js";\n' +
  "  show.play(composition, { Tone, sound, io });\n\n" +
  "See https://github.com/jmonlabs/io";

/**
 * Take the format layer out of an injected `io`, or fail with an explanation.
 *
 * @param {Object} io - `jmon/io`, or anything exposing the same `format`
 * @returns {Object} the format API
 */
export function requireFormat(io) {
  const format = io?.format ?? (typeof io?.tempoSegments === "function" ? io : null);
  if (!format || typeof format.tempoSegments !== "function"
      || typeof format.compileEvents !== "function") {
    throw new Error(MISSING);
  }
  return format;
}
