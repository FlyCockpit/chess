/**
 * Reads AGENTS.md and writes a mirror copy to each target. A target outside
 * the repo root gets its relative Markdown link targets rewritten so they still
 * resolve from its own directory; otherwise the copy is byte-identical.
 * Run: `pnpm sync:agent-docs`
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname!, "..");

// ---------------------------------------------------------------------------
// Config — add new targets here
// ---------------------------------------------------------------------------

interface Target {
  /** Path relative to the repo root */
  path: string;
  /** Banner prepended before AGENTS.md content */
  banner: string;
}

const HTML_BANNER =
  "<!-- GENERATED FROM AGENTS.md — DO NOT EDIT. Run `pnpm sync:agent-docs` after editing AGENTS.md. -->";

// .cursorrules is a Markdown file consumed by Cursor. HTML comments work fine
// in Markdown, but wrapping in a blockquote makes intent clearer in the Cursor
// UI without breaking parsing.
const CURSORRULES_BANNER = `> **Note:** ${HTML_BANNER}`;

const TARGETS: Target[] = [
  { path: "CLAUDE.md", banner: HTML_BANNER },
  { path: ".cursorrules", banner: CURSORRULES_BANNER },
  { path: ".github/copilot-instructions.md", banner: HTML_BANNER },
];

// ---------------------------------------------------------------------------
// Link rebasing
// ---------------------------------------------------------------------------

/** Scheme (`https:`, `mailto:`), protocol-relative, root-absolute or in-page. */
const NON_RELATIVE_LINK = /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i;
/** Inline link or image target: `](target` up to whitespace or `)`. */
const INLINE_LINK = /(\]\()([^)\s]+)/g;
/** Reference definition: `[label]: target`. */
const REFERENCE_LINK = /^( {0,3}\[[^\]]+\]:[ \t]*)(\S+)/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Rebase one AGENTS.md-relative link target onto `targetDir` (POSIX, repo-relative). */
function rebaseLink(link: string, targetDir: string): string {
  if (NON_RELATIVE_LINK.test(link)) return link;
  const hashAt = link.indexOf("#");
  const pathPart = hashAt === -1 ? link : link.slice(0, hashAt);
  const fragment = hashAt === -1 ? "" : link.slice(hashAt);
  if (pathPart === "") return link;
  const rebased = posix.relative(targetDir, posix.normalize(pathPart)) || ".";
  return `${rebased.startsWith(".") ? rebased : `./${rebased}`}${fragment}`;
}

/** Rewrite relative link targets outside fenced code blocks. */
function rebaseLinks(markdown: string, targetDir: string): string {
  if (targetDir === ".") return markdown;
  let fence: string | null = null;
  return markdown
    .split("\n")
    .map((line) => {
      const opener = FENCE.exec(line)?.[1];
      if (fence !== null) {
        if (opener !== undefined && opener[0] === fence[0] && opener.length >= fence.length) {
          fence = null;
        }
        return line;
      }
      if (opener !== undefined) {
        fence = opener;
        return line;
      }
      return line
        .replace(
          REFERENCE_LINK,
          (_, lead: string, link: string) => lead + rebaseLink(link, targetDir),
        )
        .replace(
          INLINE_LINK,
          (_, lead: string, link: string) => lead + rebaseLink(link, targetDir),
        );
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const source = readFileSync(resolve(ROOT, "AGENTS.md"), "utf-8");

for (const target of TARGETS) {
  const abs = resolve(ROOT, target.path);
  mkdirSync(dirname(abs), { recursive: true });
  const body = rebaseLinks(source, posix.dirname(target.path));
  const content = `${target.banner}\n\n${body}`;
  writeFileSync(abs, content, "utf-8");
  console.log(`✓ ${target.path}`);
}
