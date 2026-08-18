// The WAV renderer shares its pitch-curve pipeline with the live player:
// PerformanceCompiler anchors (see jmon-glissando-validation.test.js) applied
// through applyPitchAnchors/createGlideVoice (see player-glissando.test.js).
// Offline rendering itself requires Tone.Offline and is exercised in-browser.
