import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_AMBIGUOUS_MATCHES,
  formatAmbiguousSymbolMatches,
} from "../src/shared/symbol-resolution.js";
import type { IndexedSymbol } from "../src/indexer/types.js";

function fakeMatch(i: number): IndexedSymbol {
  const qn = `Foo#class@some/dir/file${i}.ts:${10 + i}`;
  return {
    name: "Foo",
    qualifiedName: qn,
    originalQualifiedName: qn,
    displayName: "Foo",
    kind: "class",
    filePath: `some/dir/file${i}.ts`,
    startLine: 10 + i,
    endLine: 20 + i,
    signature: `class Foo${i}`,
    exported: true,
    aliases: ["Foo", qn],
    docComment: undefined,
  } as unknown as IndexedSymbol;
}

test("formatAmbiguousSymbolMatches caps shown entries at MAX_AMBIGUOUS_MATCHES", () => {
  const matches = Array.from(
    { length: MAX_AMBIGUOUS_MATCHES + 5 },
    (_, i) => fakeMatch(i),
  );
  const result = formatAmbiguousSymbolMatches("read_symbol", "Foo", matches);

  // Top-line count reflects the true total, not the truncated count.
  assert.match(
    result,
    new RegExp(`is ambiguous; ${matches.length} matches were found`),
  );

  // Each shown match line keeps its full qualified name intact —
  // the whole point is that the agent can feed it back without
  // having to guess past a mid-string truncation.
  const shownEntries = (result.match(/^- /gm) ?? []).length;
  assert.equal(shownEntries, MAX_AMBIGUOUS_MATCHES);

  // Footer tells the agent how many were elided and how to refine.
  assert.match(result, /5 more match\(es\) not shown/);
  assert.match(result, /Refine the name/);
});

test("formatAmbiguousSymbolMatches shows everything below the cap with no footer", () => {
  const matches = [fakeMatch(0), fakeMatch(1), fakeMatch(2)];
  const result = formatAmbiguousSymbolMatches("read_symbol", "Foo", matches);

  const shownEntries = (result.match(/^- /gm) ?? []).length;
  assert.equal(shownEntries, 3);
  assert.doesNotMatch(result, /more match\(es\) not shown/);
});

test("formatAmbiguousSymbolMatches preserves full qualified names for every shown entry", () => {
  const matches = Array.from(
    { length: MAX_AMBIGUOUS_MATCHES + 2 },
    (_, i) => fakeMatch(i),
  );
  const result = formatAmbiguousSymbolMatches("read_symbol", "Foo", matches);

  // For every shown match, the line should contain its full qualified
  // name — no mid-string clipping. This is the property the original
  // bug violated (char-level truncation cut qualified names in half,
  // forcing the agent to guess and produce "not found" loops).
  for (let i = 0; i < MAX_AMBIGUOUS_MATCHES; i += 1) {
    assert.match(result, new RegExp(matches[i]!.qualifiedName));
  }
});
