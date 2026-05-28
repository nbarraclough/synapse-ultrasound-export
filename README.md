# Ultrasound Export

Export **your own** ultrasound scans — full-resolution images and date-stamped
video loops — from a **Synapse Mobility** web viewer that has no export button.
Everything runs on-device in your own authenticated browser session. Nothing is
uploaded.

---

## What it is

Fujifilm **Synapse Mobility** is a hospital image viewer. In many deployments the
export/download button is disabled, so patients can view their scans but can't get
copies out. This project is a small **Chrome extension** (plus a couple of optional
helper scripts) that retrieves your scans from the viewer you're already authorized
to use, and saves them as ordinary files:

- **Images** → full-resolution JPGs, one per series, with the scan date embedded in
  EXIF.
- **Videos** → the cine loops, captured and trimmed to one clean cycle, saved as
  H.264 **MP4** with the scan date in `creation_time`.

Files are named and dated so they drop straight into Google Photos / Apple Photos
on the right day, in order.

## Why you'd use it

- **Get your own records out.** You're entitled to your medical images; this gets
  them without a CD-burning request or a disabled button.
- **Keepsakes & sharing.** Turn a maternity or diagnostic scan into clips and stills
  you can actually keep, watch, and send to family.
- **Correct dates.** The exports carry the *scan* date, not today's date, so a whole
  pregnancy's worth of scans sorts correctly in your photo library.
- **On-device & private.** No server, no upload, no third party — it works inside the
  viewer tab you've already logged into.

