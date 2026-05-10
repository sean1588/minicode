/**
 * Fuzzy edit-replacer cascade.
 *
 * Adapted from sst/opencode (`packages/opencode/src/tool/edit.ts`), which
 * in turn credits cline and gemini-cli as upstream:
 *   - https://github.com/cline/cline/blob/main/evals/diff-edits/diff-apply/diff-06-23-25.ts
 *   - https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/editCorrector.ts
 *
 * Why this exists: small models routinely emit `old_string` with subtly
 * wrong indentation, whitespace, or `\n`-vs-`\\n` escaping. A strict
 * exact-match `indexOf` rejects these and the model retries with marginally
 * different whitespace, looping until the agent's duplicate-tool-call guard
 * trips. The cascade gives each candidate a series of progressively-fuzzier
 * passes; the first one that yields a uniquely-matchable substring in the
 * actual file content wins. This converts a class of edit-loop failures
 * into successful edits without changing the agent's prompt.
 *
 * Each replacer is a generator that yields candidate substrings present in
 * `content`. The orchestrator (`replaceWithCascade`) picks the first
 * candidate that occurs exactly once.
 */

export type Replacer = (
  content: string,
  find: string,
) => Generator<string, void, unknown>;

const SINGLE_CANDIDATE_SIMILARITY_THRESHOLD = 0.0;
const MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD = 0.3;

function levenshtein(a: string, b: string): number {
  if (a === "" || b === "") {
    return Math.max(a.length, b.length);
  }
  const matrix: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) =>
      i === 0 ? j : j === 0 ? i : 0,
    ),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i]![j] = Math.min(
        matrix[i - 1]![j]! + 1,
        matrix[i]![j - 1]! + 1,
        matrix[i - 1]![j - 1]! + cost,
      );
    }
  }
  return matrix[a.length]![b.length]!;
}

/** Exact-match. The original `indexOf` behaviour. */
export const SimpleReplacer: Replacer = function* (_content, find) {
  yield find;
};

/** Match line-by-line ignoring per-line leading/trailing whitespace. */
export const LineTrimmedReplacer: Replacer = function* (content, find) {
  const originalLines = content.split("\n");
  const searchLines = find.split("\n");

  if (searchLines[searchLines.length - 1] === "") {
    searchLines.pop();
  }

  for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
    let matches = true;
    for (let j = 0; j < searchLines.length; j++) {
      if (originalLines[i + j]!.trim() !== searchLines[j]!.trim()) {
        matches = false;
        break;
      }
    }
    if (matches) {
      let matchStartIndex = 0;
      for (let k = 0; k < i; k++) {
        matchStartIndex += originalLines[k]!.length + 1;
      }
      let matchEndIndex = matchStartIndex;
      for (let k = 0; k < searchLines.length; k++) {
        matchEndIndex += originalLines[i + k]!.length;
        if (k < searchLines.length - 1) {
          matchEndIndex += 1;
        }
      }
      yield content.substring(matchStartIndex, matchEndIndex);
    }
  }
};

/**
 * Anchor on the first and last lines of a multi-line block, fuzzy-match the
 * middle. Useful when the model gets the structural anchors right but
 * miscopies an intermediate line.
 */
