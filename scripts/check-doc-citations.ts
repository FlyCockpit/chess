/**
 * Guards `<doc>.md § <section>` citations, in shipped code and in the docs
 * themselves, against the actual section anchors in the cited docs, and every
 * relative doc-to-doc markdown link against the files on disk.
 *
 *   pnpm docs:check-citations   — verify without writing (CI gate; non-zero exit on drift)
 *
 * Why this exists: code comments and docs point readers at a specific section
 * of a doc, e.g.
 *
 *     // see docs/deployment.md § Migration startup and instance admission
 *
 * When a doc is restructured (a heading renamed, a section merged away) those
 * citations silently rot: the file still exists, so nothing errors, but the
 * "§ <section>" now names a heading that is gone. This script makes a stale
 * citation a fast, CI-visible error.
 *
 * What counts as a valid citation target (a doc "anchor"):
 *   1. A Markdown heading — any `#`..`######` line.
 *   2. A bold lead-in label — a line that starts (optionally after a list
 *      marker) with `**Label.**` / `**Label:**`.
 *
 * Matching is deliberately lenient about trailing text: a citation captures the
 * rest of the source line after `§`, which can run into continuing prose. A
 * citation passes if some anchor equals the captured text or is a whole-word
 * prefix of it. Both sides are normalized (lowercased, backticks/asterisks
 * removed, trailing punctuation stripped, whitespace collapsed) first.
 *
 * Scope: citations are read from shipped code (`apps/`, `packages/`,
 * `scripts/`), from `docs/**.md`, and from the root docs in ROOT_DOCS. A cited
 * path is resolved relative to the citing file before falling back to the
 * repo root.
 *
 * A missing cited doc or link target is an error when the citing file is a doc.
 * A code comment citing a doc whose whole directory is gone is reported as a
 * warning instead, so stale comment references can be cleaned up separately;
 * a missing file beside a directory that still exists is always an error
 * (typo or rename). A renamed or deleted heading in a doc that still exists is
 * always fatal.
 *
 * This file itself is skipped: its docstring quotes example citations.
 *
 * Relative doc links (`](./x.md)`, `](../x.md)`, `#anchor` optional) are
 * validated for FILE EXISTENCE in `docs/**.md` and the root docs (the generated
 * AGENTS.md mirrors inherit the result). Absolute URLs, bare anchors, and
 * non-`.md` targets are out of scope. Link ANCHORS (`#some-heading`) are not
 * resolved; the `§` citation form is how this repo pins a section.
 *
 * Dependency-free by design (node:fs only).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname!, "..");

// Where to scan for citations: shipped code plus the docs directory.
const CODE_DIRS = ["apps", "packages", "scripts", "docs"];
const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".rs", ".md"]);
// Root-level docs that also carry citations (the walk covers directories only).
const ROOT_DOCS = [
  "AGENTS.md",
  "CLAUDE.md",
  "sitemap.md",
  "README.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "CHANGELOG.md",
  "THIRD-PARTY-LICENSES.md",
];
// Directories never worth scanning (build output, deps, generated caches).
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".turbo",
  ".next",
  "target",
  ".git",
]);

// A citation: `<path>.md § <rest of line>`. Any markdown doc counts
// (`docs/deployment.md § Migration startup and instance admission`, `AGENTS.md § Dockerfiles`).
// The section text stops at a newline or a `]`, because docs cite each other as
// markdown links (`[x.md § Sec](./x.md#sec)`) and the capture must not swallow
// the link target.
const CITATION_RE = /([\w./-]+\.md)\s*§\s*([^\n\]]+)/g;

// The other spelling: a markdown link whose label carries the `§` but not the
// filename, with the doc named only in the target —
// `[environment § Validation vs loading](./docs/environment.md#validation-vs-loading)`.
// `CITATION_RE` requires a literal `.md` before the `§`, so it cannot see these.
// The path comes from the link target (group 3).
const LINK_CITATION_RE = /\[([^\]\n]*?)§\s*([^\]\n]+)\]\(\s*([^)\s#]+\.md)(?:#[^)\s]*)?\s*\)/g;

// Relative markdown links between docs — `](./x.md)`, `](../x.md)`, with or
// without a `#anchor`. A plain "see [x](./x.md)" link rots invisibly when the
// target is renamed or removed; this pass checks the file exists. Absolute
// URLs, anchors-only links, and non-`.md` targets are out of scope.
const DOC_LINK_RE = /\]\(\s*(\.{1,2}\/[^)\s#]+\.md)(?:#[^)\s]*)?\s*\)/g;

// Where relative doc links are validated, and where a missing cited doc is
// always fatal: `docs/**.md` plus the root docs. CLAUDE.md / .cursorrules /
// copilot-instructions.md are generated mirrors of AGENTS.md, so checking
// AGENTS.md covers them.
const DOC_LINK_ROOT_DOCS = new Set([
  "AGENTS.md",
  "README.md",
  "sitemap.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "CHANGELOG.md",
  "THIRD-PARTY-LICENSES.md",
  "apps/cli/AGENTS.md",
  "apps/desktop/README.md",
]);
function isDocLinkFile(rel: string): boolean {
  return (rel.startsWith("docs/") && rel.endsWith(".md")) || DOC_LINK_ROOT_DOCS.has(rel);
}

// This file's own docstring quotes example citations; scanning it would make
// renaming an unrelated heading fail CI via prose that only documents the checker.
const SELF = resolve(ROOT, "scripts/check-doc-citations.ts");

/**
 * Blank out fenced blocks and inline code spans, preserving every offset (same
 * length, same newlines) so spans computed on the raw source stay valid. Text
 * quoted inside code is a transcription, not a link this doc offers the reader.
 */
