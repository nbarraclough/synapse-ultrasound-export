/* Service worker: owns the offscreen document and relays ffmpeg jobs.
 * Content scripts can't run ffmpeg.wasm (host-page CSP) or call chrome.offscreen,
 * so they send {type:"ff", cmd, payload} here; we ensure the offscreen doc exists
 * and forward to it, relaying the response back. */

let creating = null;
async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument?.();
  if (has) return;
  if (!creating) {
    creating = chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["BLOBS"],
      justification: "Run ffmpeg.wasm to trim, transcode, and date-stamp captured ultrasound cine loops.",
    });
  }
  try { await creating; } finally { creating = null; }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "ff") return;        // only handle content-script ff requests
  (async () => {
    try {
      await ensureOffscreen();
      const resp = await chrome.runtime.sendMessage({ target: "offscreen", cmd: msg.cmd, payload: msg.payload });
      sendResponse(resp);
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.stack) || e) });
    }
  })();
  return true;  // async response
});
