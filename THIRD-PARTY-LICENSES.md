# Third-Party Notices

This project bundles or depends on third-party components whose licenses
require attribution or carry obligations worth knowing about. Everything else
in the dependency tree is used unmodified under permissive licenses (MIT,
Apache-2.0, ISC, BSD, 0BSD, BlueOak-1.0.0, Unlicense, CC0-1.0, CC-BY-4.0,
Python-2.0, MIT-0) or file-level weak copyleft (MPL-2.0: `lightningcss`; EPL-2.0: `elkjs`, via Prisma). Full license texts ship inside
each package in `node_modules/`.

## Roboto (webfont) — SIL Open Font License 1.1

The web app bundles the Roboto variable font via
[`@fontsource-variable/roboto`](https://www.npmjs.com/package/@fontsource-variable/roboto)
(`packages/ui/src/styles/globals.css`, `apps/web/src/routes/__root.tsx`). The
`.woff2` files are emitted into the client build.

> Copyright 2011 The Roboto Project Authors
> (https://github.com/googlefonts/roboto-classic)
>
> This Font Software is licensed under the SIL Open Font License, Version 1.1.
> The full license text is available at http://scripts.sil.org/OFL and ships
> with the package at `node_modules/@fontsource-variable/roboto/LICENSE`.

The OFL permits bundling the font in commercial products. Its two obligations:
the font files may not be sold on their own, and this notice must accompany
redistributions of the font. Keep this file (or an equivalent notice) if you
ship the bundled font; it does not apply if you swap Roboto for another font
during rebranding.

## web-tree-sitter and tree-sitter-bash — MIT

The Claude Code PreToolUse hook (`scripts/claude-hooks/pre-tool-use.mjs`) uses
[`web-tree-sitter`](https://www.npmjs.com/package/web-tree-sitter) and
[`tree-sitter-bash`](https://www.npmjs.com/package/tree-sitter-bash) as root
devDependencies to parse Bash at the tool boundary. This is local agent tooling
only — nothing in the web app, server, worker, or CLI bundles imports these
packages. The shipped `tree-sitter-bash.wasm` grammar is loaded from the
installed package; no native binding is built (`allowBuilds.tree-sitter-bash:
false` in `pnpm-workspace.yaml`).

## caniuse-lite — CC-BY-4.0

Browser-compatibility data from [caniuse.com](https://caniuse.com), used at
build time by the CSS toolchain (browserslist). Attribution-only; the data is
not shipped as part of the application.

## chess.js 1.4.0 — BSD-2-Clause

The authoritative standard-chess rules engine ships in the browser, worker and local companion.
Upstream: https://github.com/jhlywa/chess.js

```text
Copyright (c) 2025, Jeff Hlywa (jhlywa@gmail.com)
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice,
   this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE
LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.
```

## TanStack AI Anthropic adapter — MIT

The server/local inference runtime uses `@tanstack/ai-anthropic` 1.0.0 and the
Anthropic SDK it depends on. Upstream: https://github.com/TanStack/ai. Package
license and copyright notices ship with the installed dependencies.


## js-tiktoken 1.0.21 — MIT

The shared benchmark encoding uses the pure JavaScript tiktoken implementation,
with only cl100k_base loaded in the server/local runner. This is independent of
provider billing. Source: https://github.com/dqbd/tiktoken
Upstream MIT notice (https://github.com/dqbd/tiktoken/blob/main/LICENSE):

MIT License

Copyright (c) 2022 OpenAI, Shantanu Jain

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Stockfish 19.0.1 — GPL-3.0

Engine assistance runs the unmodified `stockfish-19-lite-single` JavaScript/WASM
build as a separate UCI child process. No Stockfish binary is sent to public
spectators' browsers. The installed npm package includes its full GPL text in
`stockfish/Copying.txt`; retain that notice with redistributed engine binaries.
Upstream port and build/source instructions: https://github.com/nmrugg/stockfish.js
Exact npm release: https://www.npmjs.com/package/stockfish/v/19.0.1
Upstream engine source: https://github.com/official-stockfish/Stockfish

The container images and CLI release binaries that include Stockfish must keep
the engine's GPL notices and its corresponding source/build information (the
links above). Cockpit Chess itself is licensed under AGPL-3.0-only (see
[LICENSE](./LICENSE)), which is compatible with GPL-3.0 (AGPL-3.0 section 13).