export const BlockAnchorReplacer: Replacer = function* (content, find) {
  const originalLines = content.split("\n");
  const searchLines = find.split("\n");

  if (searchLines.length < 3) {
    return;
  }
  if (searchLines[searchLines.length - 1] === "") {
    searchLines.pop();
  }

  const firstLineSearch = searchLines[0]!.trim();
  const lastLineSearch = searchLines[searchLines.length - 1]!.trim();
  const searchBlockSize = searchLines.length;

  const candidates: Array<{ startLine: number; endLine: number }> = [];
  for (let i = 0; i < originalLines.length; i++) {
    if (originalLines[i]!.trim() !== firstLineSearch) {
      continue;
    }
    for (let j = i + 2; j < originalLines.length; j++) {
      if (originalLines[j]!.trim() === lastLineSearch) {
        candidates.push({ startLine: i, endLine: j });
        break;
      }
    }
  }

  if (candidates.length === 0) {
    return;
  }

  const yieldBlock = (startLine: number, endLine: number): string => {
    let matchStartIndex = 0;
    for (let k = 0; k < startLine; k++) {
      matchStartIndex += originalLines[k]!.length + 1;
    }
    let matchEndIndex = matchStartIndex;
    for (let k = startLine; k <= endLine; k++) {
      matchEndIndex += originalLines[k]!.length;
      if (k < endLine) {
        matchEndIndex += 1;
      }
    }
    return content.substring(matchStartIndex, matchEndIndex);
  };

  if (candidates.length === 1) {
    const { startLine, endLine } = candidates[0]!;
    const actualBlockSize = endLine - startLine + 1;

    let similarity = 0;
    const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2);
    if (linesToCheck > 0) {
      for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
        const originalLine = originalLines[startLine + j]!.trim();
        const searchLine = searchLines[j]!.trim();
        const maxLen = Math.max(originalLine.length, searchLine.length);
        if (maxLen === 0) continue;
        const distance = levenshtein(originalLine, searchLine);
        similarity += (1 - distance / maxLen) / linesToCheck;
        if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) break;
      }
    } else {
      similarity = 1.0;
    }

    if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) {
      yield yieldBlock(startLine, endLine);
    }
    return;
  }

  let bestMatch: { startLine: number; endLine: number } | null = null;
  let maxSimilarity = -1;

  for (const candidate of candidates) {
    const { startLine, endLine } = candidate;
    const actualBlockSize = endLine - startLine + 1;
    let similarity = 0;
    const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2);
    if (linesToCheck > 0) {
      for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
        const originalLine = originalLines[startLine + j]!.trim();
        const searchLine = searchLines[j]!.trim();
        const maxLen = Math.max(originalLine.length, searchLine.length);
        if (maxLen === 0) continue;
        similarity += 1 - levenshtein(originalLine, searchLine) / maxLen;
      }
      similarity /= linesToCheck;
    } else {
      similarity = 1.0;
    }
    if (similarity > maxSimilarity) {
      maxSimilarity = similarity;
      bestMatch = candidate;
    }
  }

  if (maxSimilarity >= MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD && bestMatch) {
    yield yieldBlock(bestMatch.startLine, bestMatch.endLine);
  }
};

/** Collapse all whitespace runs to single spaces and compare. */
export const WhitespaceNormalizedReplacer: Replacer = function* (
  content,
  find,
) {
  const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
  const normalizedFind = normalize(find);

  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (normalize(line) === normalizedFind) {
      yield line;
    } else if (normalize(line).includes(normalizedFind)) {
      const words = find.trim().split(/\s+/);
      if (words.length > 0) {
        const pattern = words
          .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("\\s+");
        try {
          const regex = new RegExp(pattern);
          const match = line.match(regex);
          if (match) yield match[0];
        } catch {
          // Invalid regex pattern — skip.
        }
      }
    }
  }

  const findLines = find.split("\n");
  if (findLines.length > 1) {
    for (let i = 0; i <= lines.length - findLines.length; i++) {
      const block = lines.slice(i, i + findLines.length);
      if (normalize(block.join("\n")) === normalizedFind) {
        yield block.join("\n");
      }
    }
  }
};

/**
 * Strip the common leading indentation across both `find` and content blocks
 * before comparing. Useful when the model emits a snippet without the
 * surrounding indentation that the file actually has.
 */
export const IndentationFlexibleReplacer: Replacer = function* (
  content,
  find,
) {
  const removeIndent = (text: string): string => {
    const lines = text.split("\n");
    const nonEmpty = lines.filter((l) => l.trim().length > 0);
    if (nonEmpty.length === 0) return text;
    const minIndent = Math.min(
      ...nonEmpty.map((l) => l.match(/^(\s*)/)?.[1]?.length ?? 0),
    );
    return lines
      .map((l) => (l.trim().length === 0 ? l : l.slice(minIndent)))
      .join("\n");
  };

  const normalizedFind = removeIndent(find);
  const contentLines = content.split("\n");
  const findLines = find.split("\n");

  for (let i = 0; i <= contentLines.length - findLines.length; i++) {
    const block = contentLines.slice(i, i + findLines.length).join("\n");
    if (removeIndent(block) === normalizedFind) {
      yield block;
    }
  }
};

