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

/**
 * Outcome of an `activatePlugin` / `deactivatePlugin` call. Named generically
 * (`ok`) so the deactivate path doesn't have to read "activated: true" to
 * mean "uninstalled". `commands` carries the fallback shell sequence the
 * user can run manually when `ok` is false.
 */
export type ActivateResult =
  | { ok: true; ranCommands: string[] }
  | {
      ok: false;
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
  // The plugin source directory was already validated as present (plugin.json
  // exists) before we get here, so a missing/unparseable package.json is
  // genuinely anomalous — fail loudly rather than baking a wrong version
  // (e.g. "0.0.0") into the generated manifest.
  throw new Error(
    `Could not read a valid version from package.json near ${pluginSourceDir}. ` +
      "Checked: " +
      candidates.join(", "),
  );
}

/**
 * Read a JSON file, returning an empty object when the file doesn't exist
 * (initial-install path). A malformed file throws — silently overwriting a
 * user's corrupt `settings.json` would destroy any state we couldn't parse.
 */
async function readJsonOrEmpty(filePath: string): Promise<Record<string, unknown>> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw err;
  }
  try {
    return JSON.parse(content) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `Refusing to overwrite malformed ${filePath} — fix or remove the file first. ` +
        `Parse error: ${(err as Error).message}`,
    );
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

/**
 * Decide whether a non-zero `claude` exit is benign because the requested
 * transition is already true — "marketplace already added" on add,
 * "plugin already not installed" / "not installed" on uninstall.
 *
 * Anchored to the explicit "already (state)" phrasing OR a bare "not
 * installed" for the uninstall direction, NOT bare tokens like
 * "already"/"exists"/"known" — those false-positive on `"unknown error"`,
 * `"path does not exist"`, `"version already in use"`. Misclassifying those
 * would silently mask a real failure behind a confusing retry.
 *
 * NOT used on `plugin install` — that's natively idempotent, so any
 * non-zero exit there is treated as a genuine failure.
 */
function isAlreadyInDesiredState(r: ClaudeResult): boolean {
  const text = `${r.stdout} ${r.stderr}`;
  return (
    /\balready\s+(exists|added|known|registered|installed)\b/i.test(text) ||
    /\bnot\s+installed\b/i.test(text)
  );
}

/**
 * Verify `claude` is on PATH. Returns the same error shape both activate and
 * deactivate use, so callers can early-return without re-deriving the
 * fallback-commands list themselves.
 */
async function ensureClaude(opts: {
  runClaude: RunClaude;
  fallback: string[];
}): Promise<{ ok: true } | (ActivateResult & { ok: false })> {
  const probe = await opts.runClaude(["--version"]);
  if (probe.code !== 0) {
    return {
      ok: false,
      reason: "claude-not-found",
      commands: opts.fallback,
    };
  }
  return { ok: true };
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

  const precheck = await ensureClaude({ runClaude: opts.runClaude, fallback });
  if (!precheck.ok) return precheck;

  const addArgs = ["plugin", "marketplace", "add", opts.home];
  const add = await opts.runClaude(addArgs);
  if (add.code === 0) {
    record(addArgs);
  } else if (isAlreadyInDesiredState(add)) {
    const updateArgs = ["plugin", "marketplace", "update", MARKETPLACE_NAME];
    const update = await opts.runClaude(updateArgs);
    if (update.code !== 0) {
      return {
        ok: false,
        reason: "command-failed",
        commands: fallback,
        detail: `marketplace update failed: ${(update.stderr || update.stdout).trim()}`,
      };
    }
    record(updateArgs);
  } else {
    return {
      ok: false,
      reason: "command-failed",
      commands: fallback,
      detail: `marketplace add failed: ${(add.stderr || add.stdout).trim()}`,
    };
  }

  const installArgs = ["plugin", "install", PLUGIN_ID];
  const install = await opts.runClaude(installArgs);
  // `claude plugin install` is natively idempotent; treat any non-zero exit
  // as a genuine failure rather than guessing at "already installed" from
  // stderr text. Anchored, narrow string-matching here would still be
  // load-bearing for a UX nicety we don't need.
  if (install.code !== 0) {
    return {
      ok: false,
      reason: "command-failed",
      commands: fallback,
      detail: `plugin install failed: ${(install.stderr || install.stdout).trim()}`,
    };
  }
  record(installArgs);

  return { ok: true, ranCommands };
}

