/**
 * Session class manages JMON pattern state and playback position
 * Designed to update patterns without interrupting playback
 *
 * Supports the full JMON format specification:
 * https://github.com/jmonlabs/jmon-format
 */
export class Session {
    constructor() {
        this.pattern = null;
        this.flattenedNotes = []; // All notes from all tracks, flattened and sorted by time
        this.position = 0;
        this.eventsPlayed = 0;
        this.tempo = 120; // default BPM
        this.startTime = 0; // Pattern start time in Tone.js time
        this.loopDuration = 0; // Total pattern duration in quarter notes
        this.timeSignature = [4, 4];
        this.beatsPerBar = 4;
        this.tracks = [];
    }

    /**
     * Parse a "num/denom" time signature string. Returns [num, denom].
     */
    parseTimeSignature(ts) {
        if (!ts) return [4, 4];
        if (Array.isArray(ts) && ts.length === 2) return [ts[0] | 0, ts[1] | 0];
        if (typeof ts === 'string') {
            const parts = ts.split('/');
            const num = parseInt(parts[0], 10);
            const denom = parseInt(parts[1], 10);
            if (Number.isFinite(num) && Number.isFinite(denom) && denom > 0) {
                return [num, denom];
            }
        }
        return [4, 4];
    }

    /**
     * Update the pattern without resetting playback
     * @param {Object} newPattern - JMON pattern object
     * @param {boolean} resetPosition - Whether to reset position (default: true)
     */
    setPattern(newPattern, resetPosition = true) {
        // Validate JMON format
        if (!newPattern) {
            console.warn('No pattern provided');
            return;
        }

        // Support both full JMON format and simplified format
        if (newPattern.format === 'jmon' || newPattern.tracks) {
            // Full JMON format
            this.pattern = newPattern;
            this.tempo = newPattern.tempo || 120;
            this.timeSignature = this.parseTimeSignature(newPattern.timeSignature);
            this.beatsPerBar = this.timeSignature[0] * (4 / this.timeSignature[1]);
            this.tracks = newPattern.tracks || [];
            this.flattenedNotes = this.flattenJMONTracks(this.tracks);
        } else if (newPattern.events) {
            // Simplified format (legacy support)
            this.pattern = newPattern;
            this.tempo = newPattern.tempo || 120;
            this.flattenedNotes = newPattern.events.map((event, index) => ({
                ...event,
                time: event.time || index, // Use provided time or sequence position
                trackLabel: 'main'
            }));
        } else {
            console.error('Invalid pattern format. Expected JMON format with tracks or simplified format with events.');
            return;
        }

        // Calculate total loop duration as the latest end across all notes,
        // then round up to the next bar so the pattern aligns to the metric grid.
        if (this.flattenedNotes.length > 0) {
            let latestEnd = 0;
            for (const note of this.flattenedNotes) {
                const end = note.time + this.parseDuration(note.duration);
                if (end > latestEnd) latestEnd = end;
            }
            const bpb = this.beatsPerBar || 4;
            this.loopDuration = Math.max(bpb, Math.ceil(latestEnd / bpb) * bpb);
        } else {
            this.loopDuration = 0;
        }

        // A track marked `loop` cycles on its own length instead of falling
        // silent until the longest track comes around (JMON spec: tracks[].loop).
        this.flattenedNotes = this.expandLoopingTracks(this.flattenedNotes);

        if (resetPosition) {
            this.position = 0;
            this.eventsPlayed = 0;
        }

        // Notify UI
        this.updateUI();
    }

    /**
     * Flatten JMON tracks into a single sorted array of notes
     * @param {Array} tracks - Array of JMON tracks
     * @returns {Array} Flattened and sorted notes
     */
    flattenJMONTracks(tracks) {
        if (!tracks || tracks.length === 0) {
            return [];
        }

        const allNotes = [];

        tracks.forEach(track => {
            if (!track.notes || track.notes.length === 0) {
                return;
            }

            track.notes.forEach(note => {
                allNotes.push({
                    ...note,
                    trackLabel: track.label,
                    trackSynth: track.synth,
                    trackSynthRef: track.synthRef,
                    trackMidiChannel: track.midiChannel,
                    trackMidiProgram: track.midiProgram,
                    trackPan: track.pan
                });
            });
        });

        // Sort by time (convert all times to quarter notes first)
        allNotes.sort((a, b) => {
            const timeA = this.parseTime(a.time);
            const timeB = this.parseTime(b.time);
            return timeA - timeB;
        });

        // Convert times to quarter notes for easy scheduling
        return allNotes.map(note => ({
            ...note,
            time: this.parseTime(note.time) // Normalize to quarter notes
        }));
    }

