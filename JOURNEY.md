# The Journey

How this tool was built — in one session, with Claude — including every wrong turn
and how we got past it. It's a fairly honest record: the value here is as much in
the dead ends as the destination.

The pattern throughout: **probe the real system → form a hypothesis → test it against
real data → fix → re-test.** Almost nothing worked first try; almost everything was
solvable once we looked at the actual bytes instead of guessing.

---

## 0. The starting point

A Synapse Mobility viewer with **no export button**, a CleanShot of an ultrasound,
and a `.har` of the first page load. Goal: get the images and videos out.

The first HAR had a single request — a config call returning `[]`. From that alone I
jumped to a confident, **wrong** conclusion: "Synapse Mobility is PureWeb
pixel-streaming, so the images are rendered server-side and there's nothing
downloadable; you'll have to screen-record." Architecturally true, practically wrong.

**Lesson 1: a 200ms HAR of a page's first load tells you almost nothing.** The user
pushed back with a second screenshot — the DevTools Network tab showing actual
`image/jpeg` responses — and that reset the whole investigation.

## 1. Finding the real seams

A fuller HAR (captured while *browsing*) changed everything. Inside:

- A **DICOM REST proxy**: `/pureweb/dicom/series/{uid}/thumbnail?columns=40&rows=40&imageQuality=100`.
  The worklist loads tiny 40×40 thumbnails this way — but the size params are
  arbitrary.
- A **series catalog** (`/dicom/series?StudyInstanceUID=…`) listing 34 series, all
  ultrasound, each a multi-frame object (20–248 frames).

A few console probes (run by the user, in their authenticated session) established:

| Probe | Result |
|------|--------|
| `thumbnail?columns=2000` | **full-res** JPEG (server caps at native ~1136×852) ✅ |
| `thumbnail` + `frameNumber=N` | ignored — only ever one representative frame ❌ |
| `/dicom/instances/{sop}` | metadata XML only; `/frames/N` and `/rendered` → 404 ❌ |
| DOM inspection | the live view renders into two `<canvas>` (`cnv_` image + `acetate_` overlay), same-origin, readable ✅ |

**Conclusion:** images can be pulled full-res over REST; per-frame cine has **no**
REST path, so video must come from the **canvas**. Two completely different
extraction strategies for two media types.

## 2. Console scripts (the proof)

Before building anything fancy, we proved each path with paste-in-console scripts:

