/* ============================================================================
 * Synapse Mobility — CINE recorder  (run in the viewer's DevTools console)
 * ----------------------------------------------------------------------------
 * The moving ultrasound loops only exist as the server renders them into the
 * viewer's <canvas> during playback — there is no per-frame REST endpoint. So
 * we composite the base render + the overlay ("acetate") canvas and record the
 * loop AS IT PLAYS, pixel-exact and auto-cropped to just the image (no screen
 * chrome). Output is a .webm; 03-assemble.sh turns it into a clean .mp4.
 *
 * WORKFLOW (per loop you want as video):
 *   1. Open the clip in the main viewer.
 *   2. cineRec.start("label")     // label is optional; used in the filename
 *   3. Press the viewer's cine/play button and let the loop run 1-2 full cycles.
 *   4. cineRec.stop()             // a .webm downloads
 *   Move downloaded .webm files into  synapse-ultrasound-export/cine-webm/
 *
 * Bonus:
 *   cineRec.snap("label")         // grab a single full-res PNG of the current
 *                                 // frame (base + overlays), 1346x887 here.
 * ==========================================================================*/
(() => {
  const findCanvases = () => ({
    base: document.querySelector('canvas[id^="cnv_"]'),
    acetate: document.querySelector('canvas[id^="acetate_"]'),
  });

  const pickMime = () => {
    const c = [
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm",
    ];
    return c.find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || "";
  };

  const download = (blob, name) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const safe = s => (s || "loop").replace(/[^a-z0-9_-]+/gi, "_");

  const cineRec = {
    _raf: null, _rec: null, _chunks: [], _composite: null, _label: "loop",

    start(label = "loop") {
      if (this._rec) { console.warn("Already recording. Call cineRec.stop() first."); return; }
      const { base, acetate } = findCanvases();
      if (!base) { console.error("No render canvas found — open a clip in the main viewer first."); return; }
      this._label = label;

      const w = base.width, h = base.height;
      const comp = Object.assign(document.createElement("canvas"), { width: w, height: h });
      const ctx = comp.getContext("2d");
      this._composite = comp;

      // Continuously composite base + overlay so captureStream always has the
      // latest rendered frame, even between server pushes.
      const draw = () => {
        ctx.drawImage(base, 0, 0, w, h);
        if (acetate) ctx.drawImage(acetate, 0, 0, w, h);
        this._raf = requestAnimationFrame(draw);
      };
      draw();

      const stream = comp.captureStream(30);
      const mime = pickMime();
      this._chunks = [];
      this._rec = new MediaRecorder(stream, {
        mimeType: mime || undefined,
        videoBitsPerSecond: 12_000_000, // high bitrate; transcode later
      });
      this._rec.ondataavailable = e => { if (e.data.size) this._chunks.push(e.data); };
      this._rec.onstop = () => {
        cancelAnimationFrame(this._raf);
        const blob = new Blob(this._chunks, { type: "video/webm" });
        const name = `${safe(this._label)}_${stamp()}.webm`;
        download(blob, name);
        console.log("✓ saved", name, `${(blob.size/1024/1024).toFixed(1)}MB  ${w}x${h}`);
        this._rec = null; this._composite = null; this._chunks = [];
      };
      this._rec.start();
      console.log(`● recording "${label}" (${w}x${h}, ${mime || "default"}). Play the cine loop, then cineRec.stop().`);
    },

    stop() {
      if (!this._rec) { console.warn("Not recording."); return; }
      this._rec.stop();
    },

    snap(label = "frame") {
      const { base, acetate } = findCanvases();
      if (!base) { console.error("No render canvas found."); return; }
      const w = base.width, h = base.height;
      const comp = Object.assign(document.createElement("canvas"), { width: w, height: h });
      const ctx = comp.getContext("2d");
      ctx.drawImage(base, 0, 0, w, h);
      if (acetate) ctx.drawImage(acetate, 0, 0, w, h);
      comp.toBlob(b => {
        download(b, `${safe(label)}_${stamp()}.png`);
        console.log("✓ snap", `${w}x${h}`, `${(b.size/1024|0)}KB`);
      }, "image/png");
    },
  };

  window.cineRec = cineRec;
  console.log('cineRec ready →  cineRec.start("label") · cineRec.stop() · cineRec.snap("label")');
})();