    /**
     * How long one cycle of a track lasts, in quarter notes — 0 when the
     * track does not loop.
     *
     * JMON spec: `tracks[].loop` is a boolean or a musical-duration string,
     * `tracks[].loopEnd` a bars:beats:ticks end point. `loop: true` without
     * an explicit length cycles on the track's own extent, rounded up to the
     * bar — which is what a live coder means by "just loop it".
     *
     * @param {Object} track - A JMON track
     * @param {number} extent - The track's latest note end, in quarter notes
     * @returns {number} Cycle length in quarter notes, or 0
     */
    trackLoopLength(track, extent) {
        const loop = track.loop;
        if (loop === undefined || loop === null || loop === false) return 0;
        let length = 0;
        if (typeof loop === 'string') length = this.parseTime(loop);
        else if (typeof loop === 'number' && loop > 0) length = loop;
        if (!length && typeof track.loopEnd === 'string') length = this.parseTime(track.loopEnd);
        if (!length) {
            const bpb = this.beatsPerBar || 4;
            length = Math.max(bpb, Math.ceil(extent / bpb) * bpb);
        }
        return length;
    }

    /**
     * Tile every looping track's notes across the pattern, so a 2-bar drum
     * loop keeps cycling under a 4-bar bass line instead of playing once and
     * waiting. The global loop is still `loopDuration`: a cycle length that
     * does not divide it gets its phase reset at the pattern boundary.
     *
     * @param {Array} notes - Flattened notes, times in quarter notes
     * @returns {Array} Notes with looping tracks tiled, sorted by time
     */
    expandLoopingTracks(notes) {
        if (!this.tracks || this.tracks.length === 0 || !this.loopDuration) return notes;

        const extents = new Map();
        for (const note of notes) {
            const end = note.time + this.parseDuration(note.duration);
            if (end > (extents.get(note.trackLabel) ?? 0)) extents.set(note.trackLabel, end);
        }

        const epsilon = 1e-9;
        const out = [...notes];
        let tiled = false;
        for (const track of this.tracks) {
            const length = this.trackLoopLength(track, extents.get(track.label) ?? 0);
            if (!length || length >= this.loopDuration) continue;
            const base = notes.filter(
                (n) => n.trackLabel === track.label && n.time < length - epsilon
            );
            for (let offset = length; offset < this.loopDuration - epsilon; offset += length) {
                for (const n of base) {
                    if (n.time + offset < this.loopDuration - epsilon) {
                        out.push({ ...n, time: n.time + offset });
                    }
                }
            }
            tiled = true;
        }
        if (!tiled) return notes;
        out.sort((a, b) => a.time - b.time);
        return out;
    }

    /**
     * Parse JMON time value to quarter notes
     * @param {*} time - Time value (number, Tone.js notation, or bars:beats:ticks)
     * @returns {number} Time in quarter notes
     */
    parseTime(time) {
        if (typeof time === 'number') {
            // Already in quarter notes
            return time;
        }

        if (typeof time === 'string') {
            // Bars:beats:sixteenths format (e.g., "2:1:0")
            if (time.includes(':')) {
                const parts = time.split(':');
                const bars = parseFloat(parts[0]) || 0;
                const beats = parseFloat(parts[1]) || 0;
                const sixteenths = parseFloat(parts[2]) || 0;
                return bars * this.beatsPerBar + beats + sixteenths * 0.25;
            }

            // Tone.js notation (e.g., "4n", "8t") — treat the same as a duration
            return this.parseDuration(time);
        }

        return 0;
    }

