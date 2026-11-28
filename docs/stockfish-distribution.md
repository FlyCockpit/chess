# Stockfish distribution

Cockpit Chess uses Stockfish 19 through the unmodified Stockfish.js **19.0.1**
`stockfish-19-lite-single` JavaScript/WebAssembly build, as a separate UCI
process. The npm package is powered by Stockfish; no endorsement is implied.
Hosted matches run the engine on the server, and npm runner matches run it on
the user's computer. No browser engine is loaded by the website.

## Exact source and notices

The npm artifact includes the engine's full GPL version 3 text, copyright
notices, and corresponding source (including the embedded network input and
build scripts). These files are independently redistributable under their
upstream licences. Website terms and account requirements impose no additional
restrictions on exercising those rights. Cockpit Chess is AGPL-3.0-only;
[its source](https://github.com/FlyCockpit/chess) and [licence](../LICENSE)
remain available independently of the engine's GPL rights.

The durable owner-hosted source download is
<https://chess.flycockpit.app/third-party/stockfish/stockfish-19.0.1-source.tar.gz>.
[GPL text](https://chess.flycockpit.app/third-party/stockfish/Copying.txt),
[authors](https://chess.flycockpit.app/third-party/stockfish/AUTHORS) and
[checksums](https://chess.flycockpit.app/third-party/stockfish/SHA256SUMS) live
beside it. The source archive also ships inside every npm tarball at
`stockfish/source/stockfish-19.0.1-source.tar.gz`; access does not depend on an
account or a later source offer. Retain the download and notices for as long as
the object code is distributed. A deployment must verify these URLs before
the owner publishes to npm; staging these files is not evidence of a live URL.

The exact provenance and SHA-256 digests are recorded in
[the distribution manifest](../apps/cli/stockfish/manifest.json). The upstream
[v19.0.1 tag](https://github.com/nmrugg/stockfish.js/releases/tag/v19.0.1)
resolves to Stockfish.js commit
`0d5dd7944f88c817c07a26bc4fb1905d5f9c46d6`. This repository contains the
Stockfish C++ source and Emscripten glue; a separate latest Stockfish checkout
is neither necessary nor a substitute for that source. Distributed object
checksums are checked against the installed locked npm dependency at package
build time; no engine compilation or source download happens on npm install.

## Building the engine from the corresponding source

Extract the supplied archive. It contains upstream source without code
modifications, plus `src/nn-61e7af4bb97d.nnue` and this build document. The net
is the exact lite input selected by `src/evaluate.h`, SHA-256
`61e7af4bb97d51eeeb25d322916f86513b5cd3a827ce189c98c6e31946f99e5b`.
Upstream `AUTHORS`, `Copying.txt` and file-level copyright notices are retained.

Use Node.js, GNU Make, Python, and the upstream Emscripten SDK **6.0.9**
(including its matching Binaryen/LLVM). Install the package's pinned
development tool `terser` **5.51.2** using `npm install --ignore-scripts` in
the extracted source directory. Activate Emscripten 6.0.9 in your shell, then:

```sh
node build.js --single-threaded --lite --strict-em-check --no-split -f
```

The upstream build produces `src/stockfish-19-lite-single.js` and
`src/stockfish-19-lite-single.wasm`. Keep the two files together. This is the
release's lite single-thread build recipe; build timestamps, absolute tool
paths and toolchain differences can change rebuilt object bytes. The manifest
identifies the exact upstream release objects we distribute, rather than
claiming an independently reproduced byte-for-byte engine build. The source
and network checksums are reproducible regardless of those object differences.

To reproduce the source archive, fetch the commit tarball from
`https://codeload.github.com/nmrugg/stockfish.js/tar.gz/0d5dd7944f88c817c07a26bc4fb1905d5f9c46d6`
and verify SHA-256
`e5289a920554bf0069a6601c228e81d957c00522bb31c4343588dc5d7d251879`.
Extract it as `stockfish-19.0.1-source`, add the named verified network from
`https://tests.stockfishchess.org/api/nn/nn-61e7af4bb97d.nnue` under `src/`,
and copy this document to `BUILD.md`. From its parent directory run GNU tar:

```sh
tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner \
  --format=gnu -czf stockfish-19.0.1-source.tar.gz stockfish-19.0.1-source
```

## Package and native binary differences

The Node package includes only the lite single-thread engine flavour, resolved
relative to its installed launcher, and starts it with the same Node executable
as the parent. npm cache paths, working directories and a global Bun/tsx install
are irrelevant. All engine requests retain finite node limits and the shared
one-thread/8 MiB/reset behavior.

The existing standalone Bun binaries embed the local browser companion but do
**not** embed an engine or start an engine from Bun's virtual filesystem. They
continue to reject engine-assisted matches before starting. Use the npm package
or a source checkout for local Stockfish evaluation. Neither release route
publishes to npm automatically; only the owner performs publication after
artifact and licence review.
