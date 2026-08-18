/* JMON WAV - offline audio rendering from JMON format.
 *
 * Lives here rather than in `converters/` despite producing a file: the other
 * converters turn data into data, while this one needs the whole audio stack
 * (synth factory, audio graph, sample provider) and renders through
 * Tone.Offline. Keeping it beside the players is also what breaks the import
 * cycle it used to have with them.
 */
import {
	applyPitchAnchors,
	createGlideVoice,
	createTrackSynth,
	hasDetuneParam,
	resolveConnectTarget,
	resolveSynthPreset,
} from "./synth-factory.js";
import { requireFormat } from "./format.js";
import { SYNTHESIZER_TYPES, ALL_EFFECTS } from "./audio/effects.js";
import { normalizeAudioGraph } from "./audio/normalize.js";

export function wav(piece, options = {}) {
	return {
		sampleRate: options.sampleRate || 44100,
		duration: options.duration || 10,
		channels: options.channels || 1,
		tempo: piece.tempo || piece.bpm || 120,
		notes: piece.tracks?.flatMap(t => t.notes) || []
	};
}

/**
 * Download a WAV file from a JMON piece
 *
 * @param {Object} piece - The JMON piece
 * @param {Object} Tone - The Tone.js library (import from npm:tone)
 * @param {string} filename - Output filename (default: "piece.wav")
 * @param {number} duration - Duration in seconds (default: auto-calculated from piece)
 * @returns {Promise<void>}
 *
 * @example
 * import * as Tone from "npm:tone@14.7.77";
 * await jm.wav(piece, { filename: "my-song.wav" });
 */
