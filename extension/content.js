/* ============================================================================
 * Synapse Mobility Exporter — content script
 * ----------------------------------------------------------------------------
 * Injects a small panel into the viewer that can:
 *   • Harvest all clips as full-res stills (DICOM render proxy, one click).
 *   • Auto-capture cine loops: you open a clip + press play, it records exactly
 *     one loop (detected via frame-hashing) and saves it, then re-arms.
 *   • Manual record/stop + single-frame snapshot as a fallback.
 *
 * Everything runs inside your own authenticated session, same-origin. Files
 * download to your browser's default folder; sort them into the project's
 * stills/ and cine-webm/ folders afterwards.
 * ==========================================================================*/
(() => {
  if (window.__synExporter) { console.log("Synapse Exporter already loaded"); return; }
  window.__synExporter = true;

  // ---- tunables -------------------------------------------------------------
  const CFG = {
    STILL_SIZE: 4096,          // requested px (server caps at native)
    STILL_QUALITY: 100,
    STILL_GAP_MS: 350,
    REC_FPS: 30,
    REC_BITRATE: 12_000_000,
    SAMPLE_MS: 80,             // canvas sampling interval for motion/loop detect
    HASH_N: 16,                // downscale NxN for the perceptual hash
    MOTION_THRESH: 2.5,        // mean per-pixel diff that counts as "moving"
    LOOP_MATCH_THRESH: 4.0,    // diff back to first frame that counts as "looped"
    MIN_LOOP_FRAMES: 10,       // require this many samples before allowing loop-close
    MAX_REC_MS: 25000,         // hard safety cap per recording (long loops have 200+ frames)
    COOLDOWN_MS: 1500,         // ignore motion this long after a save
  };

  const enc = encodeURIComponent;
  const $ = (sel) => document.querySelector(sel);
  const baseCanvas = () => $('canvas[id^="cnv_"]');
  const aceCanvas = () => $('canvas[id^="acetate_"]');

  const download = (blob, name) => {
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 6000);
  };
  const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const pad = (n) => String(n).padStart(2, "0");

  // ---- panel UI -------------------------------------------------------------
  const style = document.createElement("style");
  style.textContent = `
    #syn-exp { position: fixed; top: 64px; right: 16px; z-index: 2147483647;
      width: 274px; font: 12px/1.4 -apple-system, system-ui, sans-serif;
      background: #14161a; color: #e8eaed; border: 1px solid #2d323b;
      border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.55); user-select: none; }
    #syn-exp .hd { padding: 10px 13px; background: #1d2026; border-radius: 12px 12px 0 0;
      cursor: move; font-weight: 600; font-size: 13px; display: flex; justify-content: space-between; align-items: center; }
    #syn-exp .bd { padding: 13px; display: flex; flex-direction: column; gap: 8px; }
    #syn-exp .sec-label { font-size: 10px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase;
      color: #6d7e9c; margin: 6px 0 2px; }
    #syn-exp button { background: #2f6fe0; color: #fff; border: 0; border-radius: 8px;
      padding: 10px 11px; font: inherit; font-weight: 600; cursor: pointer; text-align: center; }
    #syn-exp button:hover:not(:disabled) { filter: brightness(1.12); }
    #syn-exp button:disabled { opacity: .45; cursor: default; }
    #syn-exp button.sec { background: #2b3038; color: #dfe4ec; }
    #syn-exp button.stop { background: #d6324a; }
    #syn-exp .card { background: #1a1d23; border: 1px solid #2a2f38; border-radius: 9px;
      padding: 10px; display: flex; flex-direction: column; gap: 7px; }
    #syn-exp .card .ttl { font-size: 11px; font-weight: 600; color: #aeb6c4; }
    #syn-exp .clipsel { display: flex; align-items: center; gap: 8px; }
    #syn-exp .clipsel input { width: 56px; background: #0f1114; color: #e8eaed; border: 1px solid #343a44;
      border-radius: 6px; padding: 5px 6px; font: inherit; text-align: center; }
    #syn-exp .clipsel label { font-size: 11px; color: #b9c2d0; white-space: nowrap; }
    #syn-exp .clipsel .of { font-size: 11px; color: #6d7585; }
    #syn-exp .pbar { height: 7px; background: #262b33; border-radius: 4px; overflow: hidden; }
    #syn-exp .pfill { height: 100%; width: 0%; background: #2f6fe0; border-radius: 4px; transition: width .2s ease; }
    #syn-exp .pfill.done { background: #2f9e6e; }
    #syn-exp .statrow { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px; }
    #syn-exp .stat { font-size: 11px; color: #aeb6c4; min-height: 14px; }
    #syn-exp .mini { background: #2b3038; color: #b9c2d0; border: 0; border-radius: 6px;
      padding: 4px 9px; font: inherit; font-size: 11px; font-weight: 600; cursor: pointer; white-space: nowrap; }
    #syn-exp .log { font: 10px/1.35 ui-monospace, Menlo, monospace; color: #8a93a6;
      background: #0f1114; border-radius: 7px; padding: 7px 8px; height: 76px; overflow: auto; white-space: pre-wrap;
      -webkit-user-select: text; user-select: text; cursor: text; }
    #syn-exp .x { cursor: pointer; opacity: .55; font-size: 15px; } #syn-exp .x:hover { opacity: 1; }
  `;
  document.documentElement.appendChild(style);

  const panel = document.createElement("div");
  panel.id = "syn-exp";
  panel.innerHTML = `
    <div class="hd"><span>Ultrasound Export</span><span class="x" title="hide">✕</span></div>
    <div class="bd">
      <div class="sec-label">Images</div>
      <button id="se-allimg">Retrieve all images</button>
      <button id="se-thisimg" class="sec">Retrieve only this image</button>

      <div class="sec-label">Videos</div>
      <button id="se-allvid">Retrieve all videos</button>

      <div class="card">
        <div class="ttl">Work with the clip you're viewing</div>
        <div class="clipsel">
          <label>It's clip number</label>
          <input id="se-start" type="number" min="1" value="1">
          <span class="of" id="se-of"></span>
        </div>
        <button id="se-thisvid" class="sec">Retrieve this video</button>
        <button id="se-fromvid" class="sec">Retrieve this video + all after it</button>
        <button id="se-frames" class="sec">Save this video's frames as images</button>
      </div>

      <button id="se-stop" class="stop" style="margin-top:4px;">Stop</button>

      <div class="pbar"><div class="pfill" id="se-pfill"></div></div>
      <div class="statrow">
        <span class="stat" id="se-stat">Ready.</span>
        <button id="se-copy" class="mini" title="Copy the log to the clipboard">Copy log</button>
      </div>
      <div class="log" id="se-log"></div>
    </div>`;
  document.body.appendChild(panel);

  const logEl = $("#se-log"), statEl = $("#se-stat"), pfillEl = $("#se-pfill");
  const log = (m) => { logEl.textContent += m + "\n"; logEl.scrollTop = logEl.scrollHeight; console.log("[syn]", m); };
  const setStat = (m) => { statEl.textContent = m; };
  const setProgress = (cur, total) => {
    const pct = total > 0 ? Math.min(100, Math.round(100 * cur / total)) : 0;
    pfillEl.style.width = pct + "%";
    pfillEl.classList.toggle("done", pct >= 100);
  };

  // draggable
  (() => {
    const hd = panel.querySelector(".hd"); let sx, sy, ox, oy, drag = false;
    hd.addEventListener("mousedown", (e) => { if (e.target.classList.contains("x")) return;
      drag = true; sx = e.clientX; sy = e.clientY; const r = panel.getBoundingClientRect(); ox = r.left; oy = r.top; });
    addEventListener("mousemove", (e) => { if (!drag) return;
      panel.style.left = ox + e.clientX - sx + "px"; panel.style.top = oy + e.clientY - sy + "px"; panel.style.right = "auto"; });
    addEventListener("mouseup", () => drag = false);
    panel.querySelector(".x").onclick = () => panel.style.display = "none";
  })();

  // ---- discover study/repo/series from resource timing ----------------------
  function discover() {
    const seen = new Map(); let study = null, repo = null;
    const rx = /\/dicom\/series\/([^/]+)\/thumbnail\?/;
    for (const u of performance.getEntriesByType("resource").map((e) => e.name)) {
      const m = u.match(rx); if (!m) continue;
      const uid = decodeURIComponent(m[1]);
      const q = new URL(u).searchParams;
      if (q.get("StudyInstanceUID")) study = q.get("StudyInstanceUID");
      if (q.get("DicomRepository")) repo = q.get("DicomRepository");
      if (!seen.has(uid)) seen.set(uid, 1);
    }
    return { study, repo, uids: [...seen.keys()] };
  }

  // ---- stills harvest -------------------------------------------------------
  // Insert a minimal EXIF block (DateTime / DateTimeOriginal / DateTimeDigitized)
  // into a JPEG so Google Photos dates the image from embedded metadata — the
  // image equivalent of the videos' creation_time. Layout: APP1 right after SOI.
  function jpegWithDate(arrayBuffer, date) {
    const src = new Uint8Array(arrayBuffer);
    if (src[0] !== 0xFF || src[1] !== 0xD8) return new Blob([src], { type: "image/jpeg" });
    const p = (n) => String(n).padStart(2, "0");
    const ds = `${date.getFullYear()}:${p(date.getMonth() + 1)}:${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}\0`; // 20 bytes
    const tiff = new ArrayBuffer(88);
    const dv = new DataView(tiff);
    dv.setUint16(0, 0x4949, false);              // "II" little-endian
    dv.setUint16(2, 42, true);
    dv.setUint32(4, 8, true);                    // IFD0 @ 8
    dv.setUint16(8, 2, true);                    // IFD0: 2 entries
    dv.setUint16(10, 0x0132, true); dv.setUint16(12, 2, true); dv.setUint32(14, 20, true); dv.setUint32(18, 68, true);   // DateTime -> str@68
    dv.setUint16(22, 0x8769, true); dv.setUint16(24, 4, true); dv.setUint32(26, 1, true); dv.setUint32(30, 38, true);    // Exif IFD ptr -> 38
    dv.setUint32(34, 0, true);                   // next IFD = 0
    dv.setUint16(38, 2, true);                   // ExifIFD: 2 entries
    dv.setUint16(40, 0x9003, true); dv.setUint16(42, 2, true); dv.setUint32(44, 20, true); dv.setUint32(48, 68, true);   // DateTimeOriginal
    dv.setUint16(52, 0x9004, true); dv.setUint16(54, 2, true); dv.setUint32(56, 20, true); dv.setUint32(60, 68, true);   // DateTimeDigitized
    dv.setUint32(64, 0, true);                   // next IFD = 0
    const tb = new Uint8Array(tiff);
    for (let i = 0; i < 20; i++) tb[68 + i] = ds.charCodeAt(i) & 0xff;
    const hdr = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"
    const segLen = 2 + hdr.length + tiff.byteLength;  // APP1 length field counts itself
    const app1 = new Uint8Array(4 + hdr.length + tiff.byteLength);
    app1[0] = 0xFF; app1[1] = 0xE1; app1[2] = (segLen >> 8) & 0xff; app1[3] = segLen & 0xff; // BE length
    app1.set(hdr, 4); app1.set(tb, 4 + hdr.length);
    const out = new Uint8Array(2 + app1.length + (src.length - 2));
    out[0] = 0xFF; out[1] = 0xD8; out.set(app1, 2); out.set(src.subarray(2), 2 + app1.length);
    return new Blob([out], { type: "image/jpeg" });
  }

  async function harvestStills() {
    const { study, repo, uids } = discover();
    if (!uids.length || !study) { setStat("No images found — reload the page."); log("No images found in the page yet. Reload the viewer and let the worklist render."); return; }
    const apiBase = location.origin + "/pureweb";
    const scanDate = await getStudyDateTime();   // same date the videos use
    log(`Retrieving ${uids.length} images, dated ${fmtCreation(scanDate).slice(0, 10)}…`);
    let ok = 0;
    for (let i = 0; i < uids.length; i++) {
      let url = `${apiBase}/dicom/series/${enc(uids[i])}/thumbnail?columns=${CFG.STILL_SIZE}&rows=${CFG.STILL_SIZE}&imageQuality=${CFG.STILL_QUALITY}`;
      url += `&StudyInstanceUID=${enc(study)}&DicomRepository=${enc(repo)}`;
      setStat(`Image ${i + 1} of ${uids.length}…`); setProgress(i, uids.length);
      try {
        const r = await fetch(url, { credentials: "include", redirect: "manual" });
        if (r.type === "opaqueredirect" || r.status === 0) { setStat("Session expired — reload + sign in, then retry."); log(`✗ session expired after ${ok}.`); break; }
        if (!r.ok) { log(`${pad(i + 1)} ✗ HTTP ${r.status}`); continue; }
        const buf = await r.arrayBuffer();
        const dt = new Date(scanDate.getTime() + i * 60000);
        const dated = jpegWithDate(buf, dt);                 // embed EXIF date (like the video)
        download(dated, `${fmtFileDate(dt)}_image${pad(i + 1)}.jpg`);   // date in name too, as fallback
        ok++; log(`${pad(i + 1)} ✓ ${(dated.size / 1024 | 0)}KB`);
      } catch (e) { log(`${pad(i + 1)} ✗ ${e.message}`); }
      await new Promise((res) => setTimeout(res, CFG.STILL_GAP_MS));
    }
    setProgress(ok, uids.length); setStat(`Done — ${ok} of ${uids.length} images saved.`); log(`images done: ${ok}/${uids.length}`);
  }

  // ---- compositing + recording ---------------------------------------------
  let composite, cctx, rafId = null, rec = null, chunks = [], recName = "loop";

  function startComposite() {
    const b = baseCanvas(); if (!b) return false;
    if (!composite) { composite = document.createElement("canvas"); cctx = composite.getContext("2d"); }
    composite.width = b.width; composite.height = b.height;
    const draw = () => {
      const bb = baseCanvas(), aa = aceCanvas();
      if (bb) cctx.drawImage(bb, 0, 0, composite.width, composite.height);
      if (aa) cctx.drawImage(aa, 0, 0, composite.width, composite.height);
      rafId = requestAnimationFrame(draw);
    };
    draw(); return true;
  }
  function stopComposite() { if (rafId) cancelAnimationFrame(rafId); rafId = null; }

  // Prefer MP4/H.264 (universally playable) — Chrome 130+ can record it directly.
  // Fall back to WebM where MP4 recording isn't supported.
  function pickMime() {
    return [
      "video/mp4;codecs=avc1.640029", "video/mp4;codecs=avc1", "video/mp4",
      "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm",
    ].find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || "";
  }

  // base64 <-> blob helpers for shipping video to the offscreen ffmpeg worker.
  function blobToB64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => { const s = r.result; resolve(s.slice(s.indexOf(",") + 1)); };
      r.onerror = reject; r.readAsDataURL(blob);
    });
  }
  function b64ToBlob(b64, type) {
    const bin = atob(b64); const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return new Blob([u], { type });
  }

  let recMeta = {};
  let finalizing = false;

  function startRecording(name, meta = {}) {
    if (rec) { log("already recording"); return; }
    if (!startComposite()) { log("no render canvas — open a clip first"); return; }
    recName = name; recMeta = meta; chunks = [];
    const mime = pickMime();
    const ext = mime.includes("mp4") ? "mp4" : "webm";
    rec = new MediaRecorder(composite.captureStream(CFG.REC_FPS),
      { mimeType: mime || undefined, videoBitsPerSecond: CFG.REC_BITRATE });
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: mime || "video/webm" });
      rec = null;
      finalize(blob, ext, name, recMeta);   // async; toggles `finalizing`
      if (!autoOn && !driving) stopComposite();
    };
    rec.start();
    log(`● recording ${name} (${composite.width}x${composite.height})`);
  }
  function stopRecording() { if (rec) rec.stop(); }

  // Hand the recording to the offscreen ffmpeg worker: trim to one loop, stamp
  // the scan date, transcode to MP4, then download. Falls back to the raw blob
  // if ffmpeg fails, so a capture is never lost.
  async function finalize(blob, ext, name, meta) {
    finalizing = true;
    const fileName = meta.fileName || `${name}_${stamp()}`;
    try {
      const dataB64 = await blobToB64(blob);
      log(`  ⚙ ffmpeg ${name} (${(blob.size / 1048576).toFixed(1)}MB)…`);
      const r = await chrome.runtime.sendMessage({
        type: "ff", cmd: "process",
        payload: { dataB64, inputExt: ext, name, creationTime: meta.creationTime || "", fps: CFG.REC_FPS },
      });
      if (r && r.ok) {
        download(b64ToBlob(r.mp4B64, "video/mp4"), `${fileName}.mp4`);
        log(`  ✓ ${fileName}.mp4 ${(r.bytes / 1048576).toFixed(1)}MB [${r.note}]`);
      } else {
        log(`  ⚠ ffmpeg failed (${r && r.error}); saved raw .${ext}`);
        download(blob, `${fileName}.${ext}`);
      }
    } catch (e) {
      log(`  ⚠ finalize error (${e.message}); saved raw .${ext}`);
      download(blob, `${fileName}.${ext}`);
    } finally { finalizing = false; }
  }

  // ---- scan-date metadata ---------------------------------------------------
  const two = (n) => String(n).padStart(2, "0");
  const fmtCreation = (dt) => `${dt.getFullYear()}-${two(dt.getMonth() + 1)}-${two(dt.getDate())}T${two(dt.getHours())}:${two(dt.getMinutes())}:${two(dt.getSeconds())}`;
  const fmtFileDate = (dt) => `${dt.getFullYear()}-${two(dt.getMonth() + 1)}-${two(dt.getDate())}_${two(dt.getHours())}${two(dt.getMinutes())}${two(dt.getSeconds())}`;
  // StudyDate/StudyTime from the series-list JSON; falls back to "now".
  function parseISO(text, hh = 9) {
    const m = (text || "").match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
    return m ? new Date(+m[1], +m[2] - 1, +m[3], hh, 0, 0) : null;
  }
  async function getStudyDateTime() {
    // 1) The worklist's study-date element (probe-confirmed: ".primary.date" inside
    //    ".date-time"). DOB lives in ".patient-dob", so we never grab the birth date.
    const el = document.querySelector(".date-time .primary.date, .date-time .primary, .primary.date");
    const domDt = el && parseISO(el.textContent);
    if (domDt) { log(`  date: ${fmtCreation(domDt).slice(0, 10)} (worklist)`); return domDt; }
    // 2) series-list JSON (real StudyDate+StudyTime) when the session allows it.
    try {
      const { study, repo } = discover();
      if (study) {
        const url = `${location.origin}/pureweb/dicom/series?StudyInstanceUID=${encodeURIComponent(study)}&DicomRepository=${encodeURIComponent(repo || "")}`;
        const r = await fetch(url, { credentials: "include", redirect: "manual" });
        if (r.ok && r.type !== "opaqueredirect") {
          const j = await r.json();
          const s = (j.SeriesList || j)[0];
          if (s && s.StudyDate) {
            const d = s.StudyDate, t = (s.StudyTime || "090000").padEnd(6, "0");
            log("  date: from study metadata");
            return new Date(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +t.slice(0, 2), +t.slice(2, 4), +t.slice(4, 6));
          }
        }
      }
    } catch (e) {}
    log("  date: fell back to today (couldn't read scan date)");
    return new Date();
  }

  function snap() {
    if (!startComposite()) { setStat("Open a clip first."); log("no render canvas"); return; }
    setTimeout(() => {
      composite.toBlob((b) => {
        download(b, `image_${stamp()}.png`);
        setStat("Saved this image."); log(`✓ image_${stamp()}.png ${composite.width}x${composite.height}`);
        if (!autoOn && !rec) stopComposite();
      }, "image/png");
    }, 60);
  }

  // ---- perceptual hash for motion / loop detection --------------------------
  const hCanvas = document.createElement("canvas"); hCanvas.width = CFG.HASH_N; hCanvas.height = CFG.HASH_N;
  const hctx = hCanvas.getContext("2d", { willReadFrequently: true });
  function frameHash() {
    const b = baseCanvas(); if (!b) return null;
    hctx.drawImage(b, 0, 0, CFG.HASH_N, CFG.HASH_N);
    const d = hctx.getImageData(0, 0, CFG.HASH_N, CFG.HASH_N).data;
    const g = new Float32Array(CFG.HASH_N * CFG.HASH_N);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) g[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    return g;
  }
  function diff(a, b) { if (!a || !b) return 1e9; let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; }

  // Flags referenced by the recording teardown + Stop. (The old free-running
  // auto-capture loop was replaced by the Retrieve buttons.)
  let autoOn = false, autoTimer = null;

  // ---- retrieval driving ----------------------------------------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Fire a full pointer/mouse sequence so directive-bound handlers fire even
  // though the elements expose no ng-click we can call directly.
  function synthClick(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const opt = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 };
    for (const type of ["pointerover", "pointerenter", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      const Ctor = type.startsWith("pointer") && window.PointerEvent ? PointerEvent : MouseEvent;
      el.dispatchEvent(new Ctor(type, opt));
    }
    return true;
  }
  // Nearest ancestor (incl. self) that actually has size on screen.
  function visibleAncestor(el) {
    let n = el;
    while (n && n !== document.body) {
      if (n.offsetWidth > 0 && n.offsetHeight > 0) return n;
      n = n.parentElement;
    }
    return el;
  }
  // The 35 worklist clips, in visual (top-to-bottom) order.
  function worklistTargets() {
    const map = new Map();
    document.querySelectorAll("*").forEach((e) => {
      const b = getComputedStyle(e).backgroundImage;
      if (!b || !b.includes("/dicom/series/")) return;
      const m = b.match(/\/dicom\/series\/([^/]+)\/thumbnail/);
      const uid = m ? m[1] : b;
      if (!map.has(uid)) map.set(uid, visibleAncestor(e));
    });
    return [...map.values()].sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return ra.top - rb.top || ra.left - rb.left;
    });
  }
  // Engaging cine: some clips auto-play; others (e.g. big 184-frame ones) load
  // static and need the Cine tool clicked. The per-view play bar only EXISTS
  // once cine is engaged, so we drive the Cine tool — but only when the canvas
  // is NOT already moving (toggling it while playing would stop it).
  const cineTool = () => document.querySelector(".icon-tool-Cine");
  const playbackPlayIcon = () => document.querySelector(".playback-control .icon-ui-PlayFwd");
  const nextSeriesBtn = () => [...document.querySelectorAll('[title="Load next series"]')].find((e) => e.offsetHeight > 0);

  async function isMoving(gapMs = 250) {
    const a = frameHash(); await sleep(gapMs); const b = frameHash();
    return !!(a && b && diff(a, b) > CFG.MOTION_THRESH);
  }
  // Returns true once the clip is actually animating (or false if it can't be started).
  // Get the clip playing. Slow, non-autoplay clips need patience + the Cine tool;
  // already-playing clips need nothing. Prefer the explicit play control; only
  // toggle the Cine tool occasionally (it's a toggle — spamming it flips cine off).
  async function ensureMotion(maxMs = 22000) {
    const t0 = performance.now();
    let lastTool = -9999;
    while (performance.now() - t0 < maxMs) {
      if (await isMoving()) return true;                       // samples ~250ms
      const ctrl = document.querySelector(".playback-control");
      if (ctrl) {
        // Cine mode is engaged. If paused, click play. If it shows Pause but
        // isn't moving yet, it's still loading — just wait. NEVER toggle the Cine
        // tool here (that would turn cine off).
        const play = ctrl.querySelector(".icon-ui-PlayFwd");
        if (play) synthClick(play);
      } else if (performance.now() - lastTool > 5000) {
        // No playback bar => cine is off. Engage it once; give it time to appear.
        if (cineTool()) { synthClick(cineTool()); lastTool = performance.now(); log("  ◐ cine"); }
      }
      await sleep(600);
    }
    return await isMoving();
  }
  // Stop cine so the canvas is static before we advance — otherwise the still-
  // playing clip's motion would fool waitForLoad into thinking the next one loaded.
  async function stopMotion(maxMs = 2500) {
    if (!(await isMoving())) return;
    const pause = document.querySelector(".playback-control .icon-ui-Pause");
    if (pause) synthClick(pause); else if (cineTool()) synthClick(cineTool());
    const t0 = performance.now();
    while (performance.now() - t0 < maxMs) { if (!(await isMoving())) { log("  ⏸ paused"); return; } await sleep(150); }
  }

  // Wait until canvas content is clearly different from `ref` and stays that way
  // (clip loaded) — works whether the new clip is static or auto-playing.
  // Wait until the next clip has both CHANGED from the previous one AND finished
  // streaming in — i.e. the canvas goes quiet (static, done loading) or settles
  // into steady playback. Engaging cine before frames finish arriving corrupts
  // PureWeb's state ("Unable to determine ordered child for element Frames").
  async function waitForLoad(ref, timeoutMs = 25000) {
    const t0 = performance.now();
    let prev = null, changed = false, stable = 0, moving = 0;
    while (performance.now() - t0 < timeoutMs) {
      await sleep(200);
      const h = frameHash(); if (!h) continue;
      if (!changed && (!ref || diff(h, ref) > CFG.MOTION_THRESH * 3)) changed = true;
      if (changed && prev) {
        if (diff(h, prev) < CFG.MOTION_THRESH) { moving = 0; if (++stable >= 4) return true; }   // ~0.8s still => loaded
        else { stable = 0; if (++moving >= 4) return true; }                                       // steady playback => loaded
      }
      prev = h;
    }
    return null;
  }

  // Record one cine cycle. Waits for confirmed motion before recording (no black
  // intro / no frozen file). The offscreen ffmpeg pass then trims to exactly one
  // loop and stamps the scan date. `meta` carries creationTime + fileName.
  async function captureOneLoop(name, meta = {}) {
    if (!startComposite()) { log("  no render canvas"); return false; }
    if (!(await ensureMotion())) { log("  ⚠ couldn't start cine — skipping (no file saved)"); return false; }
    const first = frameHash();
    startRecording(name, meta);
    const t0 = performance.now(); let frames = 0, movedAway = false, last = first;
    while (rec && driving) {
      await sleep(CFG.SAMPLE_MS);
      const h = frameHash(); if (!h) break;
      frames++;
      const dFirst = diff(h, first);
      if (dFirst > CFG.MOTION_THRESH * 2) movedAway = true;
      const looped = movedAway && frames >= CFG.MIN_LOOP_FRAMES && dFirst < CFG.LOOP_MATCH_THRESH;
      const timedOut = performance.now() - t0 > CFG.MAX_REC_MS;
      if (looped || timedOut) { log(`  ■ ${looped ? "loop" : "maxlen"} (${frames}f)`); stopRecording(); break; }
      setStat(`recording ${name} (f${frames})`); last = h;
    }
    if (!driving && rec) stopRecording();
    while (rec || finalizing) await sleep(50);   // wait for record + ffmpeg+download
    return true;
  }

  const prevSeriesBtn = () => [...document.querySelectorAll('[title="Load previous series"]')].find((e) => e.offsetHeight > 0);

  let driving = false;
  // opts: { all } start from clip 1 (rewinds first), { single } only the current
  // clip, otherwise start from the "this clip is #" box. Captures the current clip
  // then steps forward with "Load next series".
  async function autoDrive(opts = {}) {
    if (driving) { driving = false; log("stopping…"); return; }
    if (!baseCanvas()) { setStat("Open a clip in the viewer first."); log("✗ open a clip first."); return; }
    if (!nextSeriesBtn()) { setStat("Controls not found — is a study open?"); log("✗ controls not found."); return; }
    const total = (discover().uids.length) || worklistTargets().length || 99;

    driving = true; stopComposite(); startComposite();
    const base = await getStudyDateTime();

    if (opts.all && prevSeriesBtn()) {            // rewind to the first clip
      setStat("Going to first clip…"); log("rewinding to clip 1…");
      for (let k = 0; k < total + 5 && driving; k++) {
        const before = frameHash(); synthClick(prevSeriesBtn());
        if (!(await waitForLoad(before, 6000))) break;
      }
      $("#se-start").value = 1;
    }
    if (!driving) { stopComposite(); return; }

    const startIdx = opts.all ? 1 : Math.min(Math.max(1, parseInt($("#se-start").value, 10) || 1), total);
    const lastIdx = opts.single ? startIdx : total;
    const span = lastIdx - startIdx + 1;
    log(`Retrieving videos: clip ${startIdx}${opts.single ? "" : "–" + lastIdx} of ${total}, dated ${fmtCreation(base).slice(0, 10)}.`);
    let dead = 0, doneCount = 0;
    for (let i = startIdx - 1; i < lastIdx && driving; i++) {
      setStat(`Video ${i + 1} of ${total}…`);
      log(`▶ clip ${i + 1}/${total}`);
      // Each clip gets the study date + a 1-minute offset so Photos keeps order.
      const dt = new Date(base.getTime() + i * 60000);
      const meta = { creationTime: fmtCreation(dt), fileName: `${fmtFileDate(dt)}_clip${pad(i + 1)}` };
      const captured = await captureOneLoop(`clip_${pad(i + 1)}`, meta);
      doneCount++; setProgress(doneCount, span);
      if (!driving) break;
      if (opts.single) break;
      let advanced = false;
      if (i < lastIdx - 1) {
        await stopMotion();
        const before = frameHash();
        synthClick(nextSeriesBtn());
        log("  → next clip…");
        advanced = !!(await waitForLoad(before));
        if (advanced) await sleep(800); else log("  (next didn't visibly load — continuing)");
      }
      dead = (captured || advanced) ? 0 : dead + 1;
      if (dead >= 3) { log("  3 clips in a row couldn't start — assuming end; stopping."); break; }
    }
    driving = false; stopComposite();
    setStat(doneCount ? "Done." : "Stopped.");
    log("done.");
  }

  // Save each DISTINCT frame of the current clip as a dated image (for "videos"
  // that are really a compilation of separate pictures). Plays the clip, keeps
  // frames that differ from the last kept one, stops after one cycle.
  const FRAME_DISTINCT = 8;   // mean per-pixel diff that marks a new picture
  function saveCurrentFrame(name, dt) {
    return new Promise((resolve) => {
      composite.toBlob(async (b) => {
        try { download(jpegWithDate(await b.arrayBuffer(), dt), name); } catch (e) {}
        resolve();
      }, "image/jpeg", 0.92);
    });
  }
  async function retrieveFrames() {
    if (driving) { driving = false; log("stopping…"); return; }
    if (!baseCanvas()) { setStat("Open a clip in the viewer first."); log("✗ open a clip first."); return; }
    driving = true; stopComposite(); startComposite();
    const scanDate = await getStudyDateTime();
    const clipNo = Math.max(1, parseInt($("#se-start").value, 10) || 1);
    setStat("Starting clip…"); log(`Saving frames of clip ${clipNo} as images, dated ${fmtCreation(scanDate).slice(0, 10)}…`);
    if (!(await ensureMotion())) { setStat("Couldn't start this clip."); log("  ⚠ couldn't start cine"); driving = false; stopComposite(); return; }
    let first = null, lastKept = null, kept = 0;
    const t0 = performance.now();
    while (driving && performance.now() - t0 < CFG.MAX_REC_MS) {
      setProgress(performance.now() - t0, CFG.MAX_REC_MS);
      const h = frameHash();
      if (h && (!lastKept || diff(h, lastKept) > FRAME_DISTINCT)) {
        if (first && kept > 1 && diff(h, first) < CFG.LOOP_MATCH_THRESH) break;   // looped back to start
        kept++;
        const dt = new Date(scanDate.getTime() + (clipNo - 1) * 60000 + kept * 1000);
        await saveCurrentFrame(`${fmtFileDate(dt)}_clip${pad(clipNo)}_frame${pad(kept)}.jpg`, dt);
        setStat(`Saved ${kept} image(s)…`);
        if (!first) first = h;
        lastKept = h;
      }
      await sleep(70);
    }
    await stopMotion();
    driving = false; stopComposite(); setProgress(1, 1);
    setStat(`Done — ${kept} image(s) saved.`); log(`frames done: ${kept}`);
  }

  // ---- wire up --------------------------------------------------------------
  $("#se-allimg").onclick = harvestStills;
  $("#se-thisimg").onclick = () => { setStat("Saving this image…"); snap(); };
  $("#se-allvid").onclick = () => autoDrive({ all: true });
  $("#se-fromvid").onclick = () => autoDrive({});
  $("#se-thisvid").onclick = () => autoDrive({ single: true });
  $("#se-frames").onclick = retrieveFrames;
  $("#se-copy").onclick = async () => {
    const b = $("#se-copy");
    try { await navigator.clipboard.writeText(logEl.textContent); b.textContent = "Copied"; setTimeout(() => (b.textContent = "Copy log"), 1200); }
    catch (e) { const r = document.createRange(); r.selectNodeContents(logEl); const s = getSelection(); s.removeAllRanges(); s.addRange(r); b.textContent = "Selected"; setTimeout(() => (b.textContent = "Copy log"), 1200); }
  };

  // Stop halts the current retrieval and any recording in progress.
  function stopAll() {
    driving = false; autoOn = false;
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
    if (rec) stopRecording(); else stopComposite();
    setProgress(0, 1); setStat("Stopped.");
    log("■ stopped");
  }
  $("#se-stop").onclick = stopAll;
  window.synStop = stopAll;   // console escape hatch: type  synStop()

  try { const t = discover().uids.length; if (t) { $("#se-of").textContent = "of " + t; $("#se-start").max = t; } } catch (e) {}

  setStat("Ready.");
  log("Ready. Set 'This clip is #' to the clip you're viewing, then choose a Retrieve button.");
})();
