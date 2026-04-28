import {
  ToolRegistry,
  createReadFileTool,
  createWriteFileTool,
  createEditFileTool,
  createSearchTool,
  createListFilesTool,
  createRunCommandTool,
} from "@minicode/agent-sdk";
import type { AgentConfig, ToolDefinition } from "@minicode/agent-sdk";
import type { ProjectIndex } from "../indexer/types.js";
import { createFindReferencesTool } from "./find-references.js";
import { createGetDependenciesTool } from "./get-dependencies.js";
import { createReadSymbolTool } from "./read-symbol.js";
import { createFindPathTool } from "./find-path.js";
import { createSearchCodeMapTool } from "./search-code-map.js";

export { ToolRegistry };

async function reindexBestEffort(
  projectIndex: ProjectIndex,
  relPath: string,
  content: string,
): Promise<void> {
  try {
    await projectIndex.reindexFile(relPath, content);
  } catch {
    // Best effort only: the file mutation already succeeded.
  }
}

/**
 * Create a ToolRegistry with the SDK's core tools plus indexer-specific tools
 * when a ProjectIndex is available.
 */
export function createToolRegistry(
  config: AgentConfig,
  projectIndex?: ProjectIndex,
): ToolRegistry {
  const hooks = projectIndex
    ? {
        afterWrite: (relPath: string, content: string) =>
          reindexBestEffort(projectIndex, relPath, content),
        afterEdit: (relPath: string, content: string) =>
          reindexBestEffort(projectIndex, relPath, content),
        afterCommand: async () => {
          await projectIndex.refreshFromWorkspace();
        },
      }
    : undefined;

  const tools: ToolDefinition[] = [
    createReadFileTool(config),
    createWriteFileTool(config, hooks ? { afterWrite: hooks.afterWrite } : undefined),
    createEditFileTool(config, hooks ? { afterEdit: hooks.afterEdit } : undefined),
    createSearchTool(config),
    createListFilesTool(config),
    createRunCommandTool(config, hooks ? { afterCommand: hooks.afterCommand } : undefined),
  ];

  if (projectIndex) {
    tools.splice(1, 0, createReadSymbolTool(config, projectIndex));
    tools.splice(2, 0, createFindReferencesTool(projectIndex));
    tools.splice(3, 0, createGetDependenciesTool(projectIndex));
    tools.splice(4, 0, createFindPathTool(projectIndex));
    tools.splice(5, 0, createSearchCodeMapTool(projectIndex));
  }

  return new ToolRegistry(tools);
}
