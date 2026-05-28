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

License: ffmpeg.wasm is MIT; the underlying FFmpeg is LGPL/GPL. See
https://github.com/ffmpegwasm/ffmpeg.wasm.
