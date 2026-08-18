/**
 * Headless score rendering.
 *
 * Pure, DOM-free Verovio wrapper that turns a JMON composition into
 * an SVG string (plus optional MEI and MusicXML). Safe to import from
 * Node, Deno, JSR, and notebook kernels — contains no browser globals.
 *
 * The browser-facing DOM wrapper lives in `./score-renderer.js` and
 * delegates to `scoreSVG()` below.
 *
 * Turning a composition into MusicXML is `jmon/io`'s job, so it is passed
 * in as `options.io` rather than imported: Node refuses `https://` imports.
 */

import { requireFormat } from "./format.js";

// Verovio is intentionally NOT imported statically. We're shipped as ESM
// source via jsDelivr, where the bare specifiers `verovio/wasm` and
// `verovio/esm` don't resolve — and we don't want loading `jm` to fail
// in environments that never call `jm.score()`. The fallback path below
// uses dynamic import() inside `loadBundledToolkit` so resolution only
// happens on demand.
//
// We load Verovio's ESM build (.mjs), NOT the `verovio-toolkit-wasm.js`
// bundle. That bundle is UMD: importing it as a module yields an empty
// namespace (it only assigns `globalThis.verovio`), so `default.toolkit`
// is undefined. The .mjs entry points export the module factory and the
// `VerovioToolkit` class directly, which is what we need.
const VEROVIO_ESM_MODULE_URL =
  "https://cdn.jsdelivr.net/npm/verovio@5.6.0/dist/verovio-module.mjs";
const VEROVIO_ESM_TOOLKIT_URL =
  "https://cdn.jsdelivr.net/npm/verovio@5.6.0/dist/verovio.mjs";

/**
 * Replace Verovio's fixed pixel `width`/`height` attributes with a
 * percentage `width="100%"` attribute. The viewBox is left untouched so
 * the browser computes height proportionally. This is the standard
 * responsive-SVG pattern: the caller's container decides the width, the
 * SVG stretches to fill it, and height follows the viewBox aspect ratio.
 *
 * Using `width="100%"` as an SVG attribute (not a CSS style) is more
 * reliable across embedding hosts — some Jupyter CSS resets suppress
 * CSS widths on SVG elements inside output containers, but the attribute
 * is always respected.
 */
function makeResponsiveSvg(svg) {
  // Only the first <svg> tag (the root). Nested SVGs (unusual in Verovio
  // output but possible) are left alone.
  return svg
    .replace(/(<svg\b[^>]*?)\s+width="[^"]*"/i, "$1")
    .replace(/(<svg\b[^>]*?)\s+height="[^"]*"/i, "$1")
    .replace(/<svg\b/, '<svg width="100%"');
}

/**
 * Resolve a value that might be a function, a default-export namespace,
 * or an ES module namespace with a named export. Verovio ships both
 * shapes depending on which entry point you import.
 */
function resolveVerovioExport(val) {
  if (typeof val === "function") return val;
  if (!val) return val;
  return val.default ?? val.VerovioToolkit ?? val;
}

/**
 * Wrap a promise with a timeout. Rejects with a descriptive error if the
 * wrapped promise hasn't settled in `ms` milliseconds. Used to guard the
 * Verovio WASM init step, which can silently hang in some Deno + `npm:`
 * configurations when the Emscripten loader can't locate its .wasm binary.
 */
function withTimeout(promise, ms, label) {
  if (!ms || ms <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(
        `${label} timed out after ${ms}ms. This usually means Verovio's ` +
        `WASM loader could not fetch its .wasm binary — common under Deno's ` +
        `npm: compat layer. Try passing Verovio's ESM build explicitly: ` +
        `const verovio = (await import("https://cdn.jsdelivr.net/npm/verovio@5.6.0/dist/verovio-module.mjs")).default; ` +
        `const { VerovioToolkit } = await import("https://cdn.jsdelivr.net/npm/verovio@5.6.0/dist/verovio.mjs"); ` +
        `jm.score(comp, { verovio, VerovioToolkit })`
      ));
    }, ms);
  });
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    timeout,
  ]);
}

