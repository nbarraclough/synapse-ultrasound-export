# Bundled third-party: ffmpeg.wasm core

These two files are the **single-threaded** build of the ffmpeg.wasm core. They
run inside the extension's offscreen document to trim, transcode, and date-stamp
the captured video — entirely on-device, no uploads.

| File | What | Source |
|------|------|--------|
| `ffmpeg-core.js` | Emscripten loader (`createFFmpegCore`) | `@ffmpeg/core@0.12.10` |
| `ffmpeg-core.wasm` | the ffmpeg WebAssembly binary (~31 MB) | `@ffmpeg/core@0.12.10` |

Downloaded from jsDelivr:

```
https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.js
https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.wasm
```

We drive the core **directly in the offscreen page's main thread** (no
`@ffmpeg/ffmpeg` wrapper, no web worker, no `blob:` URLs) because MV3 forbids
`blob:` in the extension CSP and a worker can't `importScripts` a
`chrome-extension://` URL. The core gets its `.wasm` path via the
`mainScriptUrlOrBlob` `#hash` convention. See `../offscreen.js`.

## License & attribution

`@ffmpeg/core` (these two files) is **LGPL-2.1-or-later** — see
[`LICENSE-LGPL-2.1.txt`](LICENSE-LGPL-2.1.txt) in this directory. The full text
of that license applies to **the bundled `ffmpeg-core.js` and `ffmpeg-core.wasm`
only**; the rest of this repository is MIT-licensed (see top-level `LICENSE`).

- SPDX-License-Identifier (these files): `LGPL-2.1-or-later`
- Corresponding source code and build instructions:
  https://github.com/ffmpegwasm/ffmpeg.wasm (the `@ffmpeg/core` package)
- The underlying FFmpeg sources used to build the core are LGPL'd and available
  from https://ffmpeg.org/ and the ffmpeg.wasm repository above.

No modifications have been made to either bundled file — they are the unmodified
UMD build of `@ffmpeg/core@0.12.10` as fetched from jsDelivr.