function maskCode(source: string): string {
  let fenced = false;
  return source
    .split("\n")
    .map((line) => {
      if (/^\s*(?:```|~~~)/.test(line)) {
        fenced = !fenced;
        return " ".repeat(line.length);
      }
      if (fenced) return " ".repeat(line.length);
      return line.replace(/(`+)(.+?)\1/g, (match) => " ".repeat(match.length));
    })
    .join("\n");
}

/** Recursively collect code files under a directory, skipping build/vendor dirs. */
function walk(dir: string, acc: string[]): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      // Hidden directories hold tool state, not shipped source (.claude/,
      // .vscode/, .turbo/). Citations there are notes, not code comments.
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      walk(full, acc);
    } else if (entry.isFile()) {
      const dot = entry.name.lastIndexOf(".");
      if (dot !== -1 && CODE_EXTENSIONS.has(entry.name.slice(dot))) acc.push(full);
    }
  }
}

/**
 * Lowercase, strip markdown emphasis/code and quotes, drop trailing
 * punctuation, collapse spaces.
 *
 * Quotes are stripped everywhere, not just at the ends: a citation may wrap the
 * section name in quotes mid-string (`§ "Who email verification gates" for the
 * …`), and an interior quote would otherwise survive and break the whole-word
 * prefix test in `anchorMatches`.
 */
function normalize(text: string): string {
  return (
    text
      .replace(/[`*_"'“”‘’]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      // `|` is in the class because docs cite sections from inside table cells
      // (`… § 1 — Rate Limiting` |`), where the trailing pipe would otherwise
      // survive normalization and defeat the prefix match.
      .replace(/[\s.,;:)\]}"'*/|-]+$/g, "")
      .trim()
      .toLowerCase()
  );
}

/** Collect the set of citable anchors (headings + bold lead-in labels) for a doc. */
function collectAnchors(docPath: string): Set<string> {
  const anchors = new Set<string>();
  const text = readFileSync(docPath, "utf8");
  const headingRe = /^#{1,6}\s+(.+?)\s*$/;
  const boldLabelRe = /^\s*(?:[-*+]|\d+\.)?\s*\*\*([^*]+?)\*\*/;
  for (const rawLine of text.split("\n")) {
    const heading = headingRe.exec(rawLine);
    if (heading) {
      const a = normalize(heading[1] ?? "");
      if (a) anchors.add(a);
      continue;
    }
    const bold = boldLabelRe.exec(rawLine);
    if (bold) {
      const a = normalize(bold[1] ?? "");
      if (a) anchors.add(a);
    }
  }
  return anchors;
}

/**
 * Does `cite` resolve to some anchor? A match is an exact equality or a
 * whole-word prefix in either direction: the citation may over-capture trailing
 * prose (`"The CI gate has the full …"` → heading `"The CI gate"`), or it may
 * name only the leading part of a longer heading (`"Component-level dynamic
 * import"` → heading `"Component-level dynamic import (React.lazy)"`).
 */
function anchorMatches(cite: string, anchors: Set<string>): boolean {
  if (anchors.has(cite)) return true;
  for (const a of anchors) {
    if (cite.startsWith(`${a} `)) return true;
    if (a.startsWith(`${cite} `)) return true;
  }
  return false;
}

const errors: string[] = [];
const warnings: string[] = [];
const anchorCache = new Map<string, Set<string> | null>();
let citationCount = 0;
let docLinkCount = 0;

const codeFiles: string[] = [];
for (const dir of CODE_DIRS) walk(resolve(ROOT, dir), codeFiles);
for (const doc of ROOT_DOCS) codeFiles.push(resolve(ROOT, doc));

