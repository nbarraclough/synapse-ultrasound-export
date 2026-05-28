# Ultrasound Export — Chrome extension

A panel injected into the Synapse Mobility viewer that exports **your own** scans:
full-resolution images and date-stamped video loops, processed entirely
on-device. No terminal, no uploads.

## Install (load unpacked)
1. Chrome → `chrome://extensions`
2. Toggle **Developer mode** (top-right) on.
3. Click **Load unpacked** → select this `extension/` folder.
4. Open the viewer. A dark **Ultrasound Export** panel appears top-right.
   Drag it by its title bar; ✕ hides it (reload the tab to bring it back).

> Host match (in `manifest.json`): `*.ihc.com/viewer*`, `*.intermountain.net/viewer*`.
> For a different Synapse Mobility host, add it to `matches` and reload the extension.

## What each button does

### Images
- **Retrieve all images** — saves one full-resolution image per clip in the study
  (pulled from the viewer's DICOM render proxy). Files: `YYYY-MM-DD_HHMMSS_imageNN.jpg`.
- **Retrieve only this image** — saves the frame currently on screen as a PNG.

### Videos
- **Retrieve all videos** — rewinds to the first clip, then captures every clip in
  the study as a one-loop video, advancing automatically. Walk away.
- **Work with the clip you're viewing** (a card; set *"It's clip number N"* to match
  the clip open in the viewer):
  - **Retrieve this video** — just the current clip.
  - **Retrieve this video + all after it** — current clip through the end (resume point).
  - **Save this video's frames as images** — for "videos" that are really a montage
    of separate pictures: plays the clip and saves each *distinct* frame as a dated
    JPG, stopping after one cycle.

### Other
- **Stop** — halts whatever's running (also: type `synStop()` in the console).
- **Copy log** — copies the activity log to the clipboard (for troubleshooting).
- Progress bar + status line show what's happening; the log shows per-clip detail.

## How it works (short version)
- **Images** come from the DICOM render proxy as full-res JPEGs; the extension
  reads the study/clip list from the page's own already-loaded requests, and embeds
  the **scan date** in each image's EXIF (so Google Photos dates them correctly).
- **Videos** are *rendered server-side and streamed to a `<canvas>`* (PureWeb), so
  there's no downloadable file. The extension composites the render + overlay
  canvases, records the loop, then an on-device **ffmpeg.wasm** pass (in an offscreen
  document) trims it to exactly one cycle, transcodes to H.264 MP4, and stamps the
  scan date as `creation_time`.
- **Auto-drive** opens/plays/advances clips by dispatching synthetic clicks on the
  viewer's own controls (the Cine tool and "Load next series"), because the viewer
  exposes no callable API. It waits for each clip to finish loading before engaging
  cine (engaging mid-stream corrupts the viewer's state).

See the repo root `README.md` for the full architecture and `JOURNEY.md` for how it
was built and debugged.

## Files
```
manifest.json    MV3 manifest (host match, offscreen permission, wasm CSP)
content.js       the panel + capture + auto-drive + image EXIF dating
background.js    service worker; owns the offscreen document, relays ffmpeg jobs
offscreen.html   loads the ffmpeg core + offscreen.js
offscreen.js     runs ffmpeg.wasm: loop detection, trim, transcode, date-stamp
vendor/          bundled single-thread ffmpeg.wasm core (see vendor/SOURCE.md)
```

## If the viewer changes
The extension depends on a handful of the viewer's CSS class names / labels. If
Fujifilm updates Synapse Mobility's UI, these may need refreshing (all near the top
of `content.js` or in the cine/date helpers):
- worklist study date: `.date-time .primary.date`  (DOB is `.patient-dob`, excluded)
- cine engage: `.icon-tool-Cine`; play/pause: `.playback-control`
- advance: button titled **"Load next series"** (and **"Load previous series"**)
- render canvases: `canvas[id^="cnv_"]` (image) + `canvas[id^="acetate_"]` (overlay)

## Privacy
Everything runs in your authenticated browser session, on-device. Nothing is
uploaded. Retrieved files contain the burned-in identifiers the viewer shows
(patient banner, etc.) — handle them like any medical record.