// Fallback toolkit loader used when the caller didn't pass a
// `toolkit` or `{verovio, VerovioToolkit}` pair. Cached across calls so
// repeated `jm.score()` invocations don't re-run WASM init.
//
// Resolution order, picking the first that succeeds:
//   1. Dynamic import of the `verovio` npm package (Node/Deno with
//      node_modules) — gets us the same shape as the original static
//      `import "verovio/wasm" + "verovio/esm"` pair.
//   2. Dynamic import of the Verovio CDN bundle — works in browsers
//      and any runtime that resolves HTTPS module URLs (i.e. all
//      browser-side jmon/algo loads from jsDelivr).
let _bundledToolkitPromise = null;

function loadBundledToolkit(timeoutMs) {
  if (_bundledToolkitPromise) return _bundledToolkitPromise;
  _bundledToolkitPromise = withTimeout(
    (async () => {
      // Try the npm package first (works under Node/Deno).
      try {
        const wasmMod = await import("verovio/wasm");
        const esmMod = await import("verovio/esm");
        const factory = resolveVerovioExport(wasmMod.default ?? wasmMod);
        const Toolkit = resolveVerovioExport(
          esmMod.VerovioToolkit ?? esmMod.default ?? esmMod
        );
        const VerovioModule = await Promise.resolve(factory());
        return new Toolkit(VerovioModule);
      } catch {
        // Fall through to the CDN ESM build.
      }
      // Browser / HTTPS-module runtimes (incl. jsDelivr-loaded jmon/algo):
      // load Verovio's ESM build from a CDN. Same shape as the npm path —
      // a module factory plus the VerovioToolkit class.
      const wasmMod = await import(VEROVIO_ESM_MODULE_URL);
      const esmMod = await import(VEROVIO_ESM_TOOLKIT_URL);
      const factory = resolveVerovioExport(wasmMod.default ?? wasmMod);
      const Toolkit = resolveVerovioExport(
        esmMod.VerovioToolkit ?? esmMod.default ?? esmMod
      );
      const VerovioModule = await Promise.resolve(factory());
      return new Toolkit(VerovioModule);
    })(),
    timeoutMs,
    "Verovio WASM init"
  ).catch((e) => {
    _bundledToolkitPromise = null;
    throw e;
  });
  return _bundledToolkitPromise;
}

/**
 * Build a Verovio toolkit instance from whatever the caller passed in.
 *
 * Resolution order:
 *   1. `toolkit` — caller supplied a pre-built instance
 *   2. `verovio` + `VerovioToolkit` — caller supplied factory + class
 *   3. Auto-load the Verovio CDN bundle (works wherever dynamic
 *      `import()` of an HTTPS URL is supported — i.e. browsers and
 *      anything that follows the WHATWG module loader spec)
 */
async function resolveToolkit({ toolkit, verovio, VerovioToolkit, timeoutMs }) {
  if (toolkit) return toolkit;
  if (verovio && VerovioToolkit) {
    const factory = resolveVerovioExport(verovio);
    const Toolkit = resolveVerovioExport(VerovioToolkit);
    const VerovioModule = await withTimeout(
      Promise.resolve(factory()),
      timeoutMs,
      "Verovio WASM initialization"
    );
    return new Toolkit(VerovioModule);
  }
  return loadBundledToolkit(timeoutMs);
}

/**
 * Render a JMON composition to SVG with no DOM dependency.
 *
 * @param {Object} composition - The JMON composition to render
 * @param {Object} options - Rendering options
 * @param {Function|Object} [options.verovio] - Verovio WASM module factory
 *   (e.g. `import verovio from "npm:verovio@5.6.0/wasm"`)
 * @param {Function|Object} [options.VerovioToolkit] - VerovioToolkit class
 *   (e.g. `import { VerovioToolkit } from "npm:verovio@5.6.0"`)
 * @param {Object} [options.toolkit] - Pre-initialized VerovioToolkit instance.
 *   Rarely needed: when omitted, Verovio's ESM build is auto-loaded from a
 *   CDN (verovio@5.6.0 dist/verovio-module.mjs + dist/verovio.mjs).
 * @param {number} [options.width=2100] - Page width in Verovio units
 * @param {number} [options.scale=60] - Scale factor for rendering
 * @param {string} [options.breaks='auto'] - Verovio breaks option ('auto',
 *   'none', 'line', 'smart')
 * @param {string} [options.header='none'] - Verovio header option. 'none'
 *   strips the title/composer area; pass 'encoded' to render it.
 * @param {string} [options.footer='none'] - Verovio footer option
 * @param {number} [options.pageMarginTop=50] - Top margin in Verovio units
 * @param {number} [options.pageMarginBottom=50] - Bottom margin
 * @param {number} [options.pageMarginLeft=50] - Left margin
 * @param {number} [options.pageMarginRight=50] - Right margin
 * @param {boolean} [options.includeMEI=false] - Also return the MEI source
 * @param {number} [options.timeoutMs=30000] - Max wait for Verovio WASM init
 *   before failing with a readable error. Pass 0 to disable.
 * @param {boolean} [options.responsive=true] - Replace the fixed
 *   `width`/`height` attributes on the root `<svg>` with `width="100%"`
 *   so the score fills its container. The `viewBox` is preserved so the
 *   browser computes a proportional height.
 * @returns {Promise<{svg: string, svgs: string[], pages: number, mei: string|null, musicxml: string}>}
 *   `svg` is the first page (for single-page compositions or convenience).
 *   `svgs` is the full array of all rendered pages.
 *   `pages` is the page count.
 */
