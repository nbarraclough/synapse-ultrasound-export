#!/usr/bin/env python3
"""
Split a cine video into its individual DISTINCT frames as dated JPGs.

For "videos" that are really a compilation of separate pictures, this keeps each
unique picture (ffmpeg `mpdecimate` drops near-duplicate frames) and stamps each
with the scan date in EXIF (read from the video's creation_time) so Google Photos
dates/orders them — same as the rest of the toolkit.

Usage:
    python3 frames-from-video.py INPUT.mp4 [OUTDIR]
    python3 frames-from-video.py INPUT.mp4 OUTDIR --all   # keep ALL frames, no de-dupe

Output: OUTDIR/<YYYY-MM-DD_HHMMSS>_<name>_frameNN.jpg   (default OUTDIR = ./frames)
Needs ffmpeg + ffprobe + python3 (stdlib only).
"""
import subprocess, sys, os, re, tempfile, datetime


def video_date(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format_tags=creation_time",
         "-of", "default=nk=1:nw=1", path], capture_output=True, text=True).stdout.strip()
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})", out)
    if m:
        return datetime.datetime(*map(int, m.groups()))
    return datetime.datetime.fromtimestamp(os.path.getmtime(path))  # fallback


def exif_jpeg(data: bytes, dt: datetime.datetime) -> bytes:
    """Insert a minimal EXIF APP1 (DateTime/Original/Digitized) after SOI."""
    if data[:2] != b"\xff\xd8":
        return data
    import struct
    ds = dt.strftime("%Y:%m:%d %H:%M:%S") + "\x00"          # 20 bytes
    t = bytearray(88)
    struct.pack_into("<2sHI", t, 0, b"II", 42, 8)            # TIFF header, IFD0 @ 8
    struct.pack_into("<H", t, 8, 2)                          # IFD0: 2 entries
    struct.pack_into("<HHII", t, 10, 0x0132, 2, 20, 68)      # DateTime -> str@68
    struct.pack_into("<HHII", t, 22, 0x8769, 4, 1, 38)       # Exif IFD ptr -> 38
    struct.pack_into("<I", t, 34, 0)                         # next IFD = 0
    struct.pack_into("<H", t, 38, 2)                         # ExifIFD: 2 entries
    struct.pack_into("<HHII", t, 40, 0x9003, 2, 20, 68)      # DateTimeOriginal
    struct.pack_into("<HHII", t, 52, 0x9004, 2, 20, 68)      # DateTimeDigitized
    struct.pack_into("<I", t, 64, 0)
    t[68:88] = ds.encode("ascii")[:20]
    app1 = b"\xff\xe1" + struct.pack(">H", 2 + 6 + len(t)) + b"Exif\x00\x00" + bytes(t)
    return b"\xff\xd8" + app1 + data[2:]


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    keep_all = "--all" in sys.argv
    if not args:
        print(__doc__); sys.exit(1)
    inp = args[0]
    outdir = args[1] if len(args) > 1 else "frames"
    os.makedirs(outdir, exist_ok=True)
    name = os.path.splitext(os.path.basename(inp))[0]
    name = re.sub(r"^\d{4}-\d{2}-\d{2}_\d{6}_", "", name)   # drop any existing date prefix
    name = re.sub(r"[^A-Za-z0-9_-]+", "_", name)
    base = video_date(inp)

    with tempfile.TemporaryDirectory() as tmp:
        vf = "mpdecimate=hi=64*12:lo=64*5:frac=0.33" if not keep_all else "null"
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", inp,
             "-vf", vf, "-vsync", "vfr", "-q:v", "2", os.path.join(tmp, "f_%04d.jpg")],
            check=True)
        files = sorted(f for f in os.listdir(tmp) if f.endswith(".jpg"))
        if not files:
            print("No frames extracted."); return
        for i, f in enumerate(files):
            raw = open(os.path.join(tmp, f), "rb").read()
            dt = base + datetime.timedelta(seconds=i)          # +1s each, preserves order
            out = exif_jpeg(raw, dt)
            fn = f"{dt.strftime('%Y-%m-%d_%H%M%S')}_{name}_frame{i+1:02d}.jpg"
            open(os.path.join(outdir, fn), "wb").write(out)
        print(f"{len(files)} distinct frame(s) -> {outdir}/  (dated {base:%Y-%m-%d})")


if __name__ == "__main__":
    main()
