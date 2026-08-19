# jmon/show

Hearing and seeing a JMON piece: playback, live coding, offline WAV
rendering, score engraving.

Everything in the JMON libraries that touches Web Audio or the DOM lives here,
and nowhere else does.

ESM source served from GitHub via jsDelivr, no build step, no dependencies.
Tone.js, `jmon/io` and `jmon/sound` are passed in.

## Use

```js
import jm    from "https://cdn.jsdelivr.net/gh/jmonlabs/algo@main/src/index.js";
import io    from "https://cdn.jsdelivr.net/gh/jmonlabs/io@main/src/index.js";
import show  from "https://cdn.jsdelivr.net/gh/jmonlabs/show@main/src/index.js";
import sound from "https://cdn.jsdelivr.net/gh/jmonlabs/sound@main/src/index.js";
import * as Tone from "npm:tone";
import verovio from "npm:verovio/wasm";
import { VerovioToolkit } from "npm:verovio";
```

```js
show.play(piece, { Tone, io, sound });

// These two render before they can hand back anything, so both are promises.
await show.score(piece, { io, verovio, VerovioToolkit });
await show.wav(piece, { Tone, io, sound, filename: "piece.wav" });
```

Alongside the other three, [`jmon/studio`](https://github.com/jmonlabs/studio)
assembles all four and binds the injections, so these become `jm.play(piece)`,
`jm.score(piece)` and `jm.wav(piece)`.

## Why things are passed in

Node refuses `https://` imports, and these modules are tested under Node. So a
package here can depend on another only by receiving it, never by importing
it. The constraint turned out to be a good rule: what a call needs is visible
at the call site.

**`io` is required.** Reading a piece is its job: what a `tempoMap` does
to a beat position, what an articulation compiles to, how an automation target
resolves. Without it a piece would still play, but its tempo map, articulations
and automation would be dropped in silence, so `show` refuses instead and says
what is missing.

**`sound` is optional.** Without it a track asking for a General MIDI program
falls back to a synth: audible and in time, but not the instrument that was
written. One warning, not one per track.

**Tone.js is required for anything audible**, and Verovio for a score.

## What is here

| | |
|---|---|
| `show.play` | a player element. Schedules in seconds, follows the tempo map, ramps automation, applies articulations. |
| `show.score` | Verovio engraving, via `io.musicxml`. |
| `show.wav` | offline rendering through `Tone.Offline`, using the same synth factory as the player, so the file matches what you heard. |
| `src/live/` | the live-coding iframe player. Schedules in transport ticks and swaps patterns at a loop or bar boundary. Unlike the rest, it fetches Tone, io and sound by URL itself, because it is an application rather than a library. |
| `live/` | the REPL page that hosts `src/live/`'s player in an iframe: an editor, a `send()`/`postMessage` bridge, Web MIDI output. Deployed at [jmonlabs.github.io/live](https://jmonlabs.github.io/live/), not from this repo's own Pages. |
| `show.master` | mastering chains: `dark`, `light`, `warm`, `cinematic`, `intimate`, `broadcast`, `vinyl`, `lush`. |

## The other packages

| | |
|---|---|
| [`jmon/algo`](https://github.com/jmonlabs/algo) | composes. Scales, processes, walks, rhythm, analysis. Imports nothing. |
| [`jmon/io`](https://github.com/jmonlabs/io) | the format: what it means, and how it serialises. MIDI both ways, MusicXML. Imports nothing. |
| [`jmon/sound`](https://github.com/jmonlabs/sound) | sampled instruments for Tone.js. Imports nothing. |

## Tests

The tests run against the real `jmon/io`, checked out beside this repo. A
vendored copy would drift, which is the problem the split exists to avoid, and
a stub would test the stub.

```bash
git clone https://github.com/jmonlabs/io ../io
node --test tests/*.test.js
```

36 tests, driven against a recording Tone.js: no browser, no audio, no
network. What they assert is what the player *asks* Tone to do — when a note is
placed, how a tempo map shifts it, whether automation reaches a parameter.

## License

GPL-3.0-or-later