> This is for retrieving **your own** scans (or scans you're authorized to access).
> See [Privacy & ethics](#privacy--ethics).

## How it works

Synapse Mobility is built on **PureWeb pixel-streaming**: the images are rendered on
the server and streamed to your browser, so there's no image file sitting in the
page to "save as." Two different paths get the pixels out:

**Images — DICOM render proxy.** The viewer has a REST endpoint that renders any
series to a JPEG at a requested size:
`/pureweb/dicom/series/{uid}/thumbnail?columns=…&imageQuality=100`. The extension
reads the study's clip list from the page's *own already-loaded requests* (so it
needs no fragile API calls), then pulls each clip at full resolution. It injects a
minimal **EXIF** block (`DateTimeOriginal`) so photo apps date the images.

**Videos — canvas capture + on-device ffmpeg.** The live view renders into two
same-origin `<canvas>` elements (the image + an overlay "acetate" layer). The
extension composites them and records the cine loop with `MediaRecorder` while it
plays. A bundled **ffmpeg.wasm** (running in an MV3 *offscreen document*) then:
1. fingerprints the frames and finds the **loop period** (a stored cine repeats
   near-identically), trimming to exactly one clean cycle;
2. transcodes to **H.264 MP4** with `+faststart`;
3. stamps the **scan date** as `creation_time`.

**Auto-drive.** To do all 35+ clips unattended, the extension dispatches synthetic
clicks on the viewer's *own* controls — the **Cine** tool to start playback and
**"Load next series"** to advance — because the viewer exposes no callable API. It
waits for each (often slow-loading) clip to finish streaming before engaging cine,
which is essential: engaging mid-stream corrupts PureWeb's render state.

Full play-by-play of the design, the dead ends, and the fixes is in
**[JOURNEY.md](JOURNEY.md)**.

## Repository layout

```
extension/              ← the main product (a Chrome MV3 extension)
  manifest.json
  content.js            panel UI + capture + auto-drive + image EXIF dating
  background.js         service worker; owns the offscreen ffmpeg document
  offscreen.html/js     runs ffmpeg.wasm (loop-trim, transcode, date-stamp)
  vendor/               bundled single-thread ffmpeg.wasm core (see SOURCE.md)
  README.md             button-by-button reference

scripts / snippets (optional, for power users):
  trim_to_one_loop.py   trim an exported video to exactly one loop (python+ffmpeg)
  frames-from-video.py  split a "compilation" video into distinct dated frames
  03-assemble.sh        batch webm→mp4 (+ --trim / --gif / --frames)
  01-harvest-stills.js  original paste-in-console image grabber (pre-extension)
  02-cine-recorder.js   original paste-in-console loop recorder (pre-extension)

JOURNEY.md              how this was built, tested, and debugged
.gitignore              keeps ALL retrieved media & identifiers out of the repo
```

The console snippets (`01`/`02`) and the Python/shell scripts are kept because they
document the path to the extension and remain handy with zero install — but the
**extension is the product**; start there.

## Quick start

1. `chrome://extensions` → **Developer mode** on → **Load unpacked** → pick the
   `extension/` folder.
2. Open your Synapse Mobility study. A dark **Ultrasound Export** panel appears.
3. **Images:** click *Retrieve all images*.
4. **Videos:** open the first clip, click *Retrieve all videos*, and walk away —
   or use the "Work with the clip you're viewing" card to grab a single clip,
   resume from a point, or split a montage clip into individual frames.

See [`extension/README.md`](extension/README.md) for every button, and for the
viewer-selector caveats if Fujifilm changes the UI.

## Requirements
- Chrome (or Chromium) recent enough for MV3 offscreen documents (Chrome ≥ 116).
- The Python/shell helpers need `ffmpeg` + `ffprobe` (and `python3` for the `.py`).
  The extension needs nothing extra — ffmpeg.wasm is bundled.

## Privacy & ethics
- Use this only for **your own** scans, or scans you're authorized to access. In the
  US, patients have a right of access to their records (HIPAA); this is a way to
  exercise it on images you can already view.
- It runs entirely **on-device**, inside your authenticated session. No uploads, no
  external services.
- Retrieved files contain whatever identifiers the viewer burns into the image
  (patient banner, dates, measurements). Treat them like any medical record.
- This repository contains **only the tool** — no patient media or identifiers (see
  `.gitignore`).

## Limitations
- It depends on Synapse Mobility's current UI (a few CSS selectors / button labels);
  a viewer update may require refreshing them (documented in `extension/README.md`).
- Video is captured from the live render at display resolution — full motion, but a
  rendered copy, not the original DICOM. For diagnostic-grade originals, your imaging
  facility can release the source DICOMs.

## Things to think about before sharing it

This isn't legal advice — just a list of the considerations worth weighing if you
plan to share it beyond yourself (especially publicly). Talk to a lawyer if you
want certainty.

- **Viewer Terms of Service.** Your imaging provider's portal likely has terms
  that may restrict automated access, scraping, or reverse engineering. Worth a
  read, and worth more thought if you'd be distributing this to non-patients.
- **Use case.** Using it on **your own** medical records (or those of someone
  you're legally authorized to act for) sits in a very different place than using
  it on data you weren't given access to. This project is built for the former.
- **Patient data.** Nothing patient-identifying is in this repo (the `.gitignore`
  blocks media, manifests, and `.har` files), and the code contains no hardcoded
  identifiers. If you fork or extend it, keep that boundary.
- **Third-party licensing.** Most of the repo is MIT (see [`LICENSE`](LICENSE)).
  The bundled `extension/vendor/ffmpeg-core.{js,wasm}` files are **LGPL-2.1**
  — see [`extension/vendor/SOURCE.md`](extension/vendor/SOURCE.md) and
  [`extension/vendor/LICENSE-LGPL-2.1.txt`](extension/vendor/LICENSE-LGPL-2.1.txt)
  for attribution and a pointer to the corresponding sources.
- **Clinical use.** This is **not** a medical device, has no clinical
  certification, and must not be used for clinical decision-making.
- **Jurisdiction.** Laws vary by country and state. This repo is the tool, not
  legal cover.

The repo is currently **private** — a deliberate choice. Sharing publicly is a
larger surface area; if you do, it's worth at least the conversations above.

## No warranty, no guarantees, no support

Released under the **MIT License** (see [`LICENSE`](LICENSE)) — i.e. provided
**as is**, with **no warranty of any kind**. To say it without legalese:

- It might break tomorrow if Fujifilm changes Synapse Mobility's UI.
- It might not work in your environment, your viewer, or your browser version.
- It is **not** a medical device and has **no** clinical certification — don't
  use it for clinical decision-making.
- Nobody is obligated to fix it, answer questions, or accept changes.

Use it on your own scans, at your own risk. Issues and PRs are welcome but
there's no commitment to review them.

## Acknowledgements
Built in a single session with **Claude** (Anthropic). The collaboration — including
every wrong turn and fix — is documented in [JOURNEY.md](JOURNEY.md).
