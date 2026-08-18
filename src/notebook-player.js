/**
 * Notebook-side player that embeds the REAL Tone.js player inside an iframe.
 *
 * The Jupyter/Observable frontend is a browser page — it has a DOM and can
 * run Tone.js. What it doesn't have is a way to `import` our library from
 * the Deno/Node kernel side. The trick: spawn an iframe whose `srcdoc`
 * loads Tone.js (from a URL the caller provides) and the jmon/algo ESM
 * source (from jsDelivr's GitHub mirror), then calls
 * `jm.play(composition, { Tone })`. Inside the iframe `env.isBrowser()`
 * is true, so `jm.play()` takes its **browser path** and spawns the full
 * music-player.js UI — no MIDI round-trip, no feature loss.
 *
 * ## Distribution
 *
 * jmon/algo is ESM-only and is not published to npm or JSR. The iframe
 * fetches the library straight from GitHub via jsDelivr:
 *
 *   https://cdn.jsdelivr.net/gh/jmonlabs/algo@main/src/index.js
 *
 * Pin to a tag (`@v1.1.0`) or a commit SHA if you need a stable version.
 *
 * ## Decoupling
 *
 * jmon/algo does not ship Tone.js. Just like `jm.score({toolkit})` requires
 * you to hand over a Verovio toolkit, `jm.play({Tone})` requires you to
 * hand over Tone:
 *
 *   - **Browser path:** `Tone` is a live module (e.g. `import * as Tone
 *     from "tone"`).
 *   - **Notebook path:** `Tone` is a **URL string** pointing at a Tone.js
 *     script (UMD or ESM). The iframe loads it in its own browser context,
 *     where it can create an AudioContext.
 *
 * If you don't want to retype the URL every time, alias it:
 *
 *   const ToneUrl = "https://cdn.jsdelivr.net/npm/tone@14.8.49/build/Tone.js";
 *   await jm.play(composition, { Tone: ToneUrl });
 */

const JMON_CDN_DEFAULT =
  "https://cdn.jsdelivr.net/gh/jmonlabs/algo@main/src/index.js";

/** HTML-escape a string for safe inclusion in an attribute value. */
function escapeAttr(html) {
  return html
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;");
}

/**
 * Build a notebook-embeddable player. Returns a MIME bundle whose
 * `text/html` content is an iframe that loads Tone.js (from a URL the
 * caller provides) plus the jmon/algo ESM source (from jsDelivr by
 * default), and spawns the full browser player inside.
 *
 * @param {Object} composition - The JMON composition
 * @param {Object} options
 * @param {string} options.Tone - **Required.** URL of a Tone.js script
 *   (UMD or ESM). The iframe loads it into its own browser context.
 *   Example: `"https://cdn.jsdelivr.net/npm/tone@14.8.49/build/Tone.js"`
 * @param {number} [options.height=160] - iframe height in pixels
 * @param {string} [options.bundleUrl] - Override the jmon ESM source URL.
 *   Defaults to `https://cdn.jsdelivr.net/gh/jmonlabs/algo@main/src/index.js`.
 *   Pin to `@v1.1.0` or a commit SHA for a stable version.
 * @param {boolean} [options.autoplay=false] - Start playback immediately
 * @returns {Object} MIME bundle: { text/html, text/plain }
 */
export function notebookPlayer(composition, options = {}) {
  const {
    Tone: toneUrl,
    height = 160,
    bundleUrl = JMON_CDN_DEFAULT,
    autoplay = false,
  } = options;

  if (typeof toneUrl !== "string" || toneUrl.length === 0) {
    throw new Error(
      "jm.play() in a notebook/headless context requires a Tone.js URL.\n" +
      "Pass it via the `Tone` option:\n" +
      "  await jm.play(composition, {\n" +
      '    Tone: "https://cdn.jsdelivr.net/npm/tone@14.8.49/build/Tone.js"\n' +
      "  });\n" +
      "(In a browser, `Tone` should be a live Tone.js module instead.)"
    );
  }

  // Extract options that make sense inside the iframe and drop anything
  // that can't be JSON-serialized (e.g. a Tone instance the caller passed
  // in for a browser use case — the iframe brings its own Tone).
  const safeOptions = JSON.stringify({
    autoplay,
  });
  const compositionJson = JSON.stringify(composition);

  // The iframe loads Tone.js via a classic <script> tag (Tone's UMD build
  // is what most CDNs serve), then loads jmon/algo as a real ES module
  // from jsDelivr and stashes it on `window.__jm` for the bootstrap code.
  const doc =
    `<!DOCTYPE html><html><head><meta charset="utf-8">` +
    `<style>` +
    `html,body{margin:0;padding:0;background:transparent;` +
    `font-family:system-ui,-apple-system,sans-serif}` +
    `#err{color:#ff6b6b;padding:8px;font-family:monospace;` +
    `font-size:12px;white-space:pre-wrap}` +
    `</style>` +
    `<script src="${toneUrl}"></script>` +
    `<script type="module">` +
    `import jm from "${bundleUrl}";` +
    `window.__jm = jm;` +
    `</script>` +
    `</head><body>` +
    `<div id="root"></div>` +
    `<script>` +
    `(async () => {` +
    `  const composition = ${compositionJson};` +
    `  const options = ${safeOptions};` +
    `  try {` +
    // Wait up to 10s for Tone and jm to show up (CDN scripts are async).
    `    const deadline = Date.now() + 10000;` +
    `    while ((!window.Tone || !window.__jm) && Date.now() < deadline) {` +
    `      await new Promise(r => setTimeout(r, 25));` +
    `    }` +
    `    if (!window.Tone) throw new Error("Tone.js failed to load from ${toneUrl}");` +
    `    if (!window.__jm) throw new Error("jmon/algo ESM failed to load from ${bundleUrl}");` +
    `    const api = window.__jm;` +
    `    if (!api || typeof api.play !== "function") {` +
    `      throw new Error("jm.play not found on loaded module");` +
    `    }` +
    `    const player = await api.play(composition, { Tone: window.Tone, ...options });` +
    `    const root = document.getElementById("root");` +
    `    root.innerHTML = "";` +
    `    root.appendChild(player);` +
    `  } catch (err) {` +
    `    const pre = document.createElement("pre");` +
    `    pre.id = "err";` +
    `    pre.textContent = (err && err.stack) || String(err);` +
    `    document.body.appendChild(pre);` +
    `  }` +
    `})();` +
    `</script></body></html>`;

  const html =
    `<iframe srcdoc="${escapeAttr(doc)}" ` +
    `style="width:100%;height:${height}px;border:none;display:block" ` +
    `sandbox="allow-scripts allow-same-origin"></iframe>`;

  return {
    "text/html": html,
    "text/plain": `[player: ${composition.tracks?.length || 0} track(s)]`,
  };
}
