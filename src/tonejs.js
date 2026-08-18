/* JMON to Tone.js Converter */
// Enhanced converter to compute total duration correctly and pass through events
export class Tonejs {
    constructor(options = {}) {
        this.options = options;
    }

    // Parse bars:beats:ticks -> beats (supports fractional beats)
    static parseBBTToBeats(timeStr, beatsPerBar = 4, ppq = 480) {
        if (typeof timeStr === 'number') return timeStr; // already beats
        if (typeof timeStr !== 'string') return 0;

        const m = timeStr.match(/^(\d+):(\d+(?:\.\d+)?):(\d+)$/);
        if (!m) return 0;
        const bars = parseInt(m[1], 10);
        const beats = parseFloat(m[2]);
        const ticks = parseInt(m[3], 10);
        return bars * beatsPerBar + beats + (ticks / ppq);
    }

    // Parse note value (e.g., 4n, 8n, 8t) or BBT to beats
    static parseDurationToBeats(dur, beatsPerBar = 4, ppq = 480) {
        if (typeof dur === 'number') return dur; // assume beats
        if (typeof dur !== 'string') return 0;

        // bars:beats:ticks format
        if (/^\d+:\d+(?:\.\d+)?:\d+$/.test(dur)) {
            return this.parseBBTToBeats(dur, beatsPerBar, ppq);
        }

        // Note value format e.g. 4n, 8n, 16n, 8t
        const m = dur.match(/^(\d+)(n|t)$/);
        if (m) {
            const val = parseInt(m[1], 10);
            const type = m[2];
            if (type === 'n') {
                return 4 / val; // 4n=1 beat, 8n=0.5 beat, 16n=0.25 beat
            } else if (type === 't') {
                // Triplet: duration is two-thirds of the corresponding 'n' value
                return (4 / val) * (2 / 3);
            }
        }
        return 0;
    }

    convert(composition) {
        const tracks = composition.tracks || [];
        return tracks.map(track => ({
            label: track.label,
            type: 'PolySynth', // Default type for the current player
            part: (track.events || track.notes || []).map(note => ({
                time: note.time,
                pitch: note.pitch,
                duration: note.duration,
                velocity: note.velocity || 0.8,
                microtuning: note.microtuning // Pass through microtuning in semitones
            }))
        }));
    }
}

import { normalizeAudioGraph, normalizeSamplerUrlsToNoteNames } from './audio/normalize.js';

export function tonejs(composition, options = {}) {
    // Normalize audioGraph format (nodes/connections -> flat array)
    try {
        normalizeAudioGraph(composition);
    } catch (_) {
        // Ignore normalization errors - composition may not have audioGraph
    }

    // Normalize audioGraph Sampler keys to scientific note names (best compatibility)
    try {
        normalizeSamplerUrlsToNoteNames(composition);
    } catch (_) {
        // Ignore normalization errors - composition may not have audioGraph
    }

    const converter = new Tonejs(options);
    const originalTracks = converter.convert(composition);

    // Convert to the format expected by the music player
    const tracks = originalTracks.map((track, index) => ({
        originalTrackIndex: index,
        voiceIndex: 0,
        totalVoices: 1,
        trackInfo: { label: track.label },
        synthConfig: { type: track.type || 'PolySynth' },
        partEvents: track.part || []
    }));

    // Compute total duration in seconds using BPM and timeSignature
    const bpm = composition.tempo || composition.metadata?.tempo || composition.bpm || 120;
    const [tsNum, tsDen] = (composition.timeSignature || '4/4').split('/').map(x => parseInt(x, 10));
    const beatsPerBar = isFinite(tsNum) ? tsNum : 4;

    let totalBeats = 0;
    tracks.forEach(track => {
        if (track.partEvents && track.partEvents.length > 0) {
            track.partEvents.forEach(ev => {
                const startBeats = Tonejs.parseBBTToBeats(ev.time, beatsPerBar);
                const durBeats = Tonejs.parseDurationToBeats(ev.duration, beatsPerBar);
                const endBeats = startBeats + durBeats;
                if (endBeats > totalBeats) totalBeats = endBeats;
            });
        }
    });

    const secondsPerBeat = 60 / bpm;
    const totalDuration = totalBeats * secondsPerBeat;

    console.log(`[TONEJS] Duration calc: totalBeats=${totalBeats.toFixed(2)} beats = ${totalDuration.toFixed(2)}s - loop ends exactly when last note finishes`);

    return {
        tracks,
        metadata: {
            totalDuration, // Use total duration - loop should end when last note finishes
            tempo: bpm
        }
    };
}
