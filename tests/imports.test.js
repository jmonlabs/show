/**
 * Every relative import in src/ resolves to a file that exists.
 *
 * `wav.js` carried `await import("../constants/audio-effects.js")` from before
 * the package split, pointing at a path this repository does not have. Being
 * dynamic, it cost nothing until the branch that runs it ran — so `play` was
 * fine and only `wav` threw, at the moment of export, with a bare "Failed to
 * fetch dynamically imported module". The names it pulled were already
 * imported statically at the top of the same file.
 *
 * A static import that cannot resolve is loud. A dynamic one is a trapdoor, so
 * this test walks all of them.
 *
 * node:test + assert — a failure fails the process.
 * Run with: node --test tests/imports.test.js
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

function jsFiles(dir) {
    return readdirSync(dir).flatMap((entry) => {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) return jsFiles(full);
        return full.endsWith(".js") ? [full] : [];
    });
}

/**
 * Import specifiers, comments excluded. JSDoc blocks in this codebase carry
 * example `import` lines, and matching those would report files that were only
 * ever mentioned in prose.
 */
function relativeSpecifiers(source) {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "");
    const found = [];
    for (const line of code.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
        for (const m of line.matchAll(/(?:from|import\s*\()\s*["'](\.[^"']*)["']/g)) {
            found.push(m[1]);
        }
    }
    return found;
}

test("every relative import under src/ resolves to a file that exists", () => {
    const broken = [];

    for (const file of jsFiles(SRC)) {
        for (const spec of relativeSpecifiers(readFileSync(file, "utf8"))) {
            const target = resolve(dirname(file), spec);
            if (!existsSync(target)) {
                broken.push(`${relative(SRC, file)} -> ${spec}`);
            }
        }
    }

    assert.deepEqual(broken, [], `these imports point at nothing:\n  ${broken.join("\n  ")}`);
});

test("nothing under src/ reaches outside src/", () => {
    const escaping = [];

    for (const file of jsFiles(SRC)) {
        for (const spec of relativeSpecifiers(readFileSync(file, "utf8"))) {
            const target = resolve(dirname(file), spec);
            if (!target.startsWith(SRC)) {
                escaping.push(`${relative(SRC, file)} -> ${spec}`);
            }
        }
    }

    assert.deepEqual(escaping, [], `these imports leave the package:\n  ${escaping.join("\n  ")}`);
});

test("the walk actually found the package", () => {
    const files = jsFiles(SRC);
    assert.ok(files.length > 10, `only ${files.length} files under src/; the walk looks wrong`);
    assert.ok(
        files.some((f) => f.endsWith("wav.js")),
        "wav.js was not walked",
    );
});
