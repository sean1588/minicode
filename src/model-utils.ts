import type { ModelInfo } from "@minicode/agent-sdk";

export function getModelDisplayName(model: ModelInfo): string {
  return (model.name ?? model.id).trim();
}

export function sortModelsAlphabetically(models: ModelInfo[]): ModelInfo[] {
  return [...models].sort((left, right) => {
    const byDisplayName = getModelDisplayName(left).localeCompare(getModelDisplayName(right), undefined, {
      sensitivity: "base",
      numeric: true,
    });

    if (byDisplayName !== 0) {
      return byDisplayName;
    }

    return left.id.localeCompare(right.id, undefined, {
      sensitivity: "base",
      numeric: true,
    });
  });
}

function normalizeModelSearchValue(value: string): string[] {
  return value
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

export function filterModelsByQuery(models: ModelInfo[], query: string): ModelInfo[] {
  const tokens = normalizeModelSearchValue(query);
  if (tokens.length === 0) {
    return [...models];
  }

  return models.filter((model) => {
    const haystack = `${getModelDisplayName(model)} ${model.id}`.toLocaleLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}
