import { existsSync } from "node:fs";
import path from "node:path";

import type { AgentConfig, ToolSchema } from "../agent/types.js";

function detectProjectType(workspaceRoot: string): string {
  const checks: Array<{ file: string; type: string }> = [
    { file: "package.json", type: "Node.js / TypeScript" },
    { file: "pyproject.toml", type: "Python" },
    { file: "requirements.txt", type: "Python" },
    { file: "go.mod", type: "Go" },
    { file: "Cargo.toml", type: "Rust" },
    { file: "pom.xml", type: "Java (Maven)" },
  ];

  for (const check of checks) {
    if (existsSync(path.join(workspaceRoot, check.file))) {
      return check.type;
    }
  }

  return "Unknown";
}

function renderToolList(tools: ToolSchema[]): string {
  return tools
    .map((tool) => `- ${tool.name}: ${tool.description}`)
    .join("\n");
}

export function buildSystemPrompt(
  config: AgentConfig,
  tools: ToolSchema[],
  codeMap?: string,
): string {
  const projectType = detectProjectType(config.workspaceRoot);

  const sections: string[] = [
    "[Identity]",
    "You are a coding agent. You help developers read, understand, and modify code in their projects.",
    "",
    "[Workspace Context]",
    `Working directory: ${config.workspaceRoot}`,
    `Project type: ${projectType}`,
    "",
  ];

  if (codeMap && codeMap.length > 0) {
    sections.push("[Project Code Map]", codeMap, "");
  }

  sections.push(
    "[Tool Descriptions]",
    "You have the following tools available:",
    renderToolList(tools),
    "",
    "[Tool Usage Guidelines]",
    "- Always read a file before editing it.",
    "- Use search to find relevant code before making changes.",
    "- Prefer edit_file over write_file for existing files.",
    "- Run tests or lint after code changes when applicable.",
    "",
    "[Termination Policy]",
    "- When the task is complete, respond with a concise summary of what you changed.",
    "- If you cannot complete the task, explain what is blocking you.",
    "- Do not continue exploring once the task is done.",
    "",
    "[Safety Rules]",
    "- Never modify files outside the workspace directory.",
    "- Never run destructive commands without explicit user confirmation.",
    "- Ask for clarification if user intent is ambiguous.",
  );

  return sections.join("\n");
}

