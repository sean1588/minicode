/**
 * Install / uninstall the minicode Claude Code plugin.
 *
 * Materialises a stable plugin root at `~/.minicode/` (the home-relative copy
 * of the npm-shipped `plugin/` directory) and activates it via the `claude`
 * CLI. The home-relative copy decouples Claude Code from the npm install path
 * — which moves between Node version managers — and avoids the
 * `.claude-plugin/`-as-symlink trap claudepanion documents (Claude Code would
 * otherwise resolve the plugin root back to the framework checkout, breaking
 * "load anywhere" semantics).
 *
 * Two settings.json scopes:
 *   - global (`~/.claude/settings.json`) — the default, loads in every session
 *   - repo   (`<git root>/.claude/settings.local.json`) — opt-in via `--repo`
 *     for users who only want the plugin enabled in repos minicode indexes
 *
 * Marketplace name is `minicode-local` (not just `local`) to avoid collision
 * with other tools — notably claudepanion — that publish their own `local`
 * marketplace entry into `extraKnownMarketplaces`.
 */
import {
  copyFile,
  cp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MARKETPLACE_NAME = "minicode-local";
const PLUGIN_ID = `minicode@${MARKETPLACE_NAME}`;
const PLUGIN_DESCRIPTION =
  "Code intelligence tools powered by minicode's AST indexer — symbol navigation, dependency tracing, and live graph visualization.";

export interface PluginInstallOptions {
  scope?: "global" | "repo";
  /** Defaults to os.homedir(). Override for tests. */
  userHome?: string;
  /** Required when scope === "repo". The git-root path. */
  repoRoot?: string;
  /** Override the npm-shipped plugin source directory. For tests. */
  pluginSourceDir?: string;
  /** Spawn implementation for the `claude` CLI. Defaults to real spawn. */
  runClaude?: RunClaude;
}

export type PluginInstallResult =
  | {
      ok: true;
      home: string;
      settingsPath: string;
      activation: ActivateResult;
    }
  | { ok: false; error: string };

export type ClaudeResult = { code: number; stdout: string; stderr: string };

export type RunClaude = (args: string[]) => Promise<ClaudeResult>;

export type ActivateResult =
  | { activated: true; ranCommands: string[] }
  | {
      activated: false;
      reason: "claude-not-found" | "command-failed";
      commands: string[];
      detail?: string;
    };

const defaultRunClaude: RunClaude = (args) =>
  new Promise((resolve) => {
    const proc = spawn("claude", args, { shell: false });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    proc.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("error", (err) =>
      resolve({ code: 127, stdout, stderr: stderr || err.message }),
    );
    proc.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

/**
 * Resolve the npm-shipped plugin source directory.
 *
 * Dev (tsx):       __dirname = <repo>/src/cli            → ../../plugin
 * Prod (dist):     __dirname = <pkg>/dist/src/cli        → ../../../plugin
 */
function defaultPluginSourceDir(): string {
  if (__dirname.includes(`${path.sep}dist${path.sep}`)) {
    return path.resolve(__dirname, "../../../plugin");
  }
  return path.resolve(__dirname, "../../plugin");
}

function minicodeHome(userHome: string): string {
  return path.join(userHome, ".minicode");
}

function settingsPathFor(opts: PluginInstallOptions): string {
  const userHome = opts.userHome ?? os.homedir();
  if ((opts.scope ?? "global") === "global") {
    return path.join(userHome, ".claude", "settings.json");
  }
  if (!opts.repoRoot) {
    throw new Error("repo scope requires repoRoot");
  }
  return path.join(opts.repoRoot, ".claude", "settings.local.json");
}

async function readPackageVersion(pluginSourceDir: string): Promise<string> {
  // package.json is one directory above plugin/ in the npm package.
  const candidates = [
    path.resolve(pluginSourceDir, "..", "package.json"),
    path.resolve(pluginSourceDir, "package.json"),
  ];
  for (const candidate of candidates) {
    try {
      const content = await readFile(candidate, "utf-8");
      const parsed = JSON.parse(content) as { version?: string };
      if (typeof parsed.version === "string") {
        return parsed.version;
      }
    } catch {
      // try next
    }
  }
  return "0.0.0";
}

async function readJsonOrEmpty(filePath: string): Promise<Record<string, unknown>> {
  try {
    const content = await readFile(filePath, "utf-8");
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

/**
 * Materialise `~/.minicode/` from the shipped `plugin/` directory.
 *
 * `.claude-plugin/{plugin.json, marketplace.json}` is generated fresh on every
 * run so the version stays aligned with the npm package. CLAUDE.md, .mcp.json,
 * and skills/ are copied verbatim — re-running `plugin install` after a
 * minicode upgrade refreshes them.
 */
async function materializePluginHome(opts: {
  home: string;
  pluginSourceDir: string;
  version: string;
}): Promise<void> {
  await mkdir(opts.home, { recursive: true });

  // .claude-plugin/ — generated, not copied. A real directory (not a symlink)
  // so `source: "./"` in marketplace.json resolves to opts.home, not back to
  // the npm install location (see file-header doc comment).
  const claudePluginDir = path.join(opts.home, ".claude-plugin");
  await rm(claudePluginDir, { recursive: true, force: true });
  await mkdir(claudePluginDir, { recursive: true });
  await writeJson(path.join(claudePluginDir, "plugin.json"), {
    name: "minicode",
    description: PLUGIN_DESCRIPTION,
    version: opts.version,
    author: {
      name: "Sean Holung",
      url: "https://github.com/sean1588",
    },
    repository: "https://github.com/sean1588/minicode",
    license: "MIT",
    keywords: ["code-intelligence", "ast", "dependency-graph", "mcp", "symbols"],
  });
  await writeJson(path.join(claudePluginDir, "marketplace.json"), {
    name: MARKETPLACE_NAME,
    description: "Local marketplace for minicode",
    owner: { name: "minicode" },
    plugins: [
      {
        name: "minicode",
        description: PLUGIN_DESCRIPTION,
        version: opts.version,
        source: "./",
        author: { name: "Sean Holung", url: "https://github.com/sean1588" },
      },
    ],
  });

  // CLAUDE.md, .mcp.json — copy verbatim.
  for (const file of ["CLAUDE.md", ".mcp.json"]) {
    await copyFile(
      path.join(opts.pluginSourceDir, file),
      path.join(opts.home, file),
    );
  }

  // skills/ — recursive copy. Wipe first so removed skills are cleaned up.
  const skillsDest = path.join(opts.home, "skills");
  await rm(skillsDest, { recursive: true, force: true });
  await cp(path.join(opts.pluginSourceDir, "skills"), skillsDest, {
    recursive: true,
  });
}

function looksAlreadyKnown(r: ClaudeResult): boolean {
  return /already|exists|known/i.test(`${r.stdout} ${r.stderr}`);
}

/**
 * Activate the minicode plugin via the `claude` CLI.
 *
 * settings.json `extraKnownMarketplaces` + `enabledPlugins` alone do NOT
 * activate a directory-marketplace plugin in current Claude Code (the
 * registration in `~/.claude/plugins/installed_plugins.json` is the
 * load-bearing entry). The supported non-interactive path is `plugin
 * marketplace add` + `plugin install`. Marketplace re-registration uses
 * `marketplace update` (never `remove`+`add`, which uninstalls plugins).
 */
async function activatePlugin(opts: {
  home: string;
  runClaude: RunClaude;
}): Promise<ActivateResult> {
  const ranCommands: string[] = [];
  const record = (args: string[]) =>
    ranCommands.push(`claude ${args.join(" ")}`);

  const fallback = [
    `claude plugin marketplace add ${opts.home}`,
    `claude plugin install ${PLUGIN_ID}`,
  ];

  const probe = await opts.runClaude(["--version"]);
  if (probe.code !== 0) {
    return {
      activated: false,
      reason: "claude-not-found",
      commands: fallback,
    };
  }

  const addArgs = ["plugin", "marketplace", "add", opts.home];
  const add = await opts.runClaude(addArgs);
  if (add.code === 0) {
    record(addArgs);
  } else if (looksAlreadyKnown(add)) {
    const updateArgs = ["plugin", "marketplace", "update", MARKETPLACE_NAME];
    const update = await opts.runClaude(updateArgs);
    if (update.code !== 0) {
      return {
        activated: false,
        reason: "command-failed",
        commands: fallback,
        detail: `marketplace update failed: ${(update.stderr || update.stdout).trim()}`,
      };
    }
    record(updateArgs);
  } else {
    return {
      activated: false,
      reason: "command-failed",
      commands: fallback,
      detail: `marketplace add failed: ${(add.stderr || add.stdout).trim()}`,
    };
  }

  const installArgs = ["plugin", "install", PLUGIN_ID];
  const install = await opts.runClaude(installArgs);
  if (install.code !== 0 && !looksAlreadyKnown(install)) {
    return {
      activated: false,
      reason: "command-failed",
      commands: fallback,
      detail: `plugin install failed: ${(install.stderr || install.stdout).trim()}`,
    };
  }
  record(installArgs);

  return { activated: true, ranCommands };
}

async function deactivatePlugin(opts: {
  runClaude: RunClaude;
}): Promise<ActivateResult> {
  const fallback = [`claude plugin uninstall ${PLUGIN_ID}`];

  const probe = await opts.runClaude(["--version"]);
  if (probe.code !== 0) {
    return {
      activated: false,
      reason: "claude-not-found",
      commands: fallback,
    };
  }

  const uninstallArgs = ["plugin", "uninstall", PLUGIN_ID];
  const uninstall = await opts.runClaude(uninstallArgs);
  // Treat "not installed" as success.
  if (uninstall.code !== 0 && !looksAlreadyKnown(uninstall)) {
    return {
      activated: false,
      reason: "command-failed",
      commands: fallback,
      detail: `plugin uninstall failed: ${(uninstall.stderr || uninstall.stdout).trim()}`,
    };
  }
  return { activated: true, ranCommands: [`claude ${uninstallArgs.join(" ")}`] };
}

async function writeSettings(opts: {
  settingsPath: string;
  home: string;
  enable: boolean;
}): Promise<void> {
  const settings = await readJsonOrEmpty(opts.settingsPath);

  const enabledPlugins = (settings.enabledPlugins ?? {}) as Record<string, boolean>;
  if (opts.enable) {
    enabledPlugins[PLUGIN_ID] = true;
  } else {
    delete enabledPlugins[PLUGIN_ID];
  }
  settings.enabledPlugins = enabledPlugins;

  const marketplaces = (settings.extraKnownMarketplaces ?? {}) as Record<string, unknown>;
  if (opts.enable) {
    marketplaces[MARKETPLACE_NAME] = {
      source: { source: "directory", path: opts.home },
    };
  } else {
    delete marketplaces[MARKETPLACE_NAME];
  }
  settings.extraKnownMarketplaces = marketplaces;

  await writeJson(opts.settingsPath, settings);
}

function logInstallReport(report: {
  home: string;
  settingsPath: string;
  activation: ActivateResult;
}): void {
  console.log("minicode plugin installed");
  console.log(`  plugin home:   ${report.home}`);
  console.log(`  settings file: ${report.settingsPath}`);
  console.log("");
  if (report.activation.activated) {
    console.log("✓ activated via claude CLI:");
    for (const cmd of report.activation.ranCommands) {
      console.log(`    ${cmd}`);
    }
  } else {
    const reason =
      report.activation.reason === "claude-not-found"
        ? "the `claude` CLI is not on PATH"
        : "`claude` CLI reported an error";
    console.log(`✗ activation skipped — ${reason}.`);
    if (
      report.activation.reason === "command-failed" &&
      report.activation.detail
    ) {
      console.log(`    ${report.activation.detail}`);
    }
    console.log("  Run manually to activate:");
    for (const cmd of report.activation.commands) {
      console.log(`    ${cmd}`);
    }
  }
  console.log("");
  console.log("Start minicode serve in another terminal for the MCP server to be reachable:");
  console.log("    minicode serve");
}

function logUninstallReport(report: {
  settingsPath: string;
  activation: ActivateResult;
}): void {
  console.log("minicode plugin uninstalled");
  console.log(`  settings file: ${report.settingsPath}`);
  console.log("");
  if (report.activation.activated) {
    console.log("✓ deactivated via claude CLI:");
    for (const cmd of report.activation.ranCommands) {
      console.log(`    ${cmd}`);
    }
  } else {
    const reason =
      report.activation.reason === "claude-not-found"
        ? "the `claude` CLI is not on PATH"
        : "`claude` CLI reported an error";
    console.log(`✗ deactivation skipped — ${reason}.`);
    if (
      report.activation.reason === "command-failed" &&
      report.activation.detail
    ) {
      console.log(`    ${report.activation.detail}`);
    }
    console.log("  Run manually to deactivate:");
    for (const cmd of report.activation.commands) {
      console.log(`    ${cmd}`);
    }
  }
}

export async function runPluginInstall(
  opts: PluginInstallOptions = {},
): Promise<PluginInstallResult> {
  const userHome = opts.userHome ?? os.homedir();
  const home = minicodeHome(userHome);
  const pluginSourceDir = opts.pluginSourceDir ?? defaultPluginSourceDir();
  const runClaude = opts.runClaude ?? defaultRunClaude;

  try {
    await stat(path.join(pluginSourceDir, ".claude-plugin", "plugin.json"));
  } catch {
    return {
      ok: false,
      error: `Plugin source not found at ${pluginSourceDir}. Make sure you are running from a minicode installation.`,
    };
  }

  const version = await readPackageVersion(pluginSourceDir);

  await materializePluginHome({ home, pluginSourceDir, version });

  const settingsPath = settingsPathFor(opts);
  await writeSettings({ settingsPath, home, enable: true });

  const activation = await activatePlugin({ home, runClaude });
  return { ok: true, home, settingsPath, activation };
}

export async function runPluginUninstall(
  opts: PluginInstallOptions = {},
): Promise<PluginInstallResult> {
  const userHome = opts.userHome ?? os.homedir();
  const home = minicodeHome(userHome);
  const runClaude = opts.runClaude ?? defaultRunClaude;

  const settingsPath = settingsPathFor(opts);
  await writeSettings({ settingsPath, home, enable: false });

  const activation = await deactivatePlugin({ runClaude });
  return { ok: true, home, settingsPath, activation };
}

/** Public entrypoint called from src/index.ts. */
export async function installPlugin(opts: {
  uninstall?: boolean;
  scope?: "global" | "repo";
  repoRoot?: string;
}): Promise<void> {
  const installOpts: PluginInstallOptions = {
    scope: opts.scope ?? "global",
    ...(opts.repoRoot ? { repoRoot: opts.repoRoot } : {}),
  };

  const result = opts.uninstall
    ? await runPluginUninstall(installOpts)
    : await runPluginInstall(installOpts);

  if (!result.ok) {
    console.error(`Error: ${result.error}`);
    process.exit(1);
  }

  if (opts.uninstall) {
    logUninstallReport({
      settingsPath: result.settingsPath,
      activation: result.activation,
    });
  } else {
    logInstallReport({
      home: result.home,
      settingsPath: result.settingsPath,
      activation: result.activation,
    });
  }

  if (!result.activation.activated) {
    process.exitCode = 1;
  }
}
