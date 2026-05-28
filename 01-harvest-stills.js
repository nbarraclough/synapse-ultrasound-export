/* ============================================================================
 * Synapse Mobility — full-res STILL harvester  (run in the viewer's DevTools console)
 * ----------------------------------------------------------------------------
 * Pulls one full-resolution representative frame for EVERY series in the open
 * study, straight from the DICOM render proxy. No clicking through the worklist.
 *
 * Each ultrasound clip is a multi-frame object; the proxy renders a single
 * representative frame per object at whatever size you ask (it caps at native,
 * ~1136x852 here). Machine-burned annotations (labels, GA, measurements) are in
 * the DICOM pixels, so they come through; viewer-only overlays do not.
 *
 * Files download to your browser's default download folder as still_NN.jpg.
 * Move them into  synapse-ultrasound-export/stills/  afterwards.
 *
 * Chrome will ask "Download multiple files?" the first time — click Allow.
 * ==========================================================================*/
(async () => {
  const BASE = location.origin + "/pureweb";
  const SIZE = 4096;          // requested px; server returns native (no upscale)
  const QUALITY = 100;
  const GAP_MS = 350;         // be gentle on the server between requests
  const enc = encodeURIComponent;

  // --- Discover study, repo, and series UIDs from the browser's OWN traffic ---
  // The worklist already fetched a thumbnail for every clip on load, e.g.:
  //   /pureweb/dicom/series/{UID}/thumbnail?...&StudyInstanceUID=...&DicomRepository=...
  // We read those back from resource-timing instead of re-calling the list API
  // (which SSO-gates and 302-redirects when the session ages out). Zero-config
  // per scan, and avoids the fragile endpoint entirely.
  const res = performance.getEntriesByType("resource").map(e => e.name);
  const seen = new Map(); // UID -> {study, repo}
  let study = null, REPO = null;
  const rx = /\/dicom\/series\/([^/]+)\/thumbnail\?/;
  for (const u of res) {
    const m = u.match(rx);
    if (!m) continue;
    const uid = decodeURIComponent(m[1]);
    const q = new URL(u).searchParams;
    const s = q.get("StudyInstanceUID"), r = q.get("DicomRepository");
    if (s) study = s;
    if (r) REPO = r;
    if (!seen.has(uid)) seen.set(uid, { study: s, repo: r });
  }
  let seriesList = [...seen.keys()].map(uid => ({ SeriesInstanceUID: uid }));

  if (!seriesList.length || !study) {
    console.error("Couldn't find loaded thumbnails in resource-timing. Reload the viewer, " +
                  "let the worklist render, then re-run this script. " +
                  "(If you just re-logged-in via SSO, give it a moment and reload.)");
    return;
  }
  console.log(`Found ${seriesList.length} clips in study ${study} @ ${REPO}`);

  const dl = (blob, name) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const pad = n => String(n).padStart(2, "0");

  console.log(`Harvesting ${seriesList.length} stills from study ${study} ...`);
  const manifest = [];
  let i = 0;
  for (const s of seriesList) {
    i++;
    const uid = s.SeriesInstanceUID;
    let url = `${BASE}/dicom/series/${enc(uid)}/thumbnail`;
    url += `?columns=${SIZE}&rows=${SIZE}&imageQuality=${QUALITY}`;
    url += `&StudyInstanceUID=${enc(study)}&DicomRepository=${enc(REPO)}`;
    try {
      // redirect:"manual" => an SSO bounce surfaces as an opaqueredirect we can
      // catch, instead of a cross-origin CORS exception.
      const r = await fetch(url, { credentials: "include", redirect: "manual" });
      if (r.type === "opaqueredirect" || r.status === 0) {
        console.error(`✗ Session expired (redirected to SSO) after ${manifest.length} stills.`);
        console.error("→ Reload the viewer tab, re-authenticate, confirm an image loads, then re-run.");
        break;
      }
      if (!r.ok) { console.error(pad(i), "✗ HTTP", r.status); continue; }
      const blob = await r.blob();
      const name = `still_${pad(i)}.jpg`;
      dl(blob, name);
      const bmp = await createImageBitmap(blob).catch(() => null);
      console.log(pad(i), "✓", name, bmp ? `${bmp.width}x${bmp.height}` : "", `${(blob.size/1024|0)}KB`);
      manifest.push({ n: i, file: name, seriesUID: uid });
    } catch (e) {
      console.error(pad(i), "✗ failed:", e.message);
    }
    await sleep(GAP_MS);
  }
  if (!manifest.length) return;
  // Drop a manifest so you can map files back to series UIDs later.
  dl(new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" }), "stills_manifest.json");
  console.log(`Done. ${manifest.length} stills + manifest downloaded.`);
})();
