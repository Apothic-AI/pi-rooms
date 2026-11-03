set -u
cd /home/bitnom/Code/pi-rooms/.worktrees/web
STORE=$(mktemp -d /tmp/pi-rooms-webproof-XXXXXX)
export PI_ROOMS_DIR="$STORE"
node --experimental-strip-types --no-warnings web/tools/demo-store.ts --out "$STORE" >/dev/null 2>&1
echo "store: $STORE"
echo "files before: $(find "$STORE" -type f | wc -l)"

# Fingerprint EVERY file: path, size, mtime (nanoseconds), sha256.
snap() { find "$STORE" -type f -printf '%P\t%s\t%T@\t' -exec sha256sum {} \; | awk '{print $1"\t"$2"\t"$3"\t"$4}' | sort; }
snap > /tmp/before.snap

# Start the real reader and exercise every route the UI uses, plus a live stream.
node --experimental-strip-types --no-warnings -e '
const { startWebServer } = await import("./web/server/server.ts");
const s = await startWebServer({ port: 0, me: "operator", silent: true });
const base = s.url;
const get = async (p) => { const r = await fetch(base + p); await r.text(); return r.status; };
const log = [];
for (const p of ["api/config","api/rooms","api/rooms/human-participants","api/characters","api/participants","api/inbox"]) {
  log.push(p + " -> " + await get(p));
}
// non-GET must be refused
for (const m of ["POST","PUT","DELETE","PATCH"]) {
  const r = await fetch(base + "api/rooms", { method: m, body: m === "POST" ? "{}" : undefined });
  log.push(m + " api/rooms -> " + r.status);
}
// a live stream, read for ~2s
const ctrl = new AbortController();
const r = await fetch(base + "api/rooms/human-participants/stream?since=0", { signal: ctrl.signal });
const rd = r.body.getReader(); let n = 0, chunks = 0;
const t0 = Date.now();
while (Date.now() - t0 < 2000) { const { value, done } = await rd.read(); if (done) break; chunks++; n += value.length; }
ctrl.abort();
log.push("stream -> " + chunks + " chunks, " + n + " bytes");
console.log(log.join("\n"));
await s.close();
' 2>&1 | tail -20

snap > /tmp/after.snap
echo "files after:  $(find "$STORE" -type f | wc -l)"
echo "--- diff (empty means nothing changed) ---"
diff /tmp/before.snap /tmp/after.snap && echo "IDENTICAL: no file created, removed, rewritten, or touched"
echo "--- digest ---"
sha256sum /tmp/before.snap /tmp/after.snap
rm -rf "$STORE"
