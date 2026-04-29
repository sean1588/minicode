#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const MINICODE_REGISTRY_ENTRY = `

    minicode: {
        defaultProvider: 'openrouter' as ProviderType,
        install: { method: 'npm', bin: 'minicode', package: '@sean.holung/minicode' },
        getEnv(config: AgentConfig): Record<string, string> {
            const provider = config.provider ?? 'openrouter';
            const env: Record<string, string> = {
                MAX_STEPS: process.env.MINICODE_BENCHMARK_MAX_STEPS || '50',
                MAX_CONTEXT_TOKENS: process.env.MINICODE_BENCHMARK_MAX_CONTEXT_TOKENS || '32000',
                COMMAND_TIMEOUT_MS: process.env.MINICODE_BENCHMARK_COMMAND_TIMEOUT_MS || '30000',
                MODEL_TIMEOUT_SECONDS: process.env.MINICODE_BENCHMARK_MODEL_TIMEOUT_SECONDS || '60',
                MAX_TOOL_OUTPUT_CHARS: process.env.MINICODE_BENCHMARK_MAX_TOOL_OUTPUT_CHARS || '8000',
                CONFIRM_DESTRUCTIVE: 'false'
            };

            switch (provider) {
                case 'openrouter':
                    env.OPENROUTER_API_KEY = requireEnv('OPENROUTER_API_KEY', 'Missing OPENROUTER_API_KEY for minicode (OpenRouter) provider');
                    break;
                case 'openai':
                    env.OPENAI_API_KEY = requireEnv('OPENAI_API_KEY', 'Missing OPENAI_API_KEY for minicode (OpenAI) provider');
                    break;
                case 'anthropic':
                    env.ANTHROPIC_API_KEY = requireEnv('ANTHROPIC_API_KEY', 'Missing ANTHROPIC_API_KEY for minicode (Anthropic) provider');
                    break;
                default:
                    throw new Error(\`Unsupported provider for minicode: \${provider}. Use openrouter, openai, or anthropic.\`);
            }

            return env;
        },
        buildArgs(config: AgentConfig, instructions: string): string[] {
            const provider = config.provider ?? 'openrouter';
            const exerciseId = (config.exercise ?? 'benchmark').replace(/[^A-Za-z0-9._-]+/g, '-');
            const args = [
                'bash',
                config.agentScriptPath,
                'minicode',
                'benchmark',
                'run',
                '--workspace-root',
                '.',
                '--out',
                \`minicode-\${exerciseId}.json\`,
                '--diff-out',
                \`minicode-\${exerciseId}.patch\`
            ];

            const benchmarkConfig = process.env.MINICODE_BENCHMARK_CONFIG;
            if (benchmarkConfig) {
                args.push('--config', benchmarkConfig);
            }

            const benchmarkEnvFile = process.env.MINICODE_BENCHMARK_ENV_FILE;
            if (benchmarkEnvFile) {
                args.push('--env-file', benchmarkEnvFile);
            }

            switch (provider) {
                case 'anthropic':
                    args.push('--provider', 'anthropic');
                    break;
                case 'openai':
                    args.push(
                        '--provider',
                        'openai-compatible',
                        '--base-url',
                        process.env.MINICODE_OPENAI_BASE_URL || 'https://api.openai.com/v1'
                    );
                    break;
                case 'openrouter':
                    args.push(
                        '--provider',
                        'openai-compatible',
                        '--base-url',
                        process.env.MINICODE_OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1'
                    );
                    break;
                default:
                    throw new Error(\`Unsupported provider for minicode: \${provider}. Use openrouter, openai, or anthropic.\`);
            }

            if (config.model) {
                args.push('--model', config.model);
            }

            args.push(instructions);
            return args;
        }
    }`;

const MINICODE_AGENTS_JSON_ENTRY =
  '  "minicode":  { "bin": "minicode",     "method": "npm",      "package": "@sean.holung/minicode" },';

function insertBeforeMarker(
  source: string,
  marker: string,
  insertion: string,
  description: string,
): string {
  const index = source.indexOf(marker);
  if (index === -1) {
    throw new Error(`Could not find ${description} marker.`);
  }
  return `${source.slice(0, index)}${insertion}${source.slice(index)}`;
}

function insertBeforeNthOccurrence(
  source: string,
  marker: string,
  occurrence: number,
  insertion: string,
  description: string,
): string {
  let searchIndex = 0;
  let matchIndex = -1;

  for (let count = 0; count < occurrence; count += 1) {
    matchIndex = source.indexOf(marker, searchIndex);
    if (matchIndex === -1) {
      throw new Error(`Could not find ${description} occurrence ${occurrence}.`);
    }
    searchIndex = matchIndex + marker.length;
  }

  return `${source.slice(0, matchIndex)}${insertion}${source.slice(matchIndex)}`;
}

export function injectMinicodeRegistry(source: string): string {
  if (source.includes("minicode: {")) {
    return source;
  }

  return insertBeforeMarker(
    source,
    "\n} satisfies Record<string, AgentDefinition>;",
    `,${MINICODE_REGISTRY_ENTRY}\n`,
    "registry closing",
  );
}

export function injectMinicodeAgentsJson(source: string): string {
  if (source.includes('"minicode"')) {
    return source;
  }

  if (source.includes('\n  "kimi":')) {
    return source.replace('\n  "kimi":', `\n${MINICODE_AGENTS_JSON_ENTRY}\n\n  "kimi":`);
  }

  return insertBeforeMarker(source, "\n}", `\n${MINICODE_AGENTS_JSON_ENTRY}\n`, "agents.json closing");
}

export function injectMinicodeSiteDisplayName(source: string): string {
  if (source.includes("case 'minicode':")) {
    return source;
  }

  if (source.includes("case 'opencode':")) {
    return source.replace(
      "        case 'opencode': return 'OpenCode';",
      "        case 'minicode': return 'minicode';\n        case 'opencode': return 'OpenCode';",
    );
  }

  const next = source.replace(
    "        default: return slug.charAt(0).toUpperCase() + slug.slice(1).toLowerCase();",
    "        case 'minicode': return 'minicode';\n        default: return slug.charAt(0).toUpperCase() + slug.slice(1).toLowerCase();",
  );
  if (next === source) {
    throw new Error("Could not find agent display-name switch marker.");
  }
  return next;
}

export function injectMinicodeVersionDetector(source: string): string {
  if (
    source.includes("return ['minicode', '--version'];")
    && source.includes("case 'minicode':\n                return this.extractGenericVersion(cleanOutput);")
  ) {
    return source;
  }

  let next = source;
  next = insertBeforeNthOccurrence(
    next,
    "            case 'opencode':",
    1,
    "            case 'minicode':\n                return ['minicode', '--version'];\n",
    "version detector command switch",
  );
  next = insertBeforeNthOccurrence(
    next,
    "            case 'opencode':",
    2,
    "            case 'minicode':\n                return this.extractGenericVersion(cleanOutput);\n",
    "version detector parse switch",
  );
  return next;
}

export function injectMinicodeLeaderboardName(source: string): string {
  if (source.includes("case 'minicode': return 'minicode';")) {
    return source;
  }

  const next = source.replace(
    /(\s*case 'kimi': return 'Kimi Code CLI';)/,
    "            case 'minicode': return 'minicode';\n$1",
  );
  if (next !== source) {
    return next;
  }

  const fallback = source.replace(
    /(\s*default: return agent\.charAt\(0\)\.toUpperCase\(\) \+ agent\.slice\(1\)\.toLowerCase\(\);)/,
    "            case 'minicode': return 'minicode';\n$1",
  );
  if (fallback === source) {
    throw new Error("Could not find leaderboard agent-name switch marker.");
  }
  return fallback;
}

export async function applyTsBenchMinicodeAdapter(tsBenchRoot: string): Promise<void> {
  const files = [
    {
      path: path.join(tsBenchRoot, "src", "agents", "registry.ts"),
      transform: injectMinicodeRegistry,
    },
    {
      path: path.join(tsBenchRoot, "scripts", "agents.json"),
      transform: injectMinicodeAgentsJson,
    },
    {
      path: path.join(tsBenchRoot, "src", "site", "shared", "format.ts"),
      transform: injectMinicodeSiteDisplayName,
    },
    {
      path: path.join(tsBenchRoot, "src", "utils", "version-detector.ts"),
      transform: injectMinicodeVersionDetector,
    },
    {
      path: path.join(tsBenchRoot, "src", "utils", "leaderboard-generator.ts"),
      transform: injectMinicodeLeaderboardName,
    },
  ];

  for (const file of files) {
    const current = await readFile(file.path, "utf8");
    const updated = file.transform(current);
    if (updated !== current) {
      await writeFile(file.path, updated, "utf8");
    }
  }
}

interface AdapterCliArgs {
  tsBenchPath: string;
}

function parseAdapterCliArgs(argv: string[]): AdapterCliArgs {
  let tsBenchPath: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }

    if (arg === "--ts-bench-path") {
      const next = argv[i + 1];
      if (!next || next.startsWith("-")) {
        throw new Error("--ts-bench-path requires a value.");
      }
      tsBenchPath = next;
      i += 1;
      continue;
    }

    if (arg.startsWith("--ts-bench-path=")) {
      tsBenchPath = arg.slice("--ts-bench-path=".length).trim();
      continue;
    }
  }

  if (!tsBenchPath) {
    throw new Error("Usage: node --import tsx scripts/ts-bench-adapter.ts --ts-bench-path /path/to/ts-bench");
  }

  return { tsBenchPath };
}

async function main(): Promise<void> {
  const args = parseAdapterCliArgs(process.argv.slice(2));
  const tsBenchRoot = path.resolve(process.cwd(), args.tsBenchPath);
  await applyTsBenchMinicodeAdapter(tsBenchRoot);
  console.log(`Applied minicode adapter to ${tsBenchRoot}`);
}

const invokedPath = process.argv[1];
if (invokedPath && path.resolve(invokedPath) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
