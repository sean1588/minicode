import type { AgentConfig, ToolDefinition, ToolSchema } from "../agent/types.js";
import type { EditFileHooks } from "./edit-file.js";
import type { WriteFileHooks } from "./write-file.js";
import { createEditFileTool } from "./edit-file.js";
import { createListFilesTool } from "./list-files.js";
import { createReadFileTool } from "./read-file.js";
import { createRunCommandTool } from "./run-command.js";
import { createSearchTool } from "./search.js";
import { createWriteFileTool } from "./write-file.js";

function ensureInputObject(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Tool input must be a JSON object.");
  }
  return input as Record<string, unknown>;
}

function toToolSchema(tool: ToolDefinition): ToolSchema {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  };
}

export interface CoreToolHooks {
  afterWrite?: WriteFileHooks["afterWrite"];
  afterEdit?: EditFileHooks["afterEdit"];
}

export class ToolRegistry {
  private readonly toolsByName = new Map<string, ToolDefinition>();

  constructor(tools: ToolDefinition[]) {
    for (const tool of tools) {
      if (this.toolsByName.has(tool.name)) {
        throw new Error(`Duplicate tool registration for "${tool.name}".`);
      }
      this.toolsByName.set(tool.name, tool);
    }
  }

  static createDefault(
    config: AgentConfig,
    hooks?: CoreToolHooks,
  ): ToolRegistry {
    const tools: ToolDefinition[] = [
      createReadFileTool(config),
      createWriteFileTool(config, hooks ? { afterWrite: hooks.afterWrite } : undefined),
      createEditFileTool(config, hooks ? { afterEdit: hooks.afterEdit } : undefined),
      createSearchTool(config),
      createListFilesTool(config),
      createRunCommandTool(config),
    ];
    return new ToolRegistry(tools);
  }

  getToolSchemas(): ToolSchema[] {
    return [...this.toolsByName.values()].map(toToolSchema);
  }

  async execute(name: string, input: unknown): Promise<string> {
    const tool = this.toolsByName.get(name);
    if (!tool) {
      return `Tool error: Unknown tool "${name}".`;
    }

    try {
      const inputObject = ensureInputObject(input);
      return await tool.execute(inputObject);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown tool failure";
      return `Tool error (${name}): ${message}`;
    }
  }
}
