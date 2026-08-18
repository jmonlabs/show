/**
 * Browser-facing score renderer.
 *
 * Thin DOM wrapper around the pure `scoreSVG()` renderer in `../score.js`.
 * Kept in `src/browser/` so it can be excluded from the JSR publish set,
 * which cannot depend on DOM globals.
 */

import { scoreSVG } from "./score.js";
import { isBrowser } from "./env.js";

// Re-export the pure renderer so callers that already import from the
// browser module path keep working.
export { scoreSVG };

/**
 * Render a JMON piece into a DOM element. In a browser this returns
 * a `<div>` wrapping the Verovio SVG. In a headless environment it falls
 * back to returning the SVG string so the caller still gets something
 * useful — the top-level `jm.score` will then forward it through `present()`
 * for rich notebook display.
 *
 * @param {Object} piece - The JMON piece to render
 * @param {Object} options - Same options as scoreSVG
 * @returns {Promise<HTMLElement|string>}
 */
export async function score(piece, options = {}) {
  if (!isBrowser()) {
    const { svg } = await scoreSVG(piece, options);
    return svg;
  }

  const container = document.createElement("div");
  container.style.width = "100%";
  container.style.overflow = "visible";

  const notationDiv = document.createElement("div");
  notationDiv.id = `rendered-score-${Date.now()}`;
  container.appendChild(notationDiv);

  try {
    notationDiv.innerHTML = '<p style="color:#888">Initializing Verovio...</p>';
    const { svg } = await scoreSVG(piece, options);
    notationDiv.innerHTML = svg;
  } catch (error) {
    console.error("[SCORE] Render error:", error);
    notationDiv.innerHTML = `<p style="color:#ff6b6b">Error: ${error.message}</p>`;
  }

  return container;
}
