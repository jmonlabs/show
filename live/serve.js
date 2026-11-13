// Serves the jmon folder for the live REPL, on this machine only.
//
//   deno run --allow-net=127.0.0.1:4400 --allow-read serve.js
//
// then open http://127.0.0.1:4400/ : the REPL, with show, io and sound from
// this disk (`?local`). The folder is under /__files/, as `note serve` has it,
// so an ison's samples (/__files/samples/…) are found the same way. Unlike
// `note serve`, the pages are not sandboxed: the REPL needs its scripts, the
// MIDI keyboard and its saved editor.

const root = new URL("../../", import.meta.url).pathname; // the jmon folder
const types = {
  html: "text/html", js: "text/javascript", mjs: "text/javascript", css: "text/css", json: "application/json",
  txt: "text/plain", dsp: "text/plain", sfz: "text/plain", dspreset: "text/xml", wasm: "application/wasm",
  wav: "audio/wav", flac: "audio/flac", ogg: "audio/ogg", sf2: "application/octet-stream",
};

Deno.serve({ hostname: "127.0.0.1", port: 4400 }, async (request) => {
  const path = decodeURIComponent(new URL(request.url).pathname);
  if (path === "/") return Response.redirect(new URL("/__files/show/live/repl.html?local", request.url), 302);
  if (!path.startsWith("/__files/") || path.includes("..")) return new Response("not found", { status: 404 });
  const file = root + path.slice("/__files/".length);
  try {
    const type = types[file.split(".").pop().toLowerCase()] ?? "application/octet-stream";
    return new Response(await Deno.readFile(file), { headers: { "content-type": type, "cache-control": "no-store" } });
  } catch {
    return new Response("not found", { status: 404 });
  }
});