/** Handle backslash-escapes in the model's `find` string (\\n, \\t, etc.). */
export const EscapeNormalizedReplacer: Replacer = function* (content, find) {
  const unescape = (str: string): string =>
    str.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (match, ch) => {
      switch (ch) {
        case "n":
          return "\n";
        case "t":
          return "\t";
        case "r":
          return "\r";
        case "'":
          return "'";
        case '"':
          return '"';
        case "`":
          return "`";
        case "\\":
          return "\\";
        case "\n":
          return "\n";
        case "$":
          return "$";
        default:
          return match;
      }
    });

  const unescapedFind = unescape(find);
  if (content.includes(unescapedFind)) {
    yield unescapedFind;
  }

  const lines = content.split("\n");
  const findLines = unescapedFind.split("\n");
  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join("\n");
    if (unescape(block) === unescapedFind) {
      yield block;
    }
  }
};

/** Trim leading/trailing whitespace from `find` before searching. */
export const TrimmedBoundaryReplacer: Replacer = function* (content, find) {
  const trimmed = find.trim();
  if (trimmed === find) return;

  if (content.includes(trimmed)) {
    yield trimmed;
  }

  const lines = content.split("\n");
  const findLines = find.split("\n");
  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join("\n");
    if (block.trim() === trimmed) {
      yield block;
    }
  }
};

/**
 * Same anchor strategy as BlockAnchorReplacer but with a relaxed similarity
 * threshold (50% line overlap instead of Levenshtein-weighted). Catches
 * cases the anchor replacer misses on heavily-modified middles.
 */
export const ContextAwareReplacer: Replacer = function* (content, find) {
  const findLines = find.split("\n");
  if (findLines.length < 3) return;
  if (findLines[findLines.length - 1] === "") findLines.pop();

  const contentLines = content.split("\n");
  const firstLine = findLines[0]!.trim();
  const lastLine = findLines[findLines.length - 1]!.trim();

  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i]!.trim() !== firstLine) continue;
    for (let j = i + 2; j < contentLines.length; j++) {
      if (contentLines[j]!.trim() === lastLine) {
        const blockLines = contentLines.slice(i, j + 1);
        const block = blockLines.join("\n");

        if (blockLines.length === findLines.length) {
          let matching = 0;
          let totalNonEmpty = 0;
          for (let k = 1; k < blockLines.length - 1; k++) {
            const bLine = blockLines[k]!.trim();
            const fLine = findLines[k]!.trim();
            if (bLine.length > 0 || fLine.length > 0) {
              totalNonEmpty++;
              if (bLine === fLine) matching++;
            }
          }
          if (totalNonEmpty === 0 || matching / totalNonEmpty >= 0.5) {
            yield block;
            break;
          }
        }
        break;
      }
    }
  }
};

/** Yield each occurrence of an exact-match `find` (used for replaceAll). */
export const MultiOccurrenceReplacer: Replacer = function* (content, find) {
  let startIndex = 0;
  while (true) {
    const index = content.indexOf(find, startIndex);
    if (index === -1) break;
    yield find;
    startIndex = index + find.length;
  }
};

const REPLACERS: Replacer[] = [
  SimpleReplacer,
  LineTrimmedReplacer,
  BlockAnchorReplacer,
  WhitespaceNormalizedReplacer,
  IndentationFlexibleReplacer,
  EscapeNormalizedReplacer,
  TrimmedBoundaryReplacer,
  ContextAwareReplacer,
  MultiOccurrenceReplacer,
];

/**
 * Apply the cascade. Returns the post-replacement content if a unique
 * candidate is found at any tier; throws with a descriptive error
 * otherwise. Mirrors opencode's `replace` orchestrator.
 */
export function replaceWithCascade(
  content: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): string {
  if (oldString === newString) {
    throw new Error(
      "No changes to apply: old_string and new_string are identical.",
    );
  }

  let foundButAmbiguous = false;

  for (const replacer of REPLACERS) {
    for (const search of replacer(content, oldString)) {
      const index = content.indexOf(search);
      if (index === -1) continue;

      if (replaceAll) {
        return content.replaceAll(search, newString);
      }
      const lastIndex = content.lastIndexOf(search);
      if (index !== lastIndex) {
        foundButAmbiguous = true;
        continue;
      }
      return (
        content.substring(0, index) +
        newString +
        content.substring(index + search.length)
      );
    }
  }

  if (foundButAmbiguous) {
    throw new Error(
      "Found multiple matches for old_string. Provide more surrounding context to make the match unique.",
    );
  }
  throw new Error(
    "Could not find old_string in the file. It must match the file content (whitespace and indentation are matched flexibly across multiple strategies, but the structural content must be present).",
  );
}
