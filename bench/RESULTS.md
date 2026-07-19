# Benchmark results — 2026-07-19

Machine: MacBook Pro (Apple Silicon, 16 cores, 64 GB), macOS 26 (Darwin 25.5).
Docker Desktop 29.6 vs Apple `container` 1.1.0 vs native. Containers limited
to `--cpus 4 --memory 4g`; the CPU-multi test uses 4 workers everywhere.
Image: `agent-sandbox-agents` (node v24; host node v22). Run: `node bench/run.mjs`.

| test | native | docker | apple container | note |
|---|---|---|---|---|
| startup `run --rm true` (ms) | — | **226** | 806 | apple boots a fresh VM per container |
| cpu-single sha256 (ms) | 304 | 307 | 309 | virtualization overhead ≈ 0 |
| cpu-multi ×4 (ms) | 180 | 181 | 179 | ≈ 0 |
| fs mount: write 1000×4k (ms) | **63** | 304 | 341 | virtiofs ~5× slower for small writes |
| fs mount: read 1000×4k (ms) | 544* | 230 | 206 | *native run includes warmup artifact |
| fs mount: delete 1000 (ms) | **80** | 232 | 142 | |
| fs mount: seq write 256M (MB/s) | **4354** | 1516 | 1405 | virtiofs ~3× slower, still fast |
| fs mount: seq read 256M (MB/s) | **1872** | 1224 | 1149 | |
| fs local: write 1000×4k (ms) | 65 | 15 | **8** | VM ext4 + page cache beats APFS |
| fs local: read 1000×4k (ms) | 170 | 5 | **4** | |
| fs local: seq write 256M (MB/s) | 4715 | 2373 | 2446 | |
| fs local: seq read 256M (MB/s) | 2343 | **22028** | 16262 | pure VM page cache |
| npm install (express+lodash+ts) (ms) | 3255 | **2741** | 3375 | network-dominated, all ≈ equal |
| net download 3×25M (MB/s) | 10.2 | 9.9 | 9.8 | line-limited, overhead ≈ 0 |

## Takeaways

- **CPU and network are free** — no measurable virtualization cost on Apple
  Silicon in either runtime.
- **The workspace bind mount (virtiofs) is the only real cost**: ~3× slower
  sequential, ~5× slower small-file writes than native APFS. Docker and Apple
  `container` are within ~10 % of each other there.
- **Container-local filesystems are *faster* than native APFS** for small
  files (VM ext4 + page cache, no APFS metadata sync). Heavy scratch work
  (build output, caches) benefits from staying off the mount — e.g.
  `/tmp` inside the sandbox.
- **Real-world `npm install` is a wash** — network and CPU dominate, mount
  overhead doesn't move the needle at this scale.
- **Startup**: docker ~0.2 s vs apple ~0.8 s (fresh VM each time). Both fine
  for interactive use.

## Addendum: npm install — mount vs container-local (Apple container, warm cache)

The main-table npm test ran **on the mount** (realistic: agents install into
the workspace) with a cold cache, so network hid the filesystem cost. With a
warm npm cache (pure fs work):

| location | npm install |
|---|---|
| container-local (`/tmp`) | ~0.6 s |
| workspace mount (virtiofs) | ~1.1 s (**~1.8× slower**) |

Cold-cache installs are network-bound (~2.5 s) either way. The virtiofs
penalty shows up on repeated/warm installs and other node_modules-heavy
operations — keeping scratch/build dirs off the mount pays off.
