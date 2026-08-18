/**
 * The real `jmon/io`, for tests.
 *
 * Node refuses `https://` imports, so the CI checks jmon/io out next to this
 * repo and this resolves it from there. A vendored copy would drift, which is
 * the whole problem the split exists to avoid; a fake would test the fake.
 *
 * Locally: clone jmonlabs/io as a sibling directory.
 */
const CANDIDATES = ["../../../io/src/index.js", "../../../../io/src/index.js"];

let io = null;
for (const path of CANDIDATES) {
  try {
    const mod = await import(new URL(path, import.meta.url).href);
    io = mod.default || mod;
    break;
  } catch { /* try the next */ }
}

if (!io) {
  throw new Error(
    "These tests need jmon/io checked out beside this repo:\n" +
    "  git clone https://github.com/jmonlabs/io ../io",
  );
}

export default io;
