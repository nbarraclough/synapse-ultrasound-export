#!/usr/bin/env python3
"""
Trim a captured cine recording to exactly ONE loop.

A stored ultrasound cine plays a fixed set of frames over and over, pixel-
identical each cycle. So we find the period by autocorrelation of tiny
grayscale frame fingerprints, then cut a single period to a clean MP4.

Dependency-free: needs only ffmpeg + ffprobe + python3 stdlib.

Usage:
    python3 trim_to_one_loop.py INPUT.webm OUTPUT.mp4
"""
import subprocess, sys

N = 16                 # fingerprint is NxN
FPS = 30               # normalize to constant fps (MediaRecorder timebase is unreliable)
COST_CEIL = 40         # sanity ceiling on the match cost (0-255 scale)


def read_fingerprints(path):
    """Pipe constant-fps NxN RGB frames out of ffmpeg as raw bytes (RGB so
    colour-Doppler motion is captured; grayscale misses it)."""
    p = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path,
         "-vf", f"fps={FPS},scale={N}:{N},format=rgb24", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        capture_output=True)
    buf, size = p.stdout, N * N * 3
    return [buf[i:i + size] for i in range(0, len(buf) - size + 1, size)]


def sad(a, b):
    return sum(abs(a[i] - b[i]) for i in range(len(a))) / len(a)


def find_period(frames, fps=FPS):
    """A stored cine repeats near-identically, so the lag-vs-dissimilarity curve
    has a deep dip at the loop period (and its harmonics). Take the global-minimum
    lag over [minP, pmax], then prefer the fundamental (smallest lag within a small
    tolerance of that minimum, so we don't pick 2x the loop). Confident only when
    the dip is far below the curve's peak. Returns (period, cost, ok)."""
    n = len(frames)
    minP = max(8, round(fps * 0.8))               # ignore sub-0.8s "loops"
    minOverlap = max(20, round(fps * 0.7))         # frames needed to score a lag
    pmax = n - minOverlap
    if pmax < minP + 2:
        return n, 0.0, False
    costs = [0.0] * (pmax + 1)                      # costs[p] = dissimilarity at lag p
    for p in range(1, pmax + 1):
        total, cnt, span = 0.0, 0, n - p
        for k in range(0, span, max(1, span // 60)):
            total += sad(frames[k], frames[k + p]); cnt += 1
        costs[p] = total / cnt if cnt else 1e9
    region = range(minP, pmax + 1)
    mx = max(costs[p] for p in region)
    gmin = min(costs[p] for p in region)
    if mx < 3:
        return n, mx, False                         # essentially no motion
    tol = max(3.0, gmin * 4)
    period = next((p for p in region if costs[p] <= gmin + tol), n)  # fundamental
    ok = gmin < 0.30 * mx and gmin < 8.0
    return period, gmin, ok


def main():
    if len(sys.argv) != 3:
        print(__doc__); sys.exit(1)
    inp, outp = sys.argv[1], sys.argv[2]
    frames = read_fingerprints(inp)
    period, cost, ok = find_period(frames)
    if not ok:
        print(f"  ⚠ no confident loop (period {period}, cost {cost:.1f}); keeping full clip")
        period = len(frames)
    else:
        print(f"  ✓ loop {period} frames ({period / FPS:.2f}s @ {FPS}fps), cost {cost:.1f}")
    # Re-time to constant FPS, keep the first `period` frames, pad to even dims.
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", inp,
         "-vf", f"fps={FPS},pad=ceil(iw/2)*2:ceil(ih/2)*2",
         "-frames:v", str(period),
         "-c:v", "libx264", "-preset", "slow", "-crf", "18",
         "-pix_fmt", "yuv420p", "-movflags", "+faststart", outp],
        check=True)
    print(f"  trimmed -> {outp}")


if __name__ == "__main__":
    main()