for (const file of codeFiles) {
  if (file === SELF) continue;
  const source = readFileSync(file, "utf8");
  const where = relative(ROOT, file).replaceAll("\\", "/");

  // Link-form citations first, recording the span each one occupies. A link
  // whose label happens to include the filename
  // (`[docs/environment.md § Validation vs loading](./environment.md#validation-vs-loading)`) matches BOTH
  // patterns, so the bare-form pass below skips anything already covered —
  // otherwise it double-counts and reports the same problem twice.
  const found: Array<{ docRel: string; cite: string }> = [];
  const linkSpans: Array<[number, number]> = [];
  for (const match of source.matchAll(LINK_CITATION_RE)) {
    linkSpans.push([match.index, match.index + match[0].length]);
    found.push({ docRel: match[3] ?? "", cite: match[2] ?? "" });
  }
  for (const match of source.matchAll(CITATION_RE)) {
    if (linkSpans.some(([start, end]) => match.index >= start && match.index < end)) continue;
    found.push({ docRel: match[1] ?? "", cite: match[2] ?? "" });
  }

  for (const raw of found) {
    citationCount++;
    const docRel = raw.docRel;
    const cite = normalize(raw.cite);

    if (cite.length === 0) {
      errors.push(`${where}: citation "${docRel} §" has no section text.`);
      continue;
    }

    // A doc citing a sibling writes a path relative to itself
    // (`environment.md` from inside `docs/`), while code cites
    // repo-relative (`docs/environment.md`). Try the citing file's own
    // directory first, then the repo root.
    const cacheKey = `${dirname(file)}\u0000${docRel}`;
    let anchors = anchorCache.get(cacheKey);
    if (anchors === undefined) {
      anchors = null;
      for (const candidate of [resolve(dirname(file), docRel), resolve(ROOT, docRel)]) {
        try {
          anchors = collectAnchors(candidate);
          break;
        } catch {
          // try the next candidate
        }
      }
      anchorCache.set(cacheKey, anchors);
    }

    if (anchors === null) {
      // A doc citing a missing doc is always drift. A code comment citing a doc
      // whose whole directory is gone is a stale comment, reported as a warning
      // so it can be cleaned up separately; a missing file beside a directory
      // that still exists is a typo or rename, and fatal.
      const dirExists = [
        dirname(resolve(dirname(file), docRel)),
        dirname(resolve(ROOT, docRel)),
      ].some((dir) => existsSync(dir));
      if (dirExists || isDocLinkFile(where)) {
        errors.push(
          `${where}: cited doc "${docRel}" does not exist — ` +
            `renamed or misspelled? (If the doc was deliberately removed, drop the citation.)`,
        );
      } else {
        warnings.push(`${where}: cited doc "${docRel}" does not exist on disk (citation skipped).`);
      }
      continue;
    }

    if (!anchorMatches(cite, anchors)) {
      errors.push(
        `${where}: "${docRel} § ${raw.cite.trim()}" — no matching section heading in ${docRel}.`,
      );
    }
  }

  // Relative doc-to-doc links: a missing target is always an error.
  if (!isDocLinkFile(where)) continue;
  for (const match of maskCode(source).matchAll(DOC_LINK_RE)) {
    if (linkSpans.some(([start, end]) => match.index >= start && match.index < end)) continue;
    docLinkCount++;
    const target = match[1] ?? "";
    if (existsSync(resolve(dirname(file), target))) continue;
    errors.push(
      `${where}: link target "${target}" does not exist — ` +
        `renamed or misspelled? (If the doc was deliberately removed, drop the link.)`,
    );
  }
}

if (warnings.length > 0) {
  console.warn("Code comments citing docs in removed directories (not fatal):\n");
  for (const w of warnings) console.warn(`  ! ${w}`);
  console.warn("");
}

if (errors.length > 0) {
  console.error("Doc-citation drift detected:\n");
  for (const e of errors) console.error(`  • ${e}`);
  console.error(
    "\nEither fix the `<doc>.md § <section>` citation to name a real\n" +
      "heading, or restore/rename the heading in the cited doc so the two agree. For a link\n" +
      "target, point it at the file's new path, or drop the link if the doc is gone for good.",
  );
  process.exit(1);
}

console.log(
  `Doc citations OK — ${citationCount} \`<doc>.md § <section>\` reference(s) ` +
    `across ${codeFiles.length} code and doc file(s) all resolve to a real section, ` +
    `and ${docLinkCount} relative doc link(s) all resolve to a file on disk` +
    `${warnings.length > 0 ? ` (${warnings.length} skipped: target absent)` : ""}.`,
);
