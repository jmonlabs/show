import { tonejs } from "./tonejs.js";
import { requireFormat } from "./format.js";
import { SYNTHESIZER_TYPES, ALL_EFFECTS } from "./audio/effects.js";
import { normalizeAudioGraph } from "./audio/normalize.js";
import {
  applyPitchAnchors,
  createGlideVoice,
  createTrackSynth,
  hasDetuneParam,
  resolveConnectTarget,
  resolveSynthPreset,
} from "./synth-factory.js";

/**
 * Simplified Music Player - Just playback with articulations
 * No synth selectors, no downloads - focus on playing JMON compositions
 */
export function createPlayer(composition, options = {}) {
  if (!composition) {
    throw new Error("Invalid composition");
  }

  // Normalize: wrap a plain array of MIDI pitches or note objects into a composition
  if (Array.isArray(composition)) {
    const notes = composition.map((item, i) =>
      typeof item === "number"
        ? { pitch: item, duration: 1, time: i }
        : { time: i, duration: 1, ...item }
    );
    composition = { tracks: [{ notes }], tempo: 120 };
  }

  if (typeof composition !== "object") {
    throw new Error("Invalid composition");
  }

  const { Tone: externalTone = null, autoplay = false, sound = null, io = null } = options;

  // Reading the composition is jmon/io's job; this package receives it.
  const fmt = requireFormat(io);

  // Normalize composition structure
  const tracks = composition.tracks || composition.sequences || [];
  if (!Array.isArray(tracks)) {
    throw new Error("Tracks must be an array");
  }

  const tempo = composition.tempo || composition.bpm || 120;

  // Convert JMON to Tone.js format
  const convertedData = tonejs(composition, {});
  const { tracks: convertedTracks, metadata } = convertedData;
  const totalDuration = metadata.totalDuration;

  // Keep reference to original tracks for compiling articulations
  const originalTracksSource = tracks;

  // Audio state
  let isPlaying = false;
  let isBusy = false; // re-entry guard for async operations
  let currentTime = 0;
  let animationId = null;
  let scheduledEvents = [];

  // Persistent audio objects — created once, reused across seek/play cycles
  let ToneLib = null;
  let masterGain = null;
  let trackConfigs = []; // [{synth, vibratoEffect, tremoloEffect, modulations, partEvents, secondsPerQN}]
  let tempoPlan = null;     // { segments, toSeconds } — set when audio starts
  let graphNodesRef = {};   // audioGraph nodes, for automation targets
  let activeSynths = []; // all disposable audio nodes

  // Create UI container
  const container = document.createElement("div");
  container.style.cssText = `
    font-family: Arial, sans-serif;
    background: #464646;
    color: #fff;
    padding: 12px;
    border-radius: 8px;
    max-width: 800px;
    margin: 16px 0;
  `;

  // Controls row: [Play] [Stop] [Current Time] [========Timeline========] [Total Time]
  const controlsRow = document.createElement("div");
  controlsRow.style.cssText = `
    display: flex;
    align-items: center;
    gap: 12px;
  `;

  const buttonStyle = `
    background: #000000;
    border: none;
    color: white;
    padding: 8px 16px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 14px;
    white-space: nowrap;
  `;

  const playButton = document.createElement("button");
  playButton.textContent = "▶ Play";
  playButton.style.cssText = buttonStyle;

  const stopButton = document.createElement("button");
  stopButton.textContent = "⏹ Stop";
  stopButton.style.cssText = buttonStyle;
  stopButton.disabled = true;

  const currentTimeDisplay = document.createElement("div");
  currentTimeDisplay.textContent = "0:00";
  currentTimeDisplay.style.cssText = `
    font-size: 14px;
    color: #aaa;
    min-width: 40px;
  `;

  // Timeline progress bar
  const timeline = document.createElement("div");
  timeline.style.cssText = `
    flex: 1;
    height: 8px;
    background: #efefef;
    border-radius: 4px;
    cursor: pointer;
    position: relative;
  `;

  const timelineProgress = document.createElement("div");
  timelineProgress.style.cssText = `
    height: 100%;
    background: #959595;
    border-radius: 4px;
    width: 0%;
    transition: width 0.1s linear;
  `;
  timeline.appendChild(timelineProgress);

  const totalTimeDisplay = document.createElement("div");
  totalTimeDisplay.textContent = "0:00";
  totalTimeDisplay.style.cssText = `
    font-size: 14px;
    color: #aaa;
    min-width: 40px;
    text-align: right;
  `;

  controlsRow.appendChild(playButton);
  controlsRow.appendChild(stopButton);
  controlsRow.appendChild(currentTimeDisplay);
  controlsRow.appendChild(timeline);
  controlsRow.appendChild(totalTimeDisplay);
  container.appendChild(controlsRow);

  // Format time helper
  function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  // Update display
  totalTimeDisplay.textContent = formatTime(totalDuration);

  // Update timeline display
  function updateTimeline() {
    if (!ToneLib?.Transport) return;

    currentTime = ToneLib.Transport.seconds;
    const progress = (currentTime / totalDuration) * 100;
    timelineProgress.style.width = `${Math.min(progress, 100)}%`;
    currentTimeDisplay.textContent = formatTime(currentTime);

    if (isPlaying && currentTime < totalDuration) {
      animationId = requestAnimationFrame(updateTimeline);
    } else if (currentTime >= totalDuration) {
      stop();
    }
  }

  // ── Build synths and effects (expensive — done once) ─────────────
  async function buildSynths() {
    ToneLib = externalTone || window.Tone;

    // Normalize flat ESM exports to namespace shape expected by this player.
    // When Tone is loaded via ESM (e.g. jsdelivr +esm), Transport is not a
    // property of the module object — use getTransport() to retrieve it.
    if (ToneLib && !ToneLib.Transport && typeof ToneLib.getTransport === 'function') {
      ToneLib = {
        Transport: ToneLib.getTransport(),
        start: ToneLib.start,
        loaded: ToneLib.loaded,
        Frequency: ToneLib.Frequency,
        Gain: ToneLib.Gain,
        Limiter: ToneLib.Limiter,
        Sampler: ToneLib.Sampler,
        PolySynth: ToneLib.PolySynth,
        MonoSynth: ToneLib.MonoSynth,
        Vibrato: ToneLib.Vibrato,
        Tremolo: ToneLib.Tremolo,
      };
    }

    if (!ToneLib) {
      // Try ESM import first — works in Observable and sandboxed environments
      // where script tag injection is blocked.
      try {
        ToneLib = await import("https://cdn.jsdelivr.net/npm/tone@14.8.49/+esm");
      } catch {
        // Fall back to UMD script tag (standard browser pages)
        await new Promise((resolve, reject) => {
          const script = document.createElement("script");
          script.src = "https://cdn.jsdelivr.net/npm/tone@14.8.49/build/Tone.js";
          script.onload = () => { ToneLib = window.Tone; resolve(); };
          script.onerror = reject;
          document.head.appendChild(script);
        });
      }
    }

    if (!ToneLib) throw new Error("Failed to load Tone.js");
    window.Tone = ToneLib;

    await ToneLib.start();
    ToneLib.Transport.bpm.value = tempo;

    // Dispose previous audio objects
    disposeAudio();

    // No master chain added by the player — the live path mirrors the WAV
    // exactly. Tracks/audioGraph nodes route to Tone.Destination through the
    // same rules as wav.js. Users wanting limiting or gain reduction should
    // add the relevant nodes to their audioGraph.
    masterGain = ToneLib.Destination;

    // Normalize audioGraph format
    normalizeAudioGraph(composition);

    // Build audioGraph nodes if present
    const graphNodes = {};
    graphNodesRef = graphNodes;
    if (composition.audioGraph && Array.isArray(composition.audioGraph)) {
      composition.audioGraph.forEach(({ id, type, options: opts = {} }) => {
        if (!id || !type) return;
        if (type === 'Destination') { graphNodes[id] = ToneLib.Destination; return; }
        try {
          if (SYNTHESIZER_TYPES.includes(type) || ALL_EFFECTS.includes(type)) {
            graphNodes[id] = new ToneLib[type](opts);
            activeSynths.push(graphNodes[id]);
          }
        } catch (e) {
          console.warn(`[AUDIOGRAPH] Failed to create ${type}:`, e);
        }
      });

      composition.audioGraph.forEach(({ id, target }) => {
        if (!id || !graphNodes[id] || graphNodes[id] === ToneLib.Destination) return;
        const node = graphNodes[id];
        if (target && graphNodes[target]) {
          if (graphNodes[target] === ToneLib.Destination) {
            node.toDestination();
          } else {
            node.connect(graphNodes[target]);
          }
        } else {
          node.toDestination();
        }
      });
    }

    // A tempo map means each beat sits at its own rate, so a single
    // secondsPerQN cannot place events — the map has to be integrated.
    // With no tempoMap this collapses to `beats * 60 / tempo`.
    const segments = fmt.tempoSegments(composition);
    const toSeconds = (beats) => fmt.beatsToSeconds(beats, segments);
    tempoPlan = { segments, toSeconds };
    const secondsPerQN = 60 / tempo;

    // Let the sampled-instrument provider settle where its samples come from
    // before any instrument is built. No provider, no work.
    if (typeof sound?.prepare === "function") {
      await sound.prepare(
        originalTracksSource.map((t) => resolveSynthPreset(t && t.synth, composition.customPresets)),
      );
    }

    // Build per-track configs
    trackConfigs = convertedTracks.map((trackConfig) => {
      const { originalTrackIndex, partEvents } = trackConfig;
      const originalTrack = originalTracksSource[originalTrackIndex] || {};

      // Compile articulations
      let modulations = [];
      try {
        const compiled = fmt.compileEvents(originalTrack);
        modulations = compiled.modulations || [];
      } catch (e) {
        console.warn("Failed to compile articulations:", e);
      }

      // Synth + routing via the shared factory (kept identical to wav.js)
      const synthRef = originalTrack.synthRef;
      const implicitSynthId = (composition.audioGraph || []).find(
        n => SYNTHESIZER_TYPES.includes(n.type)
      )?.id;
      const sharedSynthId = synthRef || implicitSynthId;
      const sharedSynth = sharedSynthId ? graphNodes[sharedSynthId] : null;

      const connectTarget = resolveConnectTarget(
        originalTrack,
        sharedSynth ? null : composition.audioGraph,
        graphNodes,
        masterGain,
      );

      const { synth, isShared } = createTrackSynth(
        originalTrack, ToneLib, sharedSynth, composition.customPresets, sound,
      );
      if (!isShared) synth.connect(connectTarget);

      activeSynths.push(synth);

      // Vibrato / tremolo effects
      const vibratoMods = modulations.filter(m => m.type === "pitch" && m.subtype === "vibrato");
      const tremoloMods = modulations.filter(m => m.type === "amplitude" && m.subtype === "tremolo");

      let vibratoEffect = null;
      let tremoloEffect = null;

      if (vibratoMods.length > 0 || tremoloMods.length > 0) {
        if (!isShared) synth.disconnect();

        if (vibratoMods.length > 0) {
          const dv = vibratoMods[0];
          vibratoEffect = new ToneLib.Vibrato({ frequency: dv.rate || 5, depth: (dv.depth || 50) / 100 });
          vibratoEffect.wet.value = 0;
          activeSynths.push(vibratoEffect);
        }

        if (tremoloMods.length > 0) {
          const dt = tremoloMods[0];
          tremoloEffect = new ToneLib.Tremolo({ frequency: dt.rate || 8, depth: dt.depth || 0.3 }).start();
          tremoloEffect.wet.value = 0;
          activeSynths.push(tremoloEffect);
        }

        if (vibratoEffect && tremoloEffect) {
          synth.connect(vibratoEffect);
          vibratoEffect.connect(tremoloEffect);
          tremoloEffect.connect(connectTarget);
        } else if (vibratoEffect) {
          synth.connect(vibratoEffect);
          vibratoEffect.connect(connectTarget);
        } else if (tremoloEffect) {
          synth.connect(tremoloEffect);
          tremoloEffect.connect(connectTarget);
        }
      }

      // Pitch curves (glissando/portamento/bend/envelope) ramp the synth's
      // detune signal. PolySynth and Sampler have none, so those tracks get
      // one dedicated glide voice, routed through the same chain as the
      // track synth so the timbre and effects match.
      let glideVoice = null;
      const hasPitchCurves = modulations.some(
        (m) => m.type === "pitch" && Array.isArray(m.anchors) && m.anchors.length > 0
      );
      if (hasPitchCurves && !hasDetuneParam(synth)) {
        glideVoice = createGlideVoice(originalTrack, ToneLib);
        if (glideVoice) {
          glideVoice.connect(vibratoEffect || tremoloEffect || connectTarget);
          activeSynths.push(glideVoice);
        }
      }

      // Looping a sample's sustain is right for strings, organ and pads and
      // wrong for anything that decays; analyseSustain decides per buffer.
      // `loopSustain: false` on the track's synth opts out entirely.
      const trackSynthSpec = originalTrack.synth;
      const loopSustain = !(
        trackSynthSpec && typeof trackSynthSpec === "object"
        && trackSynthSpec.loopSustain === false
      );

      return {
        synth, glideVoice, vibratoEffect, tremoloEffect,
        modulations, partEvents, secondsPerQN, loopSustain,
      };
    });

    // Wait for all samplers to finish loading
    await ToneLib.loaded();
  }

  // ── Schedule events on the transport (cheap — redo on seek) ──────
  /**
   * Follow the composition's tempoMap.
   *
   * Event times are already integrated through the map, so this exists so that
   * Tone's own musical-time parsing (note-value durations, ramp times) and any
   * transport-position readout agree with what is being heard.
   */
  function scheduleTempoChanges(toSeconds) {
    const segments = tempoPlan?.segments;
    if (!segments || segments.length <= 1) return;

    for (const segment of segments) {
      if (segment.time === 0) {
        ToneLib.Transport.bpm.value = segment.tempo;
        continue;
      }
      scheduledEvents.push(ToneLib.Transport.schedule(() => {
        ToneLib.Transport.bpm.value = segment.tempo;
      }, toSeconds(segment.time)));
    }
  }

  /**
   * Follow the composition's timeSignatureMap.
   *
   * Note placement is unaffected — JMON times are quarter notes, which do not
   * depend on the metre. What this fixes is everything that reads the
   * transport's musical position: bars:beats:ticks readouts, and any Tone
   * musical-time value resolved during playback.
   */
  function scheduleTimeSignatureChanges(toSeconds) {
    const segments = fmt.timeSignatureSegments(composition);
    if (segments.length === 0) return;

    for (const segment of segments) {
      const value = [segment.numerator, segment.denominator];
      if (segment.time === 0) {
        ToneLib.Transport.timeSignature = value;
        continue;
      }
      scheduledEvents.push(ToneLib.Transport.schedule(() => {
        ToneLib.Transport.timeSignature = value;
      }, toSeconds(segment.time)));
    }
  }

  /**
   * Follow the composition's `automation` channels.
   *
   * A target names a parameter: `"reverb.wet"` addresses a node in the
   * audioGraph, `"track.lead.volume"` a track's own chain, and `"tempo"` the
   * transport. `"midi.cc*"` targets are skipped — this is the audio path, and
   * a control change has no meaning here.
   *
   * Points ramp linearly from one to the next, which is what an automation
   * lane draws between two anchors.
   */
  function scheduleAutomation(toSeconds) {
    const channels = fmt.automationChannels(composition);
    if (channels.length === 0) return;

    for (const channel of channels) {
      let parsed = fmt.parseAutomationTarget(channel.target);
      let range;
      if (parsed.kind === "midi") {
        // A control change means nothing on the audio path by itself.
        // converterHints.tone says what it should drive.
        const hint = fmt.resolveCcHint(parsed.cc, composition);
        if (!hint) continue;
        parsed = hint;
        range = hint.range;
      }

      const param = resolveAutomationParam(parsed, channel);
      if (!param) {
        console.warn(`[AUTOMATION] Unresolved target: ${channel.target}`);
        continue;
      }

      channel.points.forEach((point, i) => {
        const at = toSeconds(point.time);
        scheduledEvents.push(ToneLib.Transport.schedule((audioTime) => {
          const previous = channel.points[i - 1];
          const rampSeconds = previous ? at - toSeconds(previous.time) : 0;
          const value = fmt.scaleToRange(point.value, range);
          if (rampSeconds > 0 && typeof param.linearRampToValueAtTime === "function") {
            param.linearRampToValueAtTime(value, audioTime + rampSeconds);
          } else if (typeof param.setValueAtTime === "function") {
            param.setValueAtTime(value, audioTime);
          } else {
            param.value = value;
          }
        }, at));
      });
    }
  }

  /** Map a parsed automation target onto a Tone parameter, or null. */
  function resolveAutomationParam(parsed, channel) {
    if (parsed.kind === "tempo") return ToneLib.Transport.bpm;

    if (parsed.kind === "track") {
      const label = parsed.node || channel.trackId;
      const index = (composition.tracks || []).findIndex(
        (track, i) => (track.label ?? `track ${i}`) === label,
      );
      const synth = index >= 0 ? trackConfigs[index]?.synth : undefined;
      return synth?.[parsed.param] ?? null;
    }

    const node = graphNodesRef[parsed.node];
    return node?.[parsed.param] ?? null;
  }

  function scheduleNotes() {
    clearScheduledEvents();

    // tempoPlan is filled in when the audio graph is built. Before that, fall
    // back to the flat rate so a call arriving early still places events.
    const toSeconds = tempoPlan
      ? tempoPlan.toSeconds
      : (beats) => beats * 60 / tempo;

    scheduleTempoChanges(toSeconds);
    scheduleTimeSignatureChanges(toSeconds);
    scheduleAutomation(toSeconds);

    trackConfigs.forEach(({ synth, glideVoice, vibratoEffect, tremoloEffect, modulations, partEvents, secondsPerQN, loopSustain }) => {
      // Schedule vibrato/tremolo enable/disable
      modulations.forEach((mod) => {
        const startTime = toSeconds(mod.start);
        const endTime = toSeconds(mod.end);

        if (mod.type === "pitch" && mod.subtype === "vibrato" && vibratoEffect) {
          scheduledEvents.push(ToneLib.Transport.schedule(() => {
            vibratoEffect.frequency.value = mod.rate || 5;
            vibratoEffect.depth.value = (mod.depth || 50) / 100;
            vibratoEffect.wet.value = 1;
          }, startTime));
          scheduledEvents.push(ToneLib.Transport.schedule(() => {
            vibratoEffect.wet.value = 0;
          }, endTime));
        }

        if (mod.type === "amplitude" && mod.subtype === "tremolo" && tremoloEffect) {
          scheduledEvents.push(ToneLib.Transport.schedule(() => {
            tremoloEffect.frequency.value = mod.rate || 8;
            tremoloEffect.depth.value = mod.depth || 0.3;
            tremoloEffect.wet.value = 1;
          }, startTime));
          scheduledEvents.push(ToneLib.Transport.schedule(() => {
            tremoloEffect.wet.value = 0;
          }, endTime));
        }
      });

      // Build modulation lookup by note index
      const modsByNote = {};
      modulations.forEach((mod) => {
        if (!modsByNote[mod.index]) modsByNote[mod.index] = [];
        modsByNote[mod.index].push(mod);
      });

      // Schedule notes
      partEvents.forEach((note, noteIndex) => {
        // A rest is silence. Scheduling one reached the synth as
        // triggerAttackRelease(null, ...), which is at best a wasted event.
        if (note.pitch === null || note.pitch === undefined) return;

        const time = typeof note.time === "number" ? toSeconds(note.time) : note.time;
        // A duration spans from the note's own onset, so it is the difference
        // between two integrated positions, not a scaled length.
        const duration = typeof note.duration === "number" && typeof note.time === "number"
          ? toSeconds(note.time + note.duration) - toSeconds(note.time)
          : note.duration;
        const velocity = note.velocity || 0.8;
        const mods = modsByNote[noteIndex] || [];

        // Unified pitch curve: glissando, portamento, bend, and pitch
        // envelopes all compile to the same anchors representation.
        const pitchCurve = mods.find(
          (m) => m.type === "pitch" && Array.isArray(m.anchors) && m.anchors.length > 0
        );

        // Handle chords
        if (Array.isArray(note.pitch)) {
          const mt = note.microtuning || 0;
          const chordNotes = note.pitch.map((p) =>
            typeof p === "number"
              ? (mt ? ToneLib.Frequency(p + mt, "midi").toFrequency() : ToneLib.Frequency(p, "midi").toNote())
              : p
          );
          scheduledEvents.push(ToneLib.Transport.schedule((t) => {
            synth.triggerAttackRelease(chordNotes, duration, t, velocity);
          }, time));
          return;
        }

        // Convert pitch to note name
        const noteName = typeof note.pitch === "number"
          ? ToneLib.Frequency(note.pitch, "midi").toNote()
          : note.pitch;

        // Handle pitch curves. Three ways, in order of how much of the
        // track's own sound they keep:
        //   1. the synth's own `detune` Signal — mono synths;
        //   2. resampling the instrument's sounding voices — Sampler, which
        //      has no detune but does keep automatable buffer sources;
        //   3. the track's dedicated glide voice — PolySynth, which has
        //      neither, so the slide moves to a stand-in routed through the
        //      same effect chain.
        if (pitchCurve && (hasDetuneParam(synth) || sound?.bendVoices || glideVoice)) {
          const microtuningCents = (note.microtuning || 0) * 100;
          // Anchor times are absolute beats; rebase to the note start.
          const anchorsSec = pitchCurve.anchors.map((a) => ({
            time: (a.time - pitchCurve.start) * secondsPerQN,
            value: a.value,
          }));

          if (hasDetuneParam(synth)) {
            scheduledEvents.push(ToneLib.Transport.schedule((t) => {
              applyPitchAnchors(synth.detune, t, anchorsSec, microtuningCents);
              synth.triggerAttackRelease(noteName, duration, t, velocity);
            }, time));
          } else if (sound?.bendVoices) {
            // The voices only exist once the note has been triggered, so
            // attack and release are separate here.
            const midi = typeof note.pitch === "number"
              ? note.pitch
              : ToneLib.Frequency(noteName).toMidi();

            scheduledEvents.push(ToneLib.Transport.schedule((t) => {
              synth.triggerAttack(noteName, t, velocity);
              const slid = sound.bendVoices(synth, midi, t, anchorsSec, microtuningCents);
              if (loopSustain) sound.holdVoices?.(synth, midi, t, duration);
              synth.triggerRelease(noteName, t + duration);
              // If Tone moved `_activeSources` the note still sounds, just
              // without the slide — the glide voice is the safety net.
              if (!slid && glideVoice) {
                applyPitchAnchors(glideVoice.detune, t, anchorsSec, microtuningCents);
                glideVoice.triggerAttackRelease(noteName, duration, t, velocity);
              }
            }, time));
          } else {
            scheduledEvents.push(ToneLib.Transport.schedule((t) => {
              applyPitchAnchors(glideVoice.detune, t, anchorsSec, microtuningCents);
              glideVoice.triggerAttackRelease(noteName, duration, t, velocity);
            }, time));
          }
        } else {
          // Normal note — apply microtuning by converting to frequency
          const playNote = note.microtuning
            ? ToneLib.Frequency(note.pitch + note.microtuning, "midi").toFrequency()
            : noteName;

          scheduledEvents.push(ToneLib.Transport.schedule((t) => {
            synth.triggerAttackRelease(playNote, duration, t, velocity);
            // A sampled instrument's recording is finite; the provider loops
            // its sustain so a long note does not end in silence.
            if (loopSustain && typeof note.pitch === "number") {
              sound?.holdVoices?.(synth, note.pitch, t, duration);
            }
          }, time));
        }
      });
    });
  }

  // ── Clear scheduled transport events ─────────────────────────────
  function clearScheduledEvents() {
    if (ToneLib) {
      ToneLib.Transport.cancel(0);
    }
    scheduledEvents = [];
  }

  // ── Dispose all audio objects ────────────────────────────────────
  function disposeAudio() {
    clearScheduledEvents();
    activeSynths.forEach(s => {
      try { if (!s.disposed) s.dispose(); } catch (e) { /* already gone */ }
    });
    activeSynths = [];
    trackConfigs = [];
    masterGain = null;
  }

  // ── Play / Pause ─────────────────────────────────────────────────
  async function play() {
    if (isBusy) return;

    if (isPlaying) {
      // Pause
      ToneLib.Transport.pause();
      isPlaying = false;
      playButton.textContent = "▶ Play";
      cancelAnimationFrame(animationId);
      return;
    }

    isBusy = true;
    playButton.textContent = "... Wait";
    playButton.disabled = true;

    try {
      // Build synths if needed (first play or after stop)
      if (trackConfigs.length === 0) {
        await buildSynths();
      }

      // Schedule notes fresh (handles seek position)
      scheduleNotes();

      // Start transport from current position
      ToneLib.Transport.stop();
      ToneLib.Transport.start("+0.05", currentTime);

      isPlaying = true;
      playButton.textContent = "⏸ Pause";
      stopButton.disabled = false;
      updateTimeline();
    } catch (e) {
      console.error("[PLAYER] Play failed:", e);
      playButton.textContent = "▶ Play";
    } finally {
      isBusy = false;
      playButton.disabled = false;
    }
  }

  // ── Stop ─────────────────────────────────────────────────────────
  function stop() {
    if (ToneLib) {
      ToneLib.Transport.stop();
    }
    disposeAudio();

    isPlaying = false;
    currentTime = 0;
    playButton.textContent = "▶ Play";
    stopButton.disabled = true;
    timelineProgress.style.width = "0%";
    currentTimeDisplay.textContent = "0:00";
    cancelAnimationFrame(animationId);
  }

  // ── Timeline seek ────────────────────────────────────────────────
  timeline.addEventListener("click", async (e) => {
    if (isBusy) return;

    const rect = timeline.getBoundingClientRect();
    const percent = (e.clientX - rect.left) / rect.width;
    const newTime = Math.max(0, Math.min(percent * totalDuration, totalDuration));

    // Update UI immediately
    timelineProgress.style.width = `${percent * 100}%`;
    currentTimeDisplay.textContent = formatTime(newTime);
    currentTime = newTime;

    if (isPlaying && ToneLib) {
      // Reschedule and restart from new position — no teardown needed
      isBusy = true;
      try {
        ToneLib.Transport.pause();
        scheduleNotes();
        ToneLib.Transport.start("+0.05", newTime);
        updateTimeline();
      } finally {
        isBusy = false;
      }
    }
  });

  // Button event listeners
  playButton.addEventListener("click", play);
  stopButton.addEventListener("click", stop);

  // Autoplay if requested
  if (autoplay) {
    play().catch(console.error);
  }

  return container;
}
