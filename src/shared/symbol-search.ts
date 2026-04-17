export interface SymbolSearchCandidateRecord {
  name: string;
  qualifiedName: string;
  kind: string;
  filePath: string;
  startLine: number;
  exported?: boolean;
}

export interface SymbolSearchCandidate<T> {
  symbol: T;
  record: SymbolSearchCandidateRecord;
  lookupNames: string[];
}

export interface SearchSymbolsOptions {
  kind?: string | undefined;
  limit?: number | undefined;
  skip?: number | undefined;
}

export interface SearchSymbolsResult<T> {
  matches: T[];
  mode: "substring" | "similar" | "none";
  total: number;
}

const MIN_SIMILARITY_QUERY_LENGTH = 3;
const MIN_SIMILARITY_SCORE = 0.62;

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function tokenizeSearchText(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function levenshteinDistance(a: string, b: string): number {
  if (a === b) {
    return 0;
  }

  if (a.length === 0) {
    return b.length;
  }
  if (b.length === 0) {
    return a.length;
  }

  const previous = new Array<number>(b.length + 1);
  const current = new Array<number>(b.length + 1);

  for (let j = 0; j <= b.length; j += 1) {
    previous[j] = j;
  }

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1]! + 1,
        previous[j]! + 1,
        previous[j - 1]! + cost,
      );
    }

    for (let j = 0; j <= b.length; j += 1) {
      previous[j] = current[j]!;
    }
  }

  return previous[b.length]!;
}

function diceCoefficient(a: string, b: string): number {
  if (a === b) {
    return 1;
  }

  if (a.length < 2 || b.length < 2) {
    return 0;
  }

  const bigrams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i += 1) {
    const bigram = a.slice(i, i + 2);
    bigrams.set(bigram, (bigrams.get(bigram) ?? 0) + 1);
  }

  let matches = 0;
  for (let i = 0; i < b.length - 1; i += 1) {
    const bigram = b.slice(i, i + 2);
    const count = bigrams.get(bigram) ?? 0;
    if (count > 0) {
      bigrams.set(bigram, count - 1);
      matches += 1;
    }
  }

  return (2 * matches) / ((a.length - 1) + (b.length - 1));
}

function computeSimilarityScore(pattern: string, candidate: string): number {
  const normalizedPattern = normalizeSearchText(pattern);
  const normalizedCandidate = normalizeSearchText(candidate);
  if (!normalizedPattern || !normalizedCandidate) {
    return 0;
  }

  if (normalizedPattern === normalizedCandidate) {
    return 1;
  }

  const maxLength = Math.max(normalizedPattern.length, normalizedCandidate.length, 1);
  const lengthPenalty = Math.abs(normalizedCandidate.length - normalizedPattern.length) / maxLength;
  let bestScore = 0;

  if (
    normalizedCandidate.startsWith(normalizedPattern) ||
    normalizedPattern.startsWith(normalizedCandidate)
  ) {
    bestScore = Math.max(bestScore, 0.93 - (lengthPenalty * 0.2));
  }

  const tokens = tokenizeSearchText(candidate);
  if (tokens.some((token) => token.startsWith(normalizedPattern) || normalizedPattern.startsWith(token))) {
    bestScore = Math.max(bestScore, 0.88 - (lengthPenalty * 0.15));
  }

  const editDistance = levenshteinDistance(normalizedPattern, normalizedCandidate);
  const maxDistance = Math.max(1, Math.ceil(normalizedPattern.length * 0.34));
  if (editDistance <= maxDistance) {
    const editSimilarity = 1 - (editDistance / maxLength);
    bestScore = Math.max(bestScore, 0.62 + (editSimilarity * 0.3));
  }

  const dice = diceCoefficient(normalizedPattern, normalizedCandidate);
  if (dice >= 0.5) {
    bestScore = Math.max(bestScore, 0.45 + (dice * 0.35));
  }

  return bestScore;
}

function compareSubstringCandidates<T>(
  pattern: string,
  a: SymbolSearchCandidate<T>,
  b: SymbolSearchCandidate<T>,
): number {
  const lowerPattern = pattern.toLowerCase();
  const aExact = Number(a.lookupNames.some((value) => value.toLowerCase() === lowerPattern));
  const bExact = Number(b.lookupNames.some((value) => value.toLowerCase() === lowerPattern));
  if (aExact !== bExact) {
    return bExact - aExact;
  }

  return Number(b.record.exported ?? false) - Number(a.record.exported ?? false) ||
    a.record.name.localeCompare(b.record.name) ||
    a.record.filePath.localeCompare(b.record.filePath) ||
    a.record.startLine - b.record.startLine ||
    a.record.qualifiedName.localeCompare(b.record.qualifiedName);
}

function compareSimilarCandidates<T>(
  a: { candidate: SymbolSearchCandidate<T>; score: number },
  b: { candidate: SymbolSearchCandidate<T>; score: number },
): number {
  return b.score - a.score ||
    Number(b.candidate.record.exported ?? false) - Number(a.candidate.record.exported ?? false) ||
    a.candidate.record.name.localeCompare(b.candidate.record.name) ||
    a.candidate.record.filePath.localeCompare(b.candidate.record.filePath) ||
    a.candidate.record.startLine - b.candidate.record.startLine ||
    a.candidate.record.qualifiedName.localeCompare(b.candidate.record.qualifiedName);
}

export function searchSymbols<T>(
  candidates: SymbolSearchCandidate<T>[],
  pattern: string,
  options: SearchSymbolsOptions = {},
): SearchSymbolsResult<T> {
  const lowerPattern = pattern.toLowerCase();
  const normalizedKind = options.kind?.trim().toLowerCase();
  const skip = Math.max(0, options.skip ?? 0);
  const limit = Math.max(1, options.limit ?? 30);

  const filtered = candidates.filter((candidate) => {
    if (normalizedKind && candidate.record.kind.toLowerCase() !== normalizedKind) {
      return false;
    }
    return true;
  });

  const substringMatches = filtered
    .filter((candidate) =>
      candidate.lookupNames.some((value) => value.toLowerCase().includes(lowerPattern)),
    )
    .sort((a, b) => compareSubstringCandidates(pattern, a, b));

  if (substringMatches.length > 0) {
    return {
      matches: substringMatches.slice(skip, skip + limit).map((candidate) => candidate.symbol),
      mode: "substring",
      total: substringMatches.length,
    };
  }

  const normalizedPattern = normalizeSearchText(pattern);
  if (normalizedPattern.length < MIN_SIMILARITY_QUERY_LENGTH) {
    return { matches: [], mode: "none", total: 0 };
  }

  const similarMatches = filtered
    .map((candidate) => ({
      candidate,
      score: Math.max(...candidate.lookupNames.map((value) => computeSimilarityScore(pattern, value))),
    }))
    .filter((entry) => entry.score >= MIN_SIMILARITY_SCORE)
    .sort(compareSimilarCandidates);

  if (similarMatches.length === 0) {
    return { matches: [], mode: "none", total: 0 };
  }

  return {
    matches: similarMatches.slice(skip, skip + limit).map((entry) => entry.candidate.symbol),
    mode: "similar",
    total: similarMatches.length,
  };
}
