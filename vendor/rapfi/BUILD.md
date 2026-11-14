# Building the Rapfi WebAssembly engine

Rapfi is the strongest open-source Gomoku/Renju engine (Gomocup champion
2024–2026), compiled to single-threaded WebAssembly SIMD. This document pins
exactly how the artifacts are produced so the build stays reproducible; the
resulting files ship via this repository's Releases
(tag `rapfi-3c94c2a`) and are consumed by `apps/gomoku.ningh.org` in the
app monorepo.

## License compliance (GPL-3)

Rapfi is GPL-3.0; serving the compiled `.wasm` to visitors is distribution,
so the exact source of the shipped binary must be offered. The pinned source
(upstream commit + the three patches below, both kept in this repository)
IS that offer; the site footer links here. The NNUE weights are CC0 (from
[rapfi-networks](https://github.com/dhbloo/rapfi-networks)) and are not GPL
material. The app's own code talks to the engine over the text protocol and
is a separate program.

## Pinned source

- Upstream: `dhbloo/rapfi` at commit
  **`3c94c2a976f24a0dd1c5517623e9ab6fffe66bd7`** (master, 2026-08-26).
- What we apply on top (all kept in this directory):
  1. `patches/0001-export-fs-and-es6-module.patch` — two `Rapfi/CMakeLists.txt`
     changes: `EXPORTED_RUNTIME_METHODS` gains `'FS'` (the page writes NNUE
     weight files into the engine's virtual FS at runtime for lazy per-rule
     model loading, and reads files back for parity tests), and
     `-s EXPORT_ES6=1` (the glue is an ES module, imported directly by the
     module worker `public/engines/engine-bootstrap.js` in the app repo).
  2. `patches/0002-scalar-build-drop-mix10.patch` — scalar-wasm support: the
     mix10 NNUE kernels `static_assert` against a scalar instruction type, so
     a `USE_WASM_SIMD=OFF` build cannot compile the stock tree. The patch
     defines `RAPFI_NO_MIX10` for scalar wasm builds, compiles
     `eval/mix10nnue.cpp` to nothing under it, and drops the `"mix10"`
     evaluator branch in `evalconfig.cpp` (a mix10 config then fails cleanly
     through rapfi's config-load failure-safe). mix9svq — every net this
     site ships — and the classical eval keep their scalar paths untouched;
     SIMD builds are completely unaffected.
  2. `networks-minimal/` — replaces the upstream `Networks/` submodule. The
     default wasm build packs all four NNUE networks (~40 MB) into
     `rapfi.data`; ours preloads only the classical model (~30 KB) and the
     site fetches the NNUE files from `/models/` on demand, activated by
     swapping `config.toml` and sending `RELOADCONFIG`. Provenance:
     `model210901.bin` is byte-identical to
     `classical/model210901.bin` in
     [rapfi-networks](https://github.com/dhbloo/rapfi-networks)
     (`34061bca4031a786a4b0ff52470fa9f316013c4c2239db0d70581a3c35d0a72a`);
     `config-classical.toml` is a trimmed variant of
     `config-example/gomocalc-classical210901.toml` authored for the site.

`networks-minimal/wasm_preloads.txt`:

```
build/config-classical.toml@config.toml
build/model210901.bin@model210901.bin
```

## Build

CI (`.github/workflows/build.yml`, the authoritative producer) does exactly
this on an Ubuntu runner with emsdk 6.0.8; manually it is:

```bash
git clone https://github.com/dhbloo/rapfi.git rapfi-upstream
cd rapfi-upstream && git checkout 3c94c2a976f24a0dd1c5517623e9ab6fffe66bd7
git apply /path/to/engine-builds/rapfi/patches/0001-export-fs-and-es6-module.patch
cp -r /path/to/engine-builds/rapfi/networks-minimal Networks

source /path/to/emsdk/emsdk_env.sh   # emsdk 6.0.8; on macOS 26 pass EMSDK_OS=macos to emsdk
mkdir -p Rapfi/build/wasm-single-simd128
cd Rapfi/build/wasm-single-simd128
emcmake cmake ../.. -DCMAKE_BUILD_TYPE=Release \
  -DNO_COMMAND_MODULES=ON -DNO_MULTI_THREADING=ON \
  -DUSE_WASM_SIMD=ON -DUSE_WASM_SIMD_RELAXED=OFF
emmake cmake --build . -j
cd ..
# The scalar (non-SIMD) tier — same pin, same patch, USE_WASM_SIMD=OFF.
# CMake then names the outputs rapfi-single.* (no -simd128 suffix) and
# compiles without -msimd128/USE_WASM_SIMD. Serves the wasm-SIMD-less
# population (old in-app browser kernels); downloaded ONLY by clients
# whose SIMD probe fails — the app's engine-bootstrap.js picks rapfi.js
# vs rapfi-basic.* by that probe, so everyone else never pays for it.
mkdir -p wasm-single
cd wasm-single
emcmake cmake ../.. -DCMAKE_BUILD_TYPE=Release \
  -DNO_COMMAND_MODULES=ON -DNO_MULTI_THREADING=ON \
  -DUSE_WASM_SIMD=OFF -DUSE_WASM_SIMD_RELAXED=OFF
emmake cmake --build . -j
cd ../..

# Artifacts (renamed to stable URLs; the app's bootstrap locateFile
# redirects the build-time names)
cp Rapfi/build/wasm-single-simd128/rapfi-single-simd128.js   rapfi.js
cp Rapfi/build/wasm-single-simd128/rapfi-single-simd128.wasm rapfi.wasm
cp Rapfi/build/wasm-single-simd128/rapfi-single-simd128.data rapfi.data
cp Rapfi/build/wasm-single/rapfi-single.js   rapfi-basic.js
cp Rapfi/build/wasm-single/rapfi-single.wasm rapfi-basic.wasm
cp Rapfi/build/wasm-single/rapfi-single.data rapfi-basic.data
```

Measured on the shipped build: ~890K nodes/s in node; ~1.2 MB wasm.

The four `mix9svq*.bin.lz4` NNUE networks in the same Release are verbatim
copies from [rapfi-networks](https://github.com/dhbloo/rapfi-networks)
(CC0, sha-pinned in the workflow); the engine decompresses them natively.

## Protocol notes learned from the source (verified live)

- `BOARD` loads a position AND immediately thinks; use `YXBOARD` to load
  without moving (`cmd.yxBoard` in the app repo's `engine/protocol.ts`).
- `YXSHOWFORBID` prints `FORBID xxyy….` with zero-padded 1-based coords.
- `INFO RULE` must be sent while a board exists to take effect cleanly
  (the client sends `START` then per-request setup; rule switches reset the
  board and hash).
- Positions MUST be sent in true move order (black/white alternating):
  order-illegal lists make the loader insert PASS moves, and that path
  corrupts renju forbidden detection (see `useMatch.stonesFor` in the app).
- `YXSHOWINFO` (GUI mode) disables the turn-time limit while the default
  time control values are in place — always send explicit
  `INFO TIMEOUT_TURN`/`TIMEOUT_MATCH`.
- `RELOADCONFIG /config.toml` re-reads the virtual FS config — the path must
  be explicit; a config load that fails (missing weights) leaves the
  previous engine state intact, so lazy model swaps are failure-safe.

## Single-thread, deliberately

The multi-threaded build needs `SharedArrayBuffer`, which forces
COOP/COEP headers onto the whole page (third-party implications for
analytics etc.). The single-thread SIMD build already searches at
superhuman strength (~890K nodes/s measured) and works everywhere
wasm-SIMD does (Chrome 91+, Firefox 89+, Safari 16.4+).

## Runtime pieces (in the app monorepo)

- `apps/gomoku.ningh.org/public/engines/engine-bootstrap.js` — module worker
  that imports the ES6 glue and bridges the message protocol. The shapes
  mirror `app/gomoku/engine/worker-protocol.ts`; keep the two in sync.
- `apps/gomoku.ningh.org/app/gomoku/engine/protocol.ts` — command builders
  - stdout parser.
- `apps/gomoku.ningh.org/app/gomoku/engine/client.ts` — the main-thread
  facade (one command stream; genMove / queryForbid / stop / model swaps).
- `apps/gomoku.ningh.org/app/gomoku/engine/models.ts` — per-rule NNUE
  download + config swap + `RELOADCONFIG` activation.
- `apps/gomoku.ningh.org/scripts/smoke-rapfi.mjs` — node bring-up harness
  against the shipped artifacts.

## Verifying a rebuilt engine

In the app monorepo: `pnpm --filter 'apps-gomoku-ningh-org' test` includes
the forbid-parity suite (`engine/__tests__/forbid-parity.test.ts`): known
foul fixtures must match EXACTLY, and random playouts must never let the
engine miss a TS-adjudicated foul (rapfi flagging extra points is tolerated
as conservative play). A freshly rebuilt `rapfi.wasm` must pass it
unchanged. Refresh `tools/engines.json` in the monorepo (sha256 + bytes)
when the artifacts change.
