import type { ModelInfo } from "@minicode/agent-sdk";

function getModelDisplayName(model: ModelInfo): string {
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
