/* Offscreen document: runs the single-thread ffmpeg.wasm core directly (no
 * worker, no blob: — MV3-safe). Commands arrive via the background relay:
 *   { cmd: "load" }     -> instantiate the core, report ready
 *   { cmd: "process", payload: { dataB64, inputExt, name, creationTime, trimFrames, fps } }
 *       -> (optional) trim to one loop + transcode H.264 MP4 + stamp creation_time
 *       -> { ok, mp4B64, name, bytes }
 */

const FPS = 30;
let core = null, loadingPromise = null;

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes) {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return btoa(s);
}

async function loadCore() {
  if (core) return core;
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    const coreUrl = chrome.runtime.getURL("vendor/ffmpeg-core.js");
    const wasmUrl = chrome.runtime.getURL("vendor/ffmpeg-core.wasm");
    // The core reads wasmURL from the "#base64(JSON)" suffix of mainScriptUrlOrBlob.
    const main = coreUrl + "#" + btoa(JSON.stringify({ wasmURL: wasmUrl }));
    const inst = await self.createFFmpegCore({ mainScriptUrlOrBlob: main });
    inst.setLogger?.((e) => console.log("[ffmpeg]", e && e.message != null ? e.message : e));
    core = inst;
    return inst;
  })();
  return loadingPromise;
}

// ---- loop-period detection ------------------------------------------------
const HN = 16;
function sad(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; }
// A stored cine repeats near-identically, so the lag-vs-dissimilarity curve has a
// deep dip at the loop period (and its harmonics). Take the global-minimum lag
// over [minP, pmax], then prefer the fundamental (smallest lag within a small
// tolerance of that minimum, so we don't pick 2x the loop). Confident only when
// the dip is far below the curve's peak. (Validated against real captures: a true
// loop dips to cost ~0.3 while the rest of the curve sits ~15-26.)
function findPeriod(frames, fps) {
  const n = frames.length;
  const minP = Math.max(8, Math.round((fps || 30) * 0.8));        // ignore sub-0.8s "loops"
  const minOverlap = Math.max(20, Math.round((fps || 30) * 0.7)); // frames needed to score a lag
  const pmax = n - minOverlap;
  if (pmax < minP + 2) return { period: n, cost: 0, ok: false };
  const costs = new Float64Array(pmax + 1);
  for (let p = 1; p <= pmax; p++) {
    let total = 0, cnt = 0;
    const span = n - p, step = Math.max(1, Math.floor(span / 60));
    for (let k = 0; k < span; k += step) { total += sad(frames[k], frames[k + p]); cnt++; }
    costs[p] = cnt ? total / cnt : 1e9;
  }
  let mx = 0, gmin = Infinity;
  for (let p = minP; p <= pmax; p++) { if (costs[p] > mx) mx = costs[p]; if (costs[p] < gmin) gmin = costs[p]; }
  if (mx < 3) return { period: n, cost: mx, ok: false };          // basically no motion
  const tol = Math.max(3, gmin * 4);
  let period = n;
  for (let p = minP; p <= pmax; p++) { if (costs[p] <= gmin + tol) { period = p; break; } }
  const ok = gmin < 0.30 * mx && gmin < 8;                         // a clear, deep dip
  return { period, cost: gmin, ok };
}

async function process(p) {
  const c = await loadCore();
  const fps = p.fps || FPS;
  const inName = "in." + (p.inputExt || "mp4");
  const outName = "out.mp4";
  const even = "pad=ceil(iw/2)*2:ceil(ih/2)*2";
  c.setTimeout?.(-1);
  c.FS.writeFile(inName, b64ToBytes(p.dataB64));

  // Pass 1: extract constant-fps NxN gray fingerprints, detect the loop period.
  let trimFrames = 0, note = "full";
  try {
    // RGB fingerprints so colour-Doppler motion is seen (grayscale misses it).
    c.exec("-i", inName, "-vf", `fps=${fps},scale=${HN}:${HN},format=rgb24`, "-f", "rawvideo", "-pix_fmt", "rgb24", "fp.raw");
    const raw = c.FS.readFile("fp.raw");
    const sz = HN * HN * 3, count = Math.floor(raw.length / sz);
    const frames = [];
    for (let i = 0; i < count; i++) frames.push(raw.subarray(i * sz, i * sz + sz));
    const r = findPeriod(frames, fps);
    if (r.ok && r.period < count) { trimFrames = r.period; note = `loop ${r.period}f/${count} (cost ${r.cost.toFixed(1)})`; }
    else note = `full ${count}f (cost ${r.cost.toFixed(1)})`;
    c.reset?.(); try { c.FS.unlink("fp.raw"); } catch (e) {}
  } catch (e) { note = "full (fp pass failed)"; }

  // Pass 2: trim to one loop (if found), transcode H.264, stamp creation_time.
  const args = ["-i", inName, "-vf", `fps=${fps},${even}`];
  if (trimFrames) args.push("-frames:v", String(trimFrames));
  args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p");
  if (p.creationTime) args.push("-metadata", `creation_time=${p.creationTime}`);
  args.push("-movflags", "+faststart", outName);
  c.exec(...args);

  const data = c.FS.readFile(outName);
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const b64 = bytesToB64(bytes);
  try { c.reset?.(); c.FS.unlink(inName); c.FS.unlink(outName); } catch (e) {}
  return { ok: true, mp4B64: b64, name: p.name, bytes: bytes.length, note };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return;
  (async () => {
    try {
      if (msg.cmd === "load") { await loadCore(); sendResponse({ ok: true, loaded: true }); }
      else if (msg.cmd === "process") { sendResponse(await process(msg.payload)); }
      else sendResponse({ ok: false, error: "unknown cmd " + msg.cmd });
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.stack) || e) });
    }
  })();
  return true;  // async
});
