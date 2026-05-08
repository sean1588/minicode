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

/**
 * Inputs to a system-prompt builder. Passed to the default
 * `buildSystemPrompt` and to any custom builder a consumer wires into
 * `CodingAgent` via the `buildSystemPrompt` constructor option.
 *
 * Custom builders can use these freely or ignore them — minicode's
 * default ships a coding-agent identity, workspace context, tool
 * guidelines, code-map injection, and safety rules. Consumers building
 * domain-specific agents (review bots, RAG assistants, non-coding
 * use cases) typically want to drop most of that and assemble their
 * own from these inputs.
 */
export interface SystemPromptContext {
  config: AgentConfig;
  tools: ToolSchema[];
  /**
   * The current code map snippet, when one is available. Built once per
   * turn (or per session, depending on `enableDynamicPrompt`) and
   * passed in so builders can inject it without knowing how it was
   * computed. May be undefined when no language plugin is active.
   */
  codeMap?: CodeMapResult | undefined;
}

/**
 * Function shape for a system-prompt builder. Returning a Promise is
 * supported so consumers can fetch context from external sources (RAG
 * snippets, git status, on-disk preferences, etc.) before assembling
 * the prompt.
 */
export type SystemPromptBuilder = (
  ctx: SystemPromptContext,
) => string | Promise<string>;

export function buildSystemPrompt(ctx: SystemPromptContext): string {
  const { config, tools, codeMap } = ctx;
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

  if (codeMap && codeMap.text.length > 0) {
    sections.push("[Project Code Map]", codeMap.text, "");
    const truncated =
      codeMap.totalCount > 0 &&
      codeMap.shownCount < codeMap.totalCount;
    if (truncated) {
      const hint = hasSearchCodeMap
        ? " Use search_code_map to find symbols not listed above."
        : "";
      sections.push(
        `Showing ${codeMap.shownCount} of ${codeMap.totalCount} symbols.${hint}`,
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
    "- Default to using preferred tools when doing planning, code exploration, or investigation."
  ];

  if (hasSpecializedTools) {
    toolGuidelines.push(
      "",
      "[Code exploration PREFERRED TOOLS — prefer these over read_file and search]",
      ...(hasReadSymbol
        ? [
            "- PREFER read_symbol over read_file for .ts/.tsx/.js/.jsx when you need a function or class. The code map lists all symbols; use read_symbol(name) for targeted reads — it returns only the relevant code and avoids bloating context.",
            "- Use read_file only for config files, small files, non-code files, or when the symbol name is unknown.",
          ]
        : []),
      ...(hasFindRefs
        ? [
            "- Use find_references to see what calls or uses a symbol — essential for understanding impact before changes.",
          ]
        : []),
      ...(hasGetDeps
        ? [
            "- Use get_dependencies to see what a symbol depends on — essential for understanding implementation and data flow.",
          ]
        : []),
      "- Use search only when you don't know the symbol name; once you find a symbol in the code map or search results, use read_symbol (not read_file) to read it.",
      "- When tracing code: use get_dependencies to go inward (what does X call?), find_references to go outward (what calls X?).",
      ...(hasSearchCodeMap
        ? [
            "- PREFER search_code_map over search. When the code map is truncated, use search_code_map to find symbols by name or substring — then use read_symbol with the result.",
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
    "[Tool Efficiency]",
    "- When you need multiple independent operations, make ALL the tool calls in a SINGLE response — they execute in parallel. Reading three files? Issue three tool calls in one turn, not three sequential turns.",
    "- This is about batching work per turn, not about skipping investigation. Take as many turns as you need to understand the problem; just don't waste turns on independent work that could happen together.",
    "- For shell work, chain related commands with && in a single run_command rather than issuing them one by one.",
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
    "- Ask for clarification if user intent is ambiguous.",
    "- Briefly explain what you're about to do before making changes, then proceed. The host enforces per-tool-call permission gating where appropriate; do not also ask for confirmation in chat."
  );

  return sections.join("\n");
}
