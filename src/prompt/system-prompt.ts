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
    "- Use read_symbol for code files when you need a specific function or class — the code map lists symbols; use read_symbol(name) instead of read_file for .ts/.tsx/.js/.jsx/.py files, as it returns only the relevant code and avoids bloating context.",
    "- Avoid read_file on large code files — use read_symbol for targeted reads, or use read_file with offset and limit to read only the needed portion.",
    "- Use read_file for config files, small files, or non-code files. When using read_file on large files, pass offset and limit to read partial content.",
    "- Use find_references to see what uses a symbol; use get_dependencies to see what a symbol depends on.",
    "- Always read a file before editing it.",
    "- Use search to find relevant code before making changes.",
    "- Prefer edit_file over write_file for existing files.",
    "- Run tests or lint after code changes when applicable.",
    "",
    "[Termination Policy]",
    "- When the user asks you to do something (edit code, search, run commands, etc.), you MUST use the appropriate tools first. Do not conclude until you have actually performed the work.",
    "- When the task is complete, respond with a concise summary of what you changed.",
    "- If you cannot complete the task, explain what is blocking you.",
    "- Do not respond with empty text. Always provide a summary or explanation.",
    "- Do not continue exploring once the task is done.",
    "",
    "[Safety Rules]",
    "- Never modify files outside the workspace directory.",
    "- Never run destructive commands without explicit user confirmation.",
    "- Ask for clarification if user intent is ambiguous.",
  );

  return sections.join("\n");
}