async function deactivatePlugin(opts: {
  runClaude: RunClaude;
}): Promise<ActivateResult> {
  const fallback = [`claude plugin uninstall ${PLUGIN_ID}`];

  const precheck = await ensureClaude({ runClaude: opts.runClaude, fallback });
  if (!precheck.ok) return precheck;

  const uninstallArgs = ["plugin", "uninstall", PLUGIN_ID];
  const uninstall = await opts.runClaude(uninstallArgs);
  // Treat "already uninstalled" (the marketplace-already-known shape applied
  // in reverse) as success, but a non-zero exit without that anchor is a
  // genuine failure.
  if (uninstall.code !== 0 && !isAlreadyInDesiredState(uninstall)) {
    return {
      ok: false,
      reason: "command-failed",
      commands: fallback,
      detail: `plugin uninstall failed: ${(uninstall.stderr || uninstall.stdout).trim()}`,
    };
  }
  return { ok: true, ranCommands: [`claude ${uninstallArgs.join(" ")}`] };
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

/**
 * Print an install / uninstall outcome. Same shape for both — the only thing
 * that changes is the verb ("activated"/"deactivated") and the optional
 * footer.
 */
function logReport(opts: {
  header: string;
  verb: "activated" | "deactivated";
  home?: string;
  settingsPath: string;
  activation: ActivateResult;
  footer?: string;
}): void {
  console.log(opts.header);
  if (opts.home) {
    console.log(`  plugin home:   ${opts.home}`);
  }
  console.log(`  settings file: ${opts.settingsPath}`);
  console.log("");
  if (opts.activation.ok) {
    console.log(`✓ ${opts.verb} via claude CLI:`);
    for (const cmd of opts.activation.ranCommands) {
      console.log(`    ${cmd}`);
    }
  } else {
    const reason =
      opts.activation.reason === "claude-not-found"
        ? "the `claude` CLI is not on PATH"
        : "`claude` CLI reported an error";
    const action = opts.verb === "activated" ? "activation" : "deactivation";
    console.log(`✗ ${action} skipped — ${reason}.`);
    if (opts.activation.reason === "command-failed" && opts.activation.detail) {
      console.log(`    ${opts.activation.detail}`);
    }
    console.log(`  Run manually to ${opts.verb.replace(/d$/, "")}:`);
    for (const cmd of opts.activation.commands) {
      console.log(`    ${cmd}`);
    }
  }
  if (opts.footer) {
    console.log("");
    console.log(opts.footer);
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

  // Activate FIRST, settings.json SECOND. If activation fails (claude not on
  // PATH or CLI error), we leave settings.json untouched — the exact
  // "claims-enabled-but-not-registered" silent-no-op state this PR exists
  // to fix. Users see the manual commands in the report and can retry.
  const activation = await activatePlugin({ home, runClaude });
  const settingsPath = settingsPathFor(opts);
  if (activation.ok) {
    await writeSettings({ settingsPath, home, enable: true });
  }
  return { ok: true, home, settingsPath, activation };
}

export async function runPluginUninstall(
  opts: PluginInstallOptions = {},
): Promise<PluginInstallResult> {
  const userHome = opts.userHome ?? os.homedir();
  const home = minicodeHome(userHome);
  const runClaude = opts.runClaude ?? defaultRunClaude;
  const scope = opts.scope ?? "global";

  const settingsPath = settingsPathFor(opts);
  await writeSettings({ settingsPath, home, enable: false });

  // Repo-scoped uninstall: only strip the repo-local toggle. The marketplace
  // registration is global — calling `claude plugin uninstall` here would
  // yank the plugin out of every other repo that enabled it.
  if (scope === "repo") {
    return {
      ok: true,
      home,
      settingsPath,
      activation: {
        ok: true,
        ranCommands: ["(skipped — repo-scoped uninstall leaves global registration intact)"],
      },
    };
  }

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
    logReport({
      header: "minicode plugin uninstalled",
      verb: "deactivated",
      settingsPath: result.settingsPath,
      activation: result.activation,
    });
  } else {
    logReport({
      header: "minicode plugin installed",
      verb: "activated",
      home: result.home,
      settingsPath: result.settingsPath,
      activation: result.activation,
      footer:
        "Start minicode serve in another terminal for the MCP server to be reachable:\n    minicode serve",
    });
  }

  if (!result.activation.ok) {
    process.exitCode = 1;
  }
}
