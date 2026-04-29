import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  applyTsBenchMinicodeAdapter,
  injectMinicodeAgentsJson,
  injectMinicodeLeaderboardName,
  injectMinicodeRegistry,
  injectMinicodeSiteDisplayName,
  injectMinicodeVersionDetector,
} from "../scripts/ts-bench-adapter.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("injectMinicodeRegistry inserts a minicode agent exactly once", () => {
  const source = `export const AGENT_REGISTRY = {
    codex: {
        defaultProvider: 'openai' as ProviderType,
        install: { method: 'npm', bin: 'codex', package: '@openai/codex' },
        getEnv(_config: AgentConfig): Record<string, string> {
            return {};
        },
        buildArgs(_config: AgentConfig, instructions: string): string[] {
            return ['bash', 'run-agent.sh', 'codex', instructions];
        }
    }
} satisfies Record<string, AgentDefinition>;
`;

  const once = injectMinicodeRegistry(source);
  const twice = injectMinicodeRegistry(once);

  assert.equal((once.match(/minicode: \{/g) ?? []).length, 1);
  assert.equal(once, twice);
  assert.match(once, /'minicode',\s+'benchmark',\s+'run'/);
  assert.match(once, /MINICODE_BENCHMARK_CONFIG/);
  assert.match(once, /MINICODE_OPENROUTER_BASE_URL/);
});

