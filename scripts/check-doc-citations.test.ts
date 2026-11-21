import assert from "node:assert/strict";
import { test } from "node:test";
import { CITATION_RE, findCitations } from "./check-doc-citations.ts";

// Built at runtime: a literal section sign in this file would make the
// checker scan these fixtures as real citations of missing docs.
const S = "§";
const cites = (source: string) => findCitations(source).found;

test("bare citations are found wherever a path token starts", () => {
  for (const [source, docRel] of [
    [`see docs/deployment.md ${S} URL routing`, "docs/deployment.md"],
    [`docs/deployment.md ${S} URL routing`, "docs/deployment.md"],
    [`(docs/deployment.md ${S} URL routing)`, "docs/deployment.md"],
    ["`docs/deployment.md " + S + " URL routing`", "docs/deployment.md"],
    [`"./docs/environment.md ${S} URL routing"`, "./docs/environment.md"],
    [`// AGENTS.md ${S} URL routing`, "AGENTS.md"],
    [`../x/y-z.md\n${S} URL routing`, "../x/y-z.md"],
  ] as const) {
    const found = cites(source);
    assert.deepEqual(
      found.map((item) => item.docRel),
      [docRel],
      source,
    );
    // The raw section text; normalize() drops the closing punctuation later.
    assert.match(found[0]?.cite ?? "", /^URL routing[)`"]?$/, source);
  }
});

test("the whole path token is the captured path", () => {
  assert.deepEqual(cites(`a/b.c-d/docs/deployment.md ${S} URL routing`), [
    { docRel: "a/b.c-d/docs/deployment.md", cite: "URL routing" },
  ]);
  CITATION_RE.lastIndex = 0;
  const starts = [...`x foo/bar.md ${S} A and baz.md ${S} B`.matchAll(CITATION_RE)].map(
    (match) => match.index,
  );
  assert.deepEqual(starts, [2]);
});

test("link-form citations win over the bare form inside the same link", () => {
  const { found, linkSpans } = findCitations(
    `[docs/deployment.md ${S} URL routing](./deployment.md#url-routing) and [money ${S} Money](./schema-guidelines.md#money)`,
  );
  assert.deepEqual(found, [
    { docRel: "./deployment.md", cite: "URL routing" },
    { docRel: "./schema-guidelines.md", cite: "Money" },
  ]);
  assert.equal(linkSpans.length, 2);
});

test("a source without a section sign has no citations", () => {
  assert.deepEqual(findCitations("see docs/deployment.md URL routing").found, []);
});

// Quadratic before the lookbehind: every position in the run restarted the
// greedy path scan (about 3e9 steps here, over ten seconds; a synchronous
// regex cannot be interrupted by a test timeout). Linear now: milliseconds.
test("a long run of path characters is scanned in linear time", () => {
  const blob = "a/".repeat(40_000);
  const started = performance.now();
  assert.deepEqual(cites(`${blob} then docs/deployment.md ${S} URL routing`), [
    { docRel: "docs/deployment.md", cite: "URL routing" },
  ]);
  const took = performance.now() - started;
  assert.ok(took < 2_000, `the scan took ${Math.round(took)} ms`);
});