- **Stills harvester.** First version called the series-list API — which promptly
  **302-redirected to the SSO login** when the session aged, surfacing as a confusing
  CORS error. Fix: don't call that fragile endpoint at all — read the clip UIDs from
  the browser's **own resource-timing log** (the worklist already fetched them).
  Result: 35 full-res JPGs, zero config. *(Lesson 2: the most reliable API call is
  the one you don't make — reuse what the page already loaded.)*
- **Cine recorder.** Composite `cnv_` + `acetate_` into one canvas, `captureStream()`
  → `MediaRecorder` → WebM. A canvas-readability probe first confirmed the WebGL
  canvas wasn't tainted and read back real pixels.
- **Assemble.** An ffmpeg script to turn the WebM into MP4.

This worked end-to-end on one clip. Then the scope grew: **35 clips, and more scans
to come.** Paste-per-clip wouldn't scale.

## 3. The decision: a Chrome extension

Rather than a pile of snippets, package it. But the extension can't remove the one
real constraint — cine motion only exists during live playback — so the question
became *how automated can it be?*

Probes to find out:
- The viewer is **AngularJS 1.8.2** using `controllerAs`, so scope methods aren't
  enumerable — no callable API.
- But a synthetic-click test on **"Load next series"** changed the canvas within 1s:
  **synthetic clicks register.** That made full hands-free auto-drive possible.
- Mapped the controls: worklist thumbnails (0×0, no `ng-click`), the **Cine tool**
  (`icon-tool-Cine`), per-view **play/pause** (`.playback-control`), and prev/next
  series buttons.

So: drive the viewer's own buttons. Capture from canvas. Trim + date with ffmpeg.

## 4. The bug gauntlet

This is where most of the work was. Each was found by **running it and reading the
log**, then often by **examining the actual output file**.

**Stop didn't stop.** The Stop button only stopped the current recording, not the
auto-drive loop, and the loop's internals were trapped in a closure. Fix: a real
`stopAll()` wired to the button **and** exposed as `window.synStop()`.

**Clips wouldn't play after advancing.** Auto-drive recorded black-then-frozen 25s
files. A diagnostic revealed the recipe: a freshly-loaded clip is *static with no
playback bar* — you must click the **Cine tool** to engage it, but only *if it's not
already moving* (it's a toggle; clicking a playing clip stops it). Fix: check motion
first, engage cine only when static.

**Black intros / frozen files.** Recording started before the clip rendered. Fix:
**wait for confirmed motion before recording** — which also meant no more frozen
captures.

**"It hit max length — why?"** Long clips never tripped the live (grayscale) loop
detector, so they ran to the 25s safety cap. That's fine *if* the post-trim then cuts
them — but it didn't, which exposed the real saga…

### The trim saga (four wrong detectors)

Turning a recording into exactly one loop took several attempts, each fixed by
plotting the actual lag-vs-similarity curve of a real clip:

1. **Naive global-min** → collapsed to the shortest lag (slow cine has near-identical
   adjacent frames). 6-frame, 0.2s "loops."
2. **"Peak then first local min"** → grabbed a noise wiggle on the rising edge. Still
   far too short.
3. **Grayscale fingerprints** → blind to a **colour-Doppler** clip (B-mode barely
   moves; only the colour flashes). Switched to **RGB** fingerprints.
4. **Half-length search + absolute confidence gate** → a ~1.9-loop recording has its
   period *beyond* half the clip (never searched), and real captures have timing
   jitter so absolute match-costs (12–29) failed a <9 gate.

The fix came from **dumping the curve** for the stubborn clip (clip 5):

```
lag 263 → cost 0.3    ← the true loop (near-perfect match)
lag 526 → cost 0.7    ← exactly 2× (harmonic)
```

The periodicity was crystal clear all along. Final detector: **global-minimum lag
over [0.8s, n−overlap], preferring the fundamental over its harmonic, confident when
the dip is far below the curve's peak.** Validated on the real files: clip 5 **25s →
8.7s**, clip 7 **20s → 5.0s**, and already-one-loop clips correctly left untrimmed.
*(Lesson 3: stop guessing at heuristics — plot the signal.)*

**The drive stopped at clip 16/35.** One clip that couldn't start cine caused the
next advance's load-check to time out, which was misread as "end of list." Fix: only
stop after **3 dead clips in a row**; one stubborn clip is skipped, not fatal.

**The viewer corrupted itself.** The logs showed PureWeb errors —
`Unable to determine ordered child for element Frames` — when the Cine tool was
toggled repeatedly while a clip was still streaming in. Two fixes: **never toggle
when cine's already engaged** (throttle, prefer the explicit play control), and
**wait for the clip to finish loading before engaging cine**.

**Resume from anywhere.** The user asked for it directly — a "this clip is #" control
so a run can start mid-study instead of restarting from clip 1.

### Dates (so Photos behaves)

Google Photos orders by embedded date. Getting the **scan** date (not today's):
- The series-list JSON has `StudyDate`/`StudyTime` — but it's **SSO-gated** and often
  fell back to "now."
- Fix: **scrape the worklist's date element** — confirmed via probe to be
  `.date-time .primary.date`, structurally distinct from the patient **DOB**
  (`.patient-dob`), so we never grab the birth date.
- Videos embed it as `creation_time`. Then the user caught that **images had no
  embedded date** — only a filename. So we hand-built a minimal **EXIF** block
  (`DateTimeOriginal`) and injected it into each JPG, **validated with Pillow** that a
  real reader parses it back as `2026:05:26 …`.

### ffmpeg, in the browser, in MV3

The user chose a fully self-contained tool, which meant running ffmpeg **inside the
extension**. That fought MV3 at every turn:
- A content script can't run ffmpeg (host-page CSP) → moved it to an MV3 **offscreen
  document** managed by the service worker.
- The `@ffmpeg/ffmpeg` wrapper spawns a worker that `importScripts` a
  `chrome-extension://` URL → **"Cannot find module."**
- The standard `blob:` workaround → **MV3 forbids `blob:` in `script-src`.**
- Fix: bundle the **single-thread** core and drive it **directly in the offscreen
  page's main thread** — no wrapper, no worker, no blob — pointing it at the bundled
  `.wasm` via the `mainScriptUrlOrBlob` hash convention. First clean
  `✓ ffmpeg.wasm loaded OK`.

## 5. Packaging for humans

Once it worked, the user (rightly) pushed on UX for sharing in a medical setting:
- **Plain language** — "Retrieve all images / this video / …", no "harvest", "cine",
  "auto-drive", "loop" jargon.
- The clip-number grouped **with** the actions that use it; the clunky "all videos
  from this clip" → "**Retrieve this video + all after it**."
- A **solid** progress bar (no gradient), plain-English status, and a **Copy log**
  button for troubleshooting.
- A **"Save this video's frames as images"** button — the in-browser twin of
  `frames-from-video.py` — for clips that are really a montage of separate pictures.

## How we tested

There was no unit-test suite — the system under test is a live, authenticated,
server-streamed medical viewer. So testing was **empirical and tight-loop**:

- **Real-data validation at every step.** Detectors were proven against the actual
  exported files — `ffprobe` for duration/`creation_time`, **Pillow** for EXIF,
  frame-hashing to confirm motion and loop period. When a detector misbehaved, we
  **plotted the real curve** rather than theorizing.
- **A Python twin of the trim** (`trim_to_one_loop.py`) let us iterate the
  loop-detection algorithm *locally* against downloaded clips before porting the
  identical logic into `offscreen.js`.
- **The user as the live harness.** Browser-side behaviour was verified by the user
  reloading the extension, running it, and pasting the activity log back — which is
  exactly why a **Copy log** button ended up in the final UI.
- **Bias toward safe failure.** Every fix preferred "save the full clip / skip and
  continue / keep going" over "produce a 0.2s file / halt the batch," so a bad clip
  never cost the whole run.

## What it became

```
viewer (PureWeb)
  ├─ images:  DICOM render proxy ──► full-res JPG ──► +EXIF scan date
  └─ videos:  cine on <canvas> ──► MediaRecorder ──► ffmpeg.wasm
                                      (loop-trim + H.264 + creation_time)
  auto-drive: synthetic clicks on the viewer's own Cine / next-series controls,
              waiting for each clip to load before engaging cine
```

A handful of CSS selectors, two canvases, one REST endpoint, a 31 MB WebAssembly
ffmpeg, and a lot of reading-the-actual-bytes. Built in a session — wrong turns and
all.