export async function downloadWav(piece, Tone, filename = "piece.wav", duration, options = {}) {
	normalizeAudioGraph(piece);
	const sound = options.sound || null;
	const fmt = requireFormat(options.io);

	// Let the provider settle its sample source before entering the offline
	// render, not inside it: Tone.Offline does not wait on network work started
	// within its callback.
	if (typeof sound?.prepare === "function") {
		await sound.prepare(
			(piece.tracks || []).map(t => resolveSynthPreset(t && t.synth, piece.customPresets)),
		);
	}

	// Calculate duration from piece if not provided
	const maxTime = piece.tracks?.reduce((max, track) => {
		const events = track.events || track.notes || [];
		const trackMax = events.reduce((tMax, note) => {
			const endTime = (note.time || 0) + (note.duration || 0);
			return Math.max(tMax, endTime);
		}, 0);
		return Math.max(max, trackMax);
	}, 0) || 4;

	// Convert quarter notes to seconds
	const tempo = piece.tempo || 120;
	const secondsPerQuarterNote = 60 / tempo;
	const calculatedDuration = maxTime * secondsPerQuarterNote + 1; // +1 second buffer

	const finalDuration = duration || calculatedDuration;

	// Render audio offline using Tone.js
	const buffer = await Tone.Offline(async ({ transport }) => {
		transport.bpm.value = tempo;

		// Build audioGraph instruments if present
		const graphInstruments = await buildAudioGraphInstruments(piece, Tone);

		// Compile modulations for all tracks
		const compiledModulations = [];
		const tracks = piece.tracks || [];
		tracks.forEach((track, index) => {
			try {
				const compiled = fmt.compileEvents(track);
				compiledModulations[index] = compiled.modulations || [];
			} catch (e) {
				console.warn(`[WAV] Failed to compile modulations for track ${index}:`, e);
				compiledModulations[index] = [];
			}
		});

		// Phase 1: Create synths and effects for each track via the shared
		// factory. Routing matches the live player exactly: track.output >
		// audioGraph default node > heuristic > destination.
		const trackSynths = [];
		const samplers = [];
		tracks.forEach((track, trackIndex) => {
			const trackModulations = compiledModulations[trackIndex] || [];

			const synthRef = track.synthRef;
			const implicitSynthId = (piece.audioGraph || []).find(
				n => SYNTHESIZER_TYPES.includes(n.type)
			)?.id;
			const sharedSynthId = synthRef || implicitSynthId;
			const sharedSynth = sharedSynthId && graphInstruments ? graphInstruments[sharedSynthId] : null;

			const connectTarget = resolveConnectTarget(
				track,
				sharedSynth ? null : piece.audioGraph,
				graphInstruments || {},
				null,
			);

			const { synth, isLoadable, isShared } = createTrackSynth(
				track, Tone, sharedSynth, piece.customPresets, sound,
			);
			if (isLoadable) samplers.push(synth);
			if (!isShared) {
				if (connectTarget) synth.connect(connectTarget);
				else synth.toDestination();
			}

			// Check for vibrato/tremolo modulations
			const vibratoMods = trackModulations.filter(
				(m) => m.type === "pitch" && m.subtype === "vibrato"
			);
			const tremoloMods = trackModulations.filter(
				(m) => m.type === "amplitude" && m.subtype === "tremolo"
			);

			let vibratoEffect = null;
			let tremoloEffect = null;

			if (vibratoMods.length > 0 || tremoloMods.length > 0) {
				if (!isShared) synth.disconnect();

				if (vibratoMods.length > 0) {
					const defaultVibrato = vibratoMods[0];
					vibratoEffect = new Tone.Vibrato({
						frequency: defaultVibrato.rate || 5,
						depth: (defaultVibrato.depth || 50) / 100,
					});
					vibratoEffect.wet.value = 0;
				}

				if (tremoloMods.length > 0) {
					const defaultTremolo = tremoloMods[0];
					tremoloEffect = new Tone.Tremolo({
						frequency: defaultTremolo.rate || 8,
						depth: defaultTremolo.depth || 0.3,
					}).start();
					tremoloEffect.wet.value = 0;
				}

				const tail = (node) => {
					if (connectTarget) node.connect(connectTarget);
					else node.toDestination();
				};

				if (vibratoEffect && tremoloEffect) {
					synth.connect(vibratoEffect);
					vibratoEffect.connect(tremoloEffect);
					tail(tremoloEffect);
				} else if (vibratoEffect) {
					synth.connect(vibratoEffect);
					tail(vibratoEffect);
				} else if (tremoloEffect) {
					synth.connect(tremoloEffect);
					tail(tremoloEffect);
				}
			}

			// Dedicated glide voice for pitch curves when the track synth has
			// no detune signal (PolySynth, Sampler) — mirrors music-player.js.
			let glideVoice = null;
			const hasPitchCurves = trackModulations.some(
				(m) => m.type === "pitch" && Array.isArray(m.anchors) && m.anchors.length > 0
			);
			if (hasPitchCurves && !hasDetuneParam(synth)) {
				glideVoice = createGlideVoice(track, Tone);
				if (glideVoice) {
					const entry = vibratoEffect || tremoloEffect || connectTarget;
					if (entry) glideVoice.connect(entry);
					else glideVoice.toDestination();
				}
			}

			const loopSustain = !(
				track.synth && typeof track.synth === "object" && track.synth.loopSustain === false
			);

			trackSynths.push({ synth, glideVoice, vibratoEffect, tremoloEffect, loopSustain });
		});

		// Phase 2: Wait for all samplers to finish loading
		console.log(`[WAV] Waiting for ${samplers.length} sampler(s) to load...`);
		await Promise.all(samplers.map(s => s.loaded));
		await Tone.loaded();
		console.log('[WAV] Samples loaded, scheduling notes');

		// Phase 3: Schedule notes and modulation effects
		tracks.forEach((track, trackIndex) => {
			const notes = track.events || track.notes || [];
			const trackModulations = compiledModulations[trackIndex] || [];
			const { synth, glideVoice, vibratoEffect, tremoloEffect, loopSustain } = trackSynths[trackIndex];

			// Schedule effect enable/disable
			trackModulations.forEach((mod) => {
				const startTime = mod.start * secondsPerQuarterNote;
				const endTime = mod.end * secondsPerQuarterNote;

				if (mod.type === "pitch" && mod.subtype === "vibrato" && vibratoEffect) {
					transport.schedule(() => {
						vibratoEffect.frequency.value = mod.rate || 5;
						vibratoEffect.depth.value = (mod.depth || 50) / 100;
						vibratoEffect.wet.value = 1;
					}, startTime);
					transport.schedule(() => { vibratoEffect.wet.value = 0; }, endTime);
				}

				if (mod.type === "amplitude" && mod.subtype === "tremolo" && tremoloEffect) {
					transport.schedule(() => {
						tremoloEffect.frequency.value = mod.rate || 8;
						tremoloEffect.depth.value = mod.depth || 0.3;
						tremoloEffect.wet.value = 1;
					}, startTime);
					transport.schedule(() => { tremoloEffect.wet.value = 0; }, endTime);
				}
			});

			// Build glissando lookup
			const modsByNote = {};
			trackModulations.forEach((mod) => {
				if (!modsByNote[mod.index]) modsByNote[mod.index] = [];
				modsByNote[mod.index].push(mod);
			});

			// Schedule notes
			notes.forEach((note, noteIndex) => {
				const time = (note.time || 0) * secondsPerQuarterNote;
				const noteDuration = (note.duration || 1) * secondsPerQuarterNote;
				const noteMods = modsByNote[noteIndex] || [];

				// Unified pitch curve: glissando, portamento, bend, and pitch
				// envelopes all compile to the same anchors representation.
				const pitchCurve = noteMods.find(
					(m) => m.type === "pitch" && Array.isArray(m.anchors) && m.anchors.length > 0
				);

				const mt = note.microtuning || 0;

				if (Array.isArray(note.pitch)) {
					const chordNotes = note.pitch.map((p) =>
						typeof p === "number"
							? (mt ? Tone.Frequency(p + mt, "midi").toFrequency() : Tone.Frequency(p, "midi").toNote())
							: p
					);
					synth.triggerAttackRelease(chordNotes, noteDuration, time, note.velocity || 0.8);
				} else {
					const noteName =
						typeof note.pitch === "number"
							? Tone.Frequency(note.pitch, "midi").toNote()
							: note.pitch;

					// Pitch curves take the same three paths as the player, so a
					// rendered slide sounds like the one you heard: the synth's
					// own detune, resampling a Sampler's voices, or the
					// dedicated glide voice.
					if (pitchCurve && (hasDetuneParam(synth) || sound?.bendVoices || glideVoice)) {
						const microtuningCents = mt * 100;
						// Anchor times are absolute beats; rebase to the note start.
						const anchorsSec = pitchCurve.anchors.map((a) => ({
							time: (a.time - pitchCurve.start) * secondsPerQuarterNote,
							value: a.value,
						}));
						const velocity = note.velocity || 0.8;

						if (hasDetuneParam(synth)) {
							applyPitchAnchors(synth.detune, time, anchorsSec, microtuningCents);
							synth.triggerAttackRelease(noteName, noteDuration, time, velocity);
						} else if (sound?.bendVoices) {
							const midi = typeof note.pitch === "number"
								? note.pitch
								: Tone.Frequency(noteName).toMidi();
							synth.triggerAttack(noteName, time, velocity);
							const slid = sound.bendVoices(synth, midi, time, anchorsSec, microtuningCents);
							if (loopSustain) sound.holdVoices?.(synth, midi, time, noteDuration);
							synth.triggerRelease(noteName, time + noteDuration);
							if (!slid && glideVoice) {
								applyPitchAnchors(glideVoice.detune, time, anchorsSec, microtuningCents);
								glideVoice.triggerAttackRelease(noteName, noteDuration, time, velocity);
							}
						} else {
							applyPitchAnchors(glideVoice.detune, time, anchorsSec, microtuningCents);
							glideVoice.triggerAttackRelease(noteName, noteDuration, time, velocity);
						}
					} else {
						// Apply microtuning by converting to frequency
						const playNote = mt
							? Tone.Frequency(note.pitch + mt, "midi").toFrequency()
							: noteName;
						synth.triggerAttackRelease(playNote, noteDuration, time, note.velocity || 0.8);
						// Loop a sampled instrument's sustain so a long note does
						// not run out of recording, as in the live player.
						if (loopSustain && typeof note.pitch === "number") {
							sound?.holdVoices?.(synth, note.pitch, time, noteDuration);
						}
					}
				}
			});
		});

		transport.start(0);
	}, finalDuration);

	// Convert AudioBuffer to WAV blob
	const wavBlob = await audioBufferToWav(buffer);

	// Return a download link element (like the MIDI converter)
	const url = URL.createObjectURL(wavBlob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	a.textContent = `Download ${filename}`;
	return a;
}

/**
 * Build audioGraph instruments from piece
 * @private
 */
async function buildAudioGraphInstruments(piece, Tone) {
	if (!piece.audioGraph || !Array.isArray(piece.audioGraph)) {
		return null;
	}

	const map = {};
	const { SYNTHESIZER_TYPES, ALL_EFFECTS } = await import("../constants/audio-effects.js");

	try {
		// First pass: Create all nodes
		piece.audioGraph.forEach((node) => {
			const { id, type, options = {} } = node;
			if (!id || !type) return;

			let instrument = null;

			if (SYNTHESIZER_TYPES.includes(type)) {
				// Create synth
				try {
					instrument = new Tone[type](options);
				} catch (e) {
					console.warn(`Failed to create ${type}, using PolySynth:`, e);
					instrument = new Tone.PolySynth();
				}
			} else if (ALL_EFFECTS.includes(type)) {
				// Create effect
				try {
					instrument = new Tone[type](options);
				} catch (e) {
					console.warn(`Failed to create ${type} effect:`, e);
					instrument = null;
				}
			} else if (type === "Destination") {
				map[id] = Tone.Destination;
			}

			if (instrument) {
				map[id] = instrument;
			}
		});

		// Second pass: Connect the routing
		piece.audioGraph.forEach((node) => {
			const { id, target } = node;
			if (!id || !map[id] || map[id] === Tone.Destination) return;

			const currentNode = map[id];

			if (target && map[target]) {
				// Connect to target
				if (map[target] === Tone.Destination) {
					currentNode.toDestination();
				} else {
					currentNode.connect(map[target]);
				}
			} else {
				// No target, connect to destination
				currentNode.toDestination();
			}
		});

		return map;
	} catch (e) {
		console.error("Failed building audioGraph instruments:", e);
		return null;
	}
}

/**
 * Convert an AudioBuffer to a WAV blob
 * @private
 */
function audioBufferToWav(buffer) {
	const numberOfChannels = buffer.numberOfChannels;
	const sampleRate = buffer.sampleRate;
	const length = buffer.length * numberOfChannels * 2;

	const arrayBuffer = new ArrayBuffer(44 + length);
	const view = new DataView(arrayBuffer);

	// WAV header
	const writeString = (offset, string) => {
		for (let i = 0; i < string.length; i++) {
			view.setUint8(offset + i, string.charCodeAt(i));
		}
	};

	writeString(0, "RIFF");
	view.setUint32(4, 36 + length, true);
	writeString(8, "WAVE");
	writeString(12, "fmt ");
	view.setUint32(16, 16, true); // fmt chunk size
	view.setUint16(20, 1, true); // PCM format
	view.setUint16(22, numberOfChannels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * numberOfChannels * 2, true); // byte rate
	view.setUint16(32, numberOfChannels * 2, true); // block align
	view.setUint16(34, 16, true); // bits per sample
	writeString(36, "data");
	view.setUint32(40, length, true);

	// Write audio data
	const channels = [];
	for (let i = 0; i < numberOfChannels; i++) {
		channels.push(buffer.getChannelData(i));
	}

	let offset = 44;
	for (let i = 0; i < buffer.length; i++) {
		for (let channel = 0; channel < numberOfChannels; channel++) {
			const sample = Math.max(-1, Math.min(1, channels[channel][i]));
			view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
			offset += 2;
		}
	}

	return new Blob([arrayBuffer], { type: "audio/wav" });
}
