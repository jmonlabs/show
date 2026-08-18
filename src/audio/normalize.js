// src/utils/normalize.js
// Utilities to normalize JMON structures for downstream consumers

/**
 * Convert MIDI number to scientific pitch notation (e.g., 36 -> "C2").
 * @param {number|string} midiLike
 * @returns {string}
 */
export function midiToNoteName(midiLike) {
  const n = typeof midiLike === 'string' ? parseInt(midiLike, 10) : midiLike;
  if (!Number.isFinite(n)) return String(midiLike);
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const note = names[(n % 12 + 12) % 12];
  const octave = Math.floor(n / 12) - 1;
  return `${note}${octave}`;
}

/**
 * Capitalize first letter of a string (for normalizing Tone.js type names)
 */
function capitalizeFirstLetter(str) {
  if (!str || typeof str !== 'string') return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Normalize audioGraph format from {nodes: [], connections: []} to flat array with target.
 * Mutates the given piece object in-place for performance.
 *
 * Converts from:
 *   audioGraph: { nodes: [...], connections: [{from, to}, ...] }
 * To:
 *   audioGraph: [{ id, type, options, target }, ...]
 *
 * @param {object} piece
 * @returns {object} the same piece object (for chaining)
 */
export function normalizeAudioGraph(piece) {
  if (!piece || !piece.audioGraph) return piece;

  const ag = piece.audioGraph;

  // If already an array, assume it's in the correct format
  if (Array.isArray(ag)) return piece;

  // If it's an object with nodes and connections, convert it
  if (ag.nodes && Array.isArray(ag.nodes)) {
    const connectionsMap = new Map();

    // Build a map of node ID -> target from connections
    if (ag.connections && Array.isArray(ag.connections)) {
      ag.connections.forEach(conn => {
        if (conn.from && conn.to) {
          connectionsMap.set(conn.from, conn.to);
        }
      });
    }

    // Convert nodes array to flat array with target field
    const flatArray = ag.nodes.map(node => {
      const target = connectionsMap.get(node.id);
      // Capitalize type to match Tone.js class names (synth -> Synth, filter -> Filter, etc.)
      const normalizedType = capitalizeFirstLetter(node.type);
      return {
        id: node.id,
        type: normalizedType,
        options: node.params || node.options || {},
        ...(target && { target })
      };
    });

    // Add destination node if referenced in connections
    const destinationRefs = new Set();
    if (ag.connections) {
      ag.connections.forEach(conn => {
        if (conn.to === 'destination') {
          destinationRefs.add(conn.to);
        }
      });
    }
    if (destinationRefs.size > 0) {
      flatArray.push({ id: 'destination', type: 'Destination' });
    }

    piece.audioGraph = flatArray;
  }

  return piece;
}

/**
 * Normalize Sampler urls keys to scientific pitch notation.
 * Mutates the given piece object in-place for performance.
 *
 * @param {object} piece
 * @returns {object} the same piece object (for chaining)
 */
export function normalizeSamplerUrlsToNoteNames(piece) {
  if (!piece || !Array.isArray(piece.audioGraph)) return piece;

  piece.audioGraph.forEach(node => {
    try {
      if (!node || node.type !== 'Sampler') return;
      const opts = node.options || {};
      const urls = opts.urls;
      if (!urls || typeof urls !== 'object') return;

      // Build normalized map
      const normalized = {};
      Object.keys(urls).forEach(k => {
        const keyStr = String(k);
        let noteKey = keyStr;
        if (/^\d+$/.test(keyStr)) {
          noteKey = midiToNoteName(parseInt(keyStr, 10));
        }
        normalized[noteKey] = urls[k];
      });

      node.options = { ...opts, urls: normalized };
    } catch (_) {
      // best-effort normalization; ignore errors
    }
  });
  return piece;
}
