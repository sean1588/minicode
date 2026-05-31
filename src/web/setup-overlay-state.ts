export type ConfiguredProvider = "anthropic" | "openrouter" | "openai-compatible" | null;

export interface SetupOverlayStateInput {
  configuredProvider?: ConfiguredProvider;
  missing?: string[];
}

export interface SetupOverlayState {
  introText: string;
  hideQuickConnects: boolean;
  hideOpenRouterSpotlight: boolean;
  missingItems: string[];
  showModelSelectionHint: boolean;
  modelSelectionNote: string | null;
}

export const DEFAULT_SETUP_INTRO =
  "minicode needs a model provider to run. Configure one of the following:";

export function deriveSetupOverlayState(input: SetupOverlayStateInput): SetupOverlayState {
  const missingItems = input.missing ?? [];
  const configuredProvider = input.configuredProvider ?? null;
  const isOnlyModelMissing =
    missingItems.length === 1 &&
    typeof missingItems[0] === "string" &&
    missingItems[0].includes("MODEL");
  const hasConfiguredProvider = isOnlyModelMissing && configuredProvider !== null;

  const filteredMissingItems = hasConfiguredProvider
    ? missingItems
    : missingItems.filter((item) => !item.includes("MODEL"));

  const introText = configuredProvider === "openrouter" && isOnlyModelMissing
    ? "OpenRouter is already configured. Select a model to continue:"
    : configuredProvider === "openai-compatible" && isOnlyModelMissing
      ? "An OpenAI-compatible provider is already configured. Select a model to continue:"
      : configuredProvider === "anthropic" && isOnlyModelMissing
        ? "Anthropic is already configured. Select a model to continue:"
        : DEFAULT_SETUP_INTRO;

  return {
    introText,
    hideQuickConnects: false,
    hideOpenRouterSpotlight: configuredProvider === "openrouter" && isOnlyModelMissing,
    missingItems: filteredMissingItems,
    showModelSelectionHint: hasConfiguredProvider,
    modelSelectionNote: configuredProvider === "openrouter" && isOnlyModelMissing
      ? 'If you are on the OpenRouter free tier, search "free" in the model dropdown to find supported free models.'
      : null,
  };
}
