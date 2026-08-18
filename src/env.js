/**
 * Environment detection and presentation helpers.
 *
 * jmon/algo runs in several very different hosts:
 *   - Browsers (DOM + AudioContext + window)
 *   - Observable notebooks (DOM, but sometimes sandboxed)
 *   - nteract / Deno / Jupyter kernels (no DOM; a `display` object is
 *     injected on globalThis that accepts rich MIME bundles)
 *   - Node/Deno scripts (no DOM, no display — pure data in/out)
 *
 * This module gives the rest of the library one place to ask "where am I?"
 * and "how should I hand this value back to the host?".
 */

/** True when a DOM `document` is available. */
export function isBrowser() {
  return typeof document !== "undefined" && typeof document.createElement === "function";
}

/** True when a `window` global is available. */
export function hasWindow() {
  return typeof window !== "undefined";
}

/** True when a usable AudioContext constructor exists on the host. */
export function hasAudioContext() {
  return typeof globalThis !== "undefined" && (
    typeof globalThis.AudioContext !== "undefined" ||
    typeof globalThis.webkitAudioContext !== "undefined"
  );
}

/**
 * True when any known notebook display mechanism is reachable. We check:
 *   - `Deno.jupyter.display` (Deno Jupyter kernel — preferred when present)
 *   - `globalThis.display` (nteract / Observable-style hosts)
 */
export function hasDisplay() {
  if (hasDenoJupyter()) return true;
  const d = typeof globalThis !== "undefined" ? globalThis.display : undefined;
  if (!d) return false;
  if (typeof d === "function") return true;
  return (
    typeof d.html === "function" ||
    typeof d.svg === "function" ||
    typeof d.mimeType === "function" ||
    typeof d.mime === "function" ||
    typeof d.text === "function"
  );
}

/** True when running under a Deno Jupyter kernel. */
export function hasDenoJupyter() {
  try {
    return (
      typeof Deno !== "undefined" &&
      Deno.jupyter &&
      typeof Deno.jupyter.display === "function"
    );
  } catch {
    return false;
  }
}

/**
 * Standard Jupyter display symbol. Any object whose
 * `[Symbol.for("Jupyter.display")]()` method returns a MIME bundle will be
 * rendered inline when that object is the value of a cell — works in both
 * Deno Jupyter and IJavaScript.
 */
export const JUPYTER_DISPLAY = Symbol.for("Jupyter.display");

/**
 * Wrap a MIME bundle so the Jupyter kernel renders it when the object
 * is the final expression of a cell. The bundle itself is copied onto the
 * wrapper as own-properties, so users can still inspect it as data.
 *
 * @param {Object} bundle - { 'image/svg+xml': '...', 'text/plain': '...' }
 * @returns {Object} The bundle plus a [Symbol.for("Jupyter.display")] method
 */
export function displayable(bundle) {
  const wrapper = { ...bundle };
  Object.defineProperty(wrapper, JUPYTER_DISPLAY, {
    value: () => bundle,
    enumerable: false,
  });
  return wrapper;
}

/**
 * Hand a value to the host in whichever way is richest.
 *
 * Rules:
 *   1. If a notebook `display` object is present, use it directly. We try
 *      the most specific method available for the given MIME type and fall
 *      back through html → mimeType → text.
 *   2. Otherwise, return the value unchanged so the caller can do whatever
 *      makes sense in their environment (append to DOM, write to file, etc.).
 *
 * @param {*} value - The value to present. Can be a string (SVG/HTML),
 *   a Uint8Array (binary), a DOM element, or an object with a `mime` bundle
 *   like { 'image/svg+xml': '...', 'text/plain': '...' }.
 * @param {Object} [opts]
 * @param {string} [opts.mime] - MIME type hint. Common values:
 *   'image/svg+xml', 'text/html', 'audio/midi', 'text/plain'.
 * @returns {*} The value passed in (for chaining), or the display result.
 */
