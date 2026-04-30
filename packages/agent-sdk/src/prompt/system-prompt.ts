import { existsSync } from "node:fs";
import path from "node:path";

import type { AgentConfig, ToolSchema } from "../agent/types.js";
import type { CodeMapResult } from "../indexer/types.js";

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

function hasTool(tools: ToolSchema[], name: string): boolean {
  return tools.some((t) => t.name === name);
}

export function buildSystemPrompt(
  config: AgentConfig,
  tools: ToolSchema[],
  codeMapResult?: CodeMapResult,
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

  const hasSearchCodeMap = hasTool(tools, "search_code_map");

  if (codeMapResult && codeMapResult.text.length > 0) {
    sections.push("[Project Code Map]", codeMapResult.text, "");
    const truncated =
      codeMapResult.totalCount > 0 &&
      codeMapResult.shownCount < codeMapResult.totalCount;
    if (truncated) {
      const hint = hasSearchCodeMap
        ? " Use search_code_map to find symbols not listed above."
        : "";
      sections.push(
        `Showing ${codeMapResult.shownCount} of ${codeMapResult.totalCount} symbols.${hint}`,
        "",
      );
    }
  }

  const hasReadSymbol = hasTool(tools, "read_symbol");
  const hasFindRefs = hasTool(tools, "find_references");
  const hasGetDeps = hasTool(tools, "get_dependencies");
  const hasSpecializedTools =
    hasReadSymbol || hasFindRefs || hasGetDeps || hasSearchCodeMap;

  const toolGuidelines: string[] = [
    "[Tool Usage Guidelines]",
    "- Always read a file before editing it.",
    "- Prefer edit_file over write_file for existing files.",
    "- Run tests or lint after code changes when applicable.",
    "- Choose the smallest set of tools that gives enough confidence to make the change."
  ];

  if (hasSpecializedTools) {
    toolGuidelines.push(
      "",
      "[Code Exploration Strategy]",
      ...(hasReadSymbol
        ? [
            "- Use read_symbol when you already know the relevant function, class, or type and want a targeted read.",
            "- Use read_file when you need broader local context, file-level flow, config/test files, or when the relevant symbol is unclear.",
          ]
        : []),
      ...(hasFindRefs
        ? [
            "- Use find_references when call sites or usage impact matter before changing a symbol.",
          ]
        : []),
      ...(hasGetDeps
        ? [
            "- Use get_dependencies when implementation/data-flow dependencies matter for the change.",
          ]
        : []),
      "- Use search for broad text discovery, unknown names, tests, config, protocol strings, and error messages.",
      "- When tracing code, combine broad reads/search with symbol tools as needed: get_dependencies goes inward, find_references goes outward.",
      ...(hasSearchCodeMap
        ? [
            "- Use search_code_map when looking for symbols by name or substring, especially when the code map is truncated.",
          ]
        : []),
    );
  } else {
    toolGuidelines.push(
      "",
      "- Use read_file with offset and limit for large files to read only needed portions.",
      "- Use search to find relevant code before making changes.",
    );
  }

  sections.push(
    "[Tool Descriptions]",
    "You have the following tools available:",
    renderToolList(tools),
    "",
    ...toolGuidelines,
    "",
    "[Code Reading Strategy]",
    "- Start with entry points (e.g. index.ts, main) and follow the flow.",
    ...(hasSpecializedTools
      ? [
          "- Use find_references to see who uses a symbol; use get_dependencies to see what it calls.",
          "- Trace usage outward (find_references) or implementation inward (get_dependencies) as needed.",
        ]
      : ["- Use search to locate relevant code, then read_file to inspect it."]),
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
    "- When asked to perform a task, communicate your execution plan to the user and ask for their confirmation before proceeding with any modifications."
  );

  return sections.join("\n");
}
