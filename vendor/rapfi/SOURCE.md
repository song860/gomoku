# Rapfi WebAssembly build

This directory contains the browser build of **Rapfi**, the open-source
Gomoku/Renju engine used by the "噩梦" difficulty.

- Upstream project: <https://github.com/dhbloo/rapfi>
- Upstream commit: `3c94c2a976f24a0dd1c5517623e9ab6fffe66bd7` (2026-08-26)
- Prebuilt artifacts: <https://github.com/ningh-o/engine-builds/releases/tag/rapfi-3c94c2a>
- Build recipe and patches: [BUILD.md](BUILD.md), [patches/0001-export-fs-and-es6-module.patch](patches/0001-export-fs-and-es6-module.patch)
- License: GNU General Public License v3.0, see [LICENSE.txt](LICENSE.txt)

## Files

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `rapfi.js` | 42436 | `d1f25067e9835e60c225c3c38a26cb62c2f00513fb9ee554de59a987e9a64e4d` |
| `rapfi.wasm` | 1238986 | `87fbce51dba32a5ec7598e81d2ff88788becc7504733260b5b1eb8d44701e4e2` |
| `rapfi.data` | 30770 | `f2adfb7bbed467e3297b74317b2799091ac2f9dc568398a263d5fe07625d2a42` |

`rapfi.data` preloads `config.toml` and the CC0 classical model
`model210901.bin`. The app writes a smaller 32 MB transposition-table config
over it at start-up, then sends `RELOADCONFIG`.

## GPL source offer

Rapfi is GPL-3.0. The corresponding source for the shipped WebAssembly binary
is the upstream repository at the pinned commit above, with the build patch in
this directory and the build recipe in [BUILD.md](BUILD.md). The upstream source
archive can be downloaded from:

- <https://github.com/dhbloo/rapfi/archive/3c94c2a976f24a0dd1c5517623e9ab6fffe66bd7.zip>
- <https://github.com/ningh-o/engine-builds/tree/main/rapfi>

The engine is distributed as a separate WebAssembly program and is driven by
this application through the Gomocup / piskvork text protocol. The application
does not link against Rapfi's C++ code.

The classical model `model210901.bin` is released under CC0 by the Rapfi
networks project: <https://github.com/dhbloo/rapfi-networks>.

## Build provenance

The artifacts are used unmodified except for the runtime transformations in
`build.js`:

1. `import.meta.url` is replaced with `self.location.href` so the ES-module
   build can run in a classic Web Worker created from a Blob (needed for
   `file://` play).
2. `export default Rapfi;` is removed for the same reason.
3. The worker wrapper decodes the embedded Wasm/data files and supplies them
   through `instantiateWasm` / `getPreloadedPackage`, so no network request is
   made.

No Rapfi C++ source was modified for this application.