export function present(value, opts = {}) {
  const { mime } = opts;

  // Normalize any input (scalar+mime or full bundle) into a canonical
  // MIME-bundle object. We always end up with something like
  // { 'image/svg+xml': '<svg...>', 'text/plain': '...' } that every host
  // can consume in its own way.
  const bundle = toMimeBundle(value, mime);

  // Preferred path: Deno Jupyter. Pure side effect — the raw:true form is
  // confirmed to render in the Deno Jupyter kernel. We intentionally return
  // `undefined` so callers can also use this mid-cell without the cell's
  // final-expression path trying to render a second time. Use
  // `displayable()` when you want a return value that the kernel picks up.
  if (hasDenoJupyter() && bundle) {
    try {
      Deno.jupyter.display(bundle, { raw: true });
    } catch (e) {
      console.warn("[jmon/env] Deno.jupyter.display failed:", e);
    }
    return undefined;
  }

  // nteract / Observable-style: globalThis.display as an object or function.
  const d = typeof globalThis !== "undefined" ? globalThis.display : undefined;
  if (d) {
    try {
      if (bundle) {
        if (typeof d.mimeType === "function") return d.mimeType(bundle);
        if (typeof d.mime === "function") return d.mime(bundle);
        // Degrade: pick the richest key we know how to render.
        if (bundle["image/svg+xml"] && typeof d.svg === "function") {
          return d.svg(bundle["image/svg+xml"]);
        }
        if (bundle["text/html"] && typeof d.html === "function") {
          return d.html(bundle["text/html"]);
        }
        if (bundle["image/svg+xml"] && typeof d.html === "function") {
          return d.html(bundle["image/svg+xml"]);
        }
        if (typeof d.text === "function" && bundle["text/plain"]) {
          return d.text(bundle["text/plain"]);
        }
      }
      if (typeof d === "function") return d(value);
    } catch (e) {
      console.warn("[jmon/env] display() failed, returning raw value:", e);
    }
  }

  // No display host available — hand back a displayable wrapper so that
  // *if* the user's kernel honors Symbol.for("Jupyter.display"), it still
  // renders. Otherwise the wrapper behaves like the original bundle/value.
  if (bundle) return displayable(bundle);
  return value;
}

/**
 * Turn either a scalar + MIME hint or an already-shaped bundle into a
 * canonical MIME bundle object. Returns null when the input can't be
 * interpreted as a bundle (e.g. a DOM element or a Uint8Array with no hint).
 */
function toMimeBundle(value, mime) {
  // Already a bundle? Trust it.
  if (
    value && typeof value === "object" &&
    !(value instanceof Uint8Array) &&
    !ArrayBuffer.isView(value) &&
    !isDomNode(value) &&
    Object.keys(value).some(k => k.includes("/"))
  ) {
    const bundle = { ...value };
    if (!bundle["text/plain"]) {
      bundle["text/plain"] = `[${Object.keys(value).join(", ")}]`;
    }
    return bundle;
  }

  // Scalar + MIME hint.
  if (typeof mime === "string" && typeof value === "string") {
    return {
      [mime]: value,
      "text/plain": mime.startsWith("image/") || mime.includes("xml")
        ? `[${mime}]`
        : value.slice(0, 200),
    };
  }

  // No MIME but the string looks like HTML/SVG markup — default to text/html.
  if (typeof value === "string" && /^\s*<(?:svg|html|div|p|table|h\d)/i.test(value)) {
    return { "text/html": value, "text/plain": "[html]" };
  }

  return null;
}

function isDomNode(v) {
  return typeof v === "object" && v !== null &&
    typeof v.nodeType === "number" && typeof v.nodeName === "string";
}

/**
 * Small helper that always returns a MIME bundle shape for a string payload.
 * Useful when you want the caller to forward to `present()` uniformly.
 */
export function mimeBundle(mime, value, fallbackText) {
  const bundle = { [mime]: value };
  if (fallbackText != null) bundle["text/plain"] = fallbackText;
  return bundle;
}