export async function scoreSVG(composition, options = {}) {
  const {
    verovio,
    VerovioToolkit,
    toolkit,
    // Verovio works in "MEI units" — 100 is roughly "reference size".
    // pageWidth 2100 + scale 60 gives a canvas wide enough for most
    // melodies to fit on one line, with the music rendered at a readable
    // size once the responsive wrapper stretches it to the cell width.
    width = 2100,
    scale = 60,
    breaks = "auto",
    // `header` and `footer` pull in the composition title / copyright
    // area, which adds ~400 vertical units of mostly-empty space. Strip
    // them by default — if the caller wants a title rendered, they can
    // pass `header: "encoded"`.
    header = "none",
    footer = "none",
    // Small margins keep the viewBox tight around the actual music.
    pageMarginTop = 50,
    pageMarginBottom = 50,
    pageMarginLeft = 50,
    pageMarginRight = 50,
    includeMEI = false,
    timeoutMs = 30000,
    responsive = true,
  } = options;

  const vrvToolkit = await resolveToolkit({ toolkit, verovio, VerovioToolkit, timeoutMs });

  const musicXML = requireMusicXML(options.io)(composition);

  vrvToolkit.setOptions({
    scale,
    // Start from a tiny pageHeight and let `adjustPageHeight` grow it to
    // fit the actual rendered content. This is more reliable than guessing
    // a page height upfront — the final viewBox ends up hugging the music.
    adjustPageHeight: true,
    breaks,
    pageWidth: width,
    pageHeight: 100,
    pageMarginTop,
    pageMarginBottom,
    pageMarginLeft,
    pageMarginRight,
    header,
    footer,
    spacingStaff: 12,
    spacingSystem: 12,
  });

  vrvToolkit.loadData(musicXML);

  // Render every page so long compositions aren't silently truncated.
  // Verovio paginates based on pageWidth + content; a minute of music
  // typically produces 3–10 pages at pageWidth=2100.
  const pageCount =
    typeof vrvToolkit.getPageCount === "function"
      ? Math.max(1, vrvToolkit.getPageCount())
      : 1;
  const svgs = [];
  for (let p = 1; p <= pageCount; p++) {
    let pageSvg = vrvToolkit.renderToSVG(p);
    if (responsive) pageSvg = makeResponsiveSvg(pageSvg);
    svgs.push(pageSvg);
  }

  let mei = null;
  if (includeMEI && typeof vrvToolkit.getMEI === "function") {
    try {
      mei = vrvToolkit.getMEI({});
    } catch (e) {
      // MEI export is best-effort; don't fail the render over it.
      console.warn("[scoreSVG] getMEI failed:", e);
    }
  }

  return { svg: svgs[0], svgs, pages: pageCount, mei, musicxml: musicXML };
}

/**
 * Take `musicxml` out of an injected `jmon/io`, or fail with an explanation.
 * Kept beside requireFormat so both failures read the same way.
 */
function requireMusicXML(io) {
  if (typeof io?.musicxml !== "function") {
    throw new Error(
      "jmon/show needs jmon/io to build a score.\n\n" +
      '  import io from "https://cdn.jsdelivr.net/gh/jmonlabs/io@main/src/index.js";\n' +
      "  show.score(composition, { verovio, VerovioToolkit, io });\n\n" +
      "See https://github.com/jmonlabs/io",
    );
  }
  return io.musicxml;
}