    /**
     * Parse JMON duration value to quarter notes
     * @param {*} duration - Duration value (note value like "4n" or number)
     * @returns {number} Duration in quarter notes
     */
    parseDuration(duration) {
        if (!duration) {
            return 0.25; // Default to 16th note
        }

        if (typeof duration === 'number') {
            // If it's a number < 10, assume it's quarter notes
            // If it's > 10, it might be milliseconds (legacy), convert
            if (duration < 10) {
                return duration;
            } else {
                // Assume seconds, convert to quarter notes based on tempo
                const beatsPerSecond = this.tempo / 60;
                return duration * beatsPerSecond;
            }
        }

        if (typeof duration === 'string') {
            // Parse note values: "1n" = 4 quarter notes, "2n" = 2 quarter notes, "4n" = 1 quarter note, etc.
            const match = duration.match(/^(\d+)(n|t)$/);
            if (match) {
                const value = parseInt(match[1]);
                const type = match[2];

                if (type === 'n') {
                    // Normal note: "4n" = quarter note = 1
                    return 4 / value;
                } else if (type === 't') {
                    // Triplet: "8t" = eighth note triplet
                    return (4 / value) * (2/3);
                }
            }

            // Bars:beats:sixteenths format
            if (duration.includes(':')) {
                const parts = duration.split(':');
                const bars = parseFloat(parts[0]) || 0;
                const beats = parseFloat(parts[1]) || 0;
                const sixteenths = parseFloat(parts[2]) || 0;
                return bars * this.beatsPerBar + beats + sixteenths * 0.25;
            }
        }

        return 0.25; // Default to 16th note
    }

    /**
     * Get the next event to play
     * @param {number} time - Current Tone.js time
     * @returns {Object|null} Event object with pitch, duration, velocity, etc.
     */
    next(time) {
        if (!this.flattenedNotes || this.flattenedNotes.length === 0) {
            return null;
        }

        // Get current event
        const event = this.flattenedNotes[this.position];

        // Increment position (loop back to start)
        this.position = (this.position + 1) % this.flattenedNotes.length;
        this.eventsPlayed++;

        // Update UI
        this.updateUI();

        // Return event with timing info
        return {
            ...event,
            scheduledTime: time,
            position: this.position
        };
    }

    /**
     * Get all notes that should play at a specific time
     * @param {number} currentTime - Current time in quarter notes (relative to pattern start)
     * @returns {Array} Array of notes to play
     */
    getNotesAtTime(currentTime) {
        if (!this.flattenedNotes || this.flattenedNotes.length === 0) {
            return [];
        }

        // Loop the time within the pattern duration
        const loopedTime = this.loopDuration > 0 ? currentTime % this.loopDuration : currentTime;

        // Find all notes that should play at this time (with small tolerance)
        const tolerance = 0.01; // Small tolerance for floating point comparison
        return this.flattenedNotes.filter(note => {
            return Math.abs(note.time - loopedTime) < tolerance;
        });
    }

    /**
     * Get pattern length (number of notes)
     * @returns {number}
     */
    getPatternLength() {
        return this.flattenedNotes ? this.flattenedNotes.length : 0;
    }

    /**
     * Get pattern duration in quarter notes
     * @returns {number}
     */
    getPatternDuration() {
        return this.loopDuration;
    }

    /**
     * Convert quarter notes to seconds based on current tempo
     * @param {number} quarterNotes - Duration in quarter notes
     * @returns {number} Duration in seconds
     */
    quarterNotesToSeconds(quarterNotes) {
        // BPM = beats per minute = quarter notes per minute
        // seconds = (quarter notes / BPM) * 60
        return (quarterNotes / this.tempo) * 60;
    }

    /**
     * Update UI elements
     */
    updateUI() {
        if (typeof document !== 'undefined') {
            const patternLengthEl = document.getElementById('pattern-length');
            const eventsPlayedEl = document.getElementById('events-played');
            const positionEl = document.getElementById('position');

            if (patternLengthEl) {
                patternLengthEl.textContent = this.getPatternLength();
            }
            if (eventsPlayedEl) {
                eventsPlayedEl.textContent = this.eventsPlayed;
            }
            if (positionEl) {
                positionEl.textContent = this.position;
            }
        }
    }

    /**
     * Reset counters
     */
    reset() {
        this.position = 0;
        this.eventsPlayed = 0;
        this.startTime = 0;
        this.updateUI();
    }
}