test("injectMinicodeAgentsJson adds the minicode package metadata exactly once", () => {
  const source = `{
  "claude":    { "bin": "claude",       "method": "npm",      "package": "@anthropic-ai/claude-code" },
  "kimi":      { "bin": "kimi",         "method": "uv_tool",  "package": "kimi-cli",  "python": "3.13" }
}
`;

  const once = injectMinicodeAgentsJson(source);
  const twice = injectMinicodeAgentsJson(once);

  assert.equal(once, twice);
  assert.match(once, /"minicode":\s+\{\s+"bin": "minicode"/);
  assert.match(once, /"package": "@sean\.holung\/minicode"/);
});

test("display-name injectors add minicode labels exactly once", () => {
  const formatSource = `export function agentDisplayName(slug: string): string {
    switch (slug.toLowerCase()) {
        case 'claude': return 'Claude Code';
        case 'opencode': return 'OpenCode';
        default: return slug.charAt(0).toUpperCase() + slug.slice(1).toLowerCase();
    }
}
`;
  const leaderboardSource = `private capitalizeAgent(agent: string): string {
        switch (agent.toLowerCase()) {
            case 'copilot': return 'GitHub Copilot CLI';
            case 'kimi': return 'Kimi Code CLI';
            default: return agent.charAt(0).toUpperCase() + agent.slice(1).toLowerCase();
        }
    }
`;

  const formatOnce = injectMinicodeSiteDisplayName(formatSource);
  const formatTwice = injectMinicodeSiteDisplayName(formatOnce);
  assert.equal(formatOnce, formatTwice);
  assert.match(formatOnce, /case 'minicode': return 'minicode';/);

  const leaderboardOnce = injectMinicodeLeaderboardName(leaderboardSource);
  const leaderboardTwice = injectMinicodeLeaderboardName(leaderboardOnce);
  assert.equal(leaderboardOnce, leaderboardTwice);
  assert.match(leaderboardOnce, /case 'minicode': return 'minicode';/);
});

test("injectMinicodeVersionDetector adds command and parser cases exactly once", () => {
  const source = `private getAgentVersionCommand(agent: AgentType): string[] {
        switch (agent) {
            case 'qwen':
                return ['qwen', '--version'];
            case 'opencode':
                return ['opencode', '--version'];
            default:
                throw new Error(\`Unknown agent: \${agent}\`);
        }
    }

    private parseVersionOutput(agent: AgentType, output: string): string {
        const cleanOutput = output.trim();

        switch (agent) {
            case 'qwen':
                return this.extractGenericVersion(cleanOutput);
            case 'opencode':
                return this.extractGenericVersion(cleanOutput);
            default:
                return this.extractGenericVersion(cleanOutput);
        }
    }
`;

  const once = injectMinicodeVersionDetector(source);
  const twice = injectMinicodeVersionDetector(once);

  assert.equal(once, twice);
  assert.equal((once.match(/case 'minicode':/g) ?? []).length, 2);
  assert.match(once, /return \['minicode', '--version'\];/);
  assert.match(once, /return this\.extractGenericVersion\(cleanOutput\);/);
});

test("applyTsBenchMinicodeAdapter patches a local ts-bench tree idempotently", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "minicode-ts-bench-adapter-"));
  tempDirs.push(root);

  const files = [
    path.join(root, "src", "agents"),
    path.join(root, "src", "site", "shared"),
    path.join(root, "src", "utils"),
    path.join(root, "scripts"),
  ];
  await Promise.all(files.map((dir) => mkdir(dir, { recursive: true })));

  await writeFile(
    path.join(root, "src", "agents", "registry.ts"),
    `export const AGENT_REGISTRY = {
    kimi: {
        defaultProvider: 'moonshot' as ProviderType,
        install: { method: 'uv_tool', bin: 'kimi', package: 'kimi-cli', python: '3.13' },
        getEnv(_config: AgentConfig): Record<string, string> {
            return {};
        },
        buildArgs(_config: AgentConfig, instructions: string): string[] {
            return ['bash', 'run-agent.sh', 'kimi', instructions];
        }
    }
} satisfies Record<string, AgentDefinition>;
`,
    "utf8",
  );
  await writeFile(
    path.join(root, "scripts", "agents.json"),
    `{
  "claude":    { "bin": "claude",       "method": "npm",      "package": "@anthropic-ai/claude-code" },
  "kimi":      { "bin": "kimi",         "method": "uv_tool",  "package": "kimi-cli",  "python": "3.13" }
}
`,
    "utf8",
  );
  await writeFile(
    path.join(root, "src", "site", "shared", "format.ts"),
    `export function agentDisplayName(slug: string): string {
    switch (slug.toLowerCase()) {
        case 'opencode': return 'OpenCode';
        default: return slug.charAt(0).toUpperCase() + slug.slice(1).toLowerCase();
    }
}
`,
    "utf8",
  );
  await writeFile(
    path.join(root, "src", "utils", "version-detector.ts"),
    `private getAgentVersionCommand(agent: AgentType): string[] {
        switch (agent) {
            case 'qwen':
                return ['qwen', '--version'];
            case 'opencode':
                return ['opencode', '--version'];
            default:
                throw new Error(\`Unknown agent: \${agent}\`);
        }
    }

    private parseVersionOutput(agent: AgentType, output: string): string {
        const cleanOutput = output.trim();

        switch (agent) {
            case 'qwen':
                return this.extractGenericVersion(cleanOutput);
            case 'opencode':
                return this.extractGenericVersion(cleanOutput);
            default:
                return this.extractGenericVersion(cleanOutput);
        }
    }
`,
    "utf8",
  );
  await writeFile(
    path.join(root, "src", "utils", "leaderboard-generator.ts"),
    `private capitalizeAgent(agent: string): string {
        switch (agent.toLowerCase()) {
            case 'copilot': return 'GitHub Copilot CLI';
            case 'kimi': return 'Kimi Code CLI';
            default: return agent.charAt(0).toUpperCase() + agent.slice(1).toLowerCase();
        }
    }
`,
    "utf8",
  );

  await applyTsBenchMinicodeAdapter(root);
  await applyTsBenchMinicodeAdapter(root);

  const registry = await readFile(path.join(root, "src", "agents", "registry.ts"), "utf8");
  const agentsJson = await readFile(path.join(root, "scripts", "agents.json"), "utf8");
  const format = await readFile(path.join(root, "src", "site", "shared", "format.ts"), "utf8");
  const versionDetector = await readFile(path.join(root, "src", "utils", "version-detector.ts"), "utf8");
  const leaderboard = await readFile(path.join(root, "src", "utils", "leaderboard-generator.ts"), "utf8");

  assert.equal((registry.match(/minicode: \{/g) ?? []).length, 1);
  assert.equal((agentsJson.match(/"minicode":/g) ?? []).length, 1);
  assert.match(format, /case 'minicode': return 'minicode';/);
  assert.equal((versionDetector.match(/case 'minicode':/g) ?? []).length, 2);
  assert.match(leaderboard, /case 'minicode': return 'minicode';/);
});
