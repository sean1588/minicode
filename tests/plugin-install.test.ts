import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  runPluginInstall,
  runPluginUninstall,
  type ClaudeResult,
  type RunClaude,
} from "../src/cli/plugin-install.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/**
 * Build a minimal npm-package layout that `runPluginInstall` will read from:
 *   <root>/package.json        ← version source
 *   <root>/plugin/CLAUDE.md
 *   <root>/plugin/.mcp.json
 *   <root>/plugin/.claude-plugin/plugin.json
 *   <root>/plugin/skills/example/SKILL.md
 *
 * Mirrors the real `plugin/` directory shipped in the npm package.
 */
async function createFakePackage(opts: { version: string }): Promise<{
  pkgRoot: string;
  pluginSourceDir: string;
}> {
  const pkgRoot = await mkdtemp(path.join(os.tmpdir(), "minicode-plugin-pkg-"));
  tempDirs.push(pkgRoot);
  await writeFile(
    path.join(pkgRoot, "package.json"),
    JSON.stringify({ name: "@sean.holung/minicode", version: opts.version }),
  );
  const pluginSourceDir = path.join(pkgRoot, "plugin");
  await mkdir(path.join(pluginSourceDir, ".claude-plugin"), { recursive: true });
  await mkdir(path.join(pluginSourceDir, "skills", "example"), {
    recursive: true,
  });
  await writeFile(
    path.join(pluginSourceDir, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "minicode", version: opts.version }),
  );
  await writeFile(path.join(pluginSourceDir, "CLAUDE.md"), "# Hi\n");
  await writeFile(
    path.join(pluginSourceDir, ".mcp.json"),
    JSON.stringify({ mcpServers: { minicode: { type: "http", url: "x" } } }),
  );
  await writeFile(
    path.join(pluginSourceDir, "skills", "example", "SKILL.md"),
    "---\ndescription: x\n---\n",
  );
  return { pkgRoot, pluginSourceDir };
}

async function createTempHome(): Promise<string> {
  const userHome = await mkdtemp(path.join(os.tmpdir(), "minicode-plugin-home-"));
  tempDirs.push(userHome);
  return userHome;
}

function makeRunClaude(
  responses: Record<string, ClaudeResult>,
  log: string[],
): RunClaude {
  return async (args) => {
    const key = args.join(" ");
    log.push(key);
    const exact = responses[key];
    if (exact) return exact;
    // Permit partial-key lookup for marketplace add (arg has variable path)
    for (const [prefix, response] of Object.entries(responses)) {
      if (key.startsWith(prefix)) return response;
    }
    return { code: 0, stdout: "", stderr: "" };
  };
}

test("runPluginInstall materialises ~/.minicode/, writes settings.json, calls claude CLI", async () => {
  const { pluginSourceDir } = await createFakePackage({ version: "9.9.9" });
  const userHome = await createTempHome();
  const log: string[] = [];
  const result = await runPluginInstall({
    userHome,
    pluginSourceDir,
    runClaude: makeRunClaude({}, log),
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.activation.ok, true);

  const home = path.join(userHome, ".minicode");
  const generated = JSON.parse(
    await readFile(path.join(home, ".claude-plugin", "plugin.json"), "utf-8"),
  );
  assert.equal(generated.version, "9.9.9");

  const marketplace = JSON.parse(
    await readFile(path.join(home, ".claude-plugin", "marketplace.json"), "utf-8"),
  );
  assert.equal(marketplace.name, "minicode-local");
  assert.equal(marketplace.plugins[0].source, "./");
  assert.equal(marketplace.plugins[0].version, "9.9.9");

  // Content files were copied verbatim.
  assert.match(await readFile(path.join(home, "CLAUDE.md"), "utf-8"), /^# Hi/);
  assert.match(
    await readFile(path.join(home, "skills", "example", "SKILL.md"), "utf-8"),
    /description: x/,
  );

  // Global settings written.
  const settings = JSON.parse(
    await readFile(path.join(userHome, ".claude", "settings.json"), "utf-8"),
  );
  assert.equal(settings.enabledPlugins["minicode@minicode-local"], true);
  assert.deepEqual(settings.extraKnownMarketplaces["minicode-local"], {
    source: { source: "directory", path: home },
  });

  // Load-bearing assertions only: the install must happen, and the
  // marketplace must be registered first. Don't pin the exact order of the
  // probe or the precise phrasing of each step — that brittleness would
  // misclassify benign refactors as regressions.
  assert.ok(log.includes(`plugin marketplace add ${home}`));
  assert.ok(log.includes("plugin install minicode@minicode-local"));
  assert.ok(
    log.indexOf(`plugin marketplace add ${home}`) <
      log.indexOf("plugin install minicode@minicode-local"),
    "marketplace add must come before plugin install",
  );
});

test("runPluginInstall surfaces command-failed when plugin install itself fails", async () => {
  // The load-bearing fix this PR ships — pluginInstall failure is no longer
  // misclassified as success by the old `looksAlreadyKnown` heuristic on
  // strings like "version already in use".
  const { pluginSourceDir } = await createFakePackage({ version: "1.0.0" });
  const userHome = await createTempHome();
  const log: string[] = [];
  const runClaude = makeRunClaude(
    {
      "plugin install": {
        code: 1,
        stdout: "",
        stderr: "version already in use",
      },
    },
    log,
  );

  const result = await runPluginInstall({
    userHome,
    pluginSourceDir,
    runClaude,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.activation.ok, false);
  if (result.activation.ok) return;
  assert.equal(result.activation.reason, "command-failed");
  assert.match(
    result.activation.detail ?? "",
    /plugin install failed.*version already in use/,
  );

  // Settings must NOT have been written — activation failed.
  try {
    await readFile(path.join(userHome, ".claude", "settings.json"), "utf-8");
    assert.fail("settings.json should not exist when activation failed");
  } catch (err) {
    assert.match((err as NodeJS.ErrnoException).code ?? "", /ENOENT/);
  }
});

test("runPluginInstall preserves unrelated settings keys + foreign plugin entries", async () => {
  const { pluginSourceDir } = await createFakePackage({ version: "1.0.0" });
  const userHome = await createTempHome();
  const settingsPath = path.join(userHome, ".claude", "settings.json");
  // Seed pre-existing settings — a model setting, a hook, AND someone else's
  // plugin and marketplace. None of these should be touched.
  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeFile(
    settingsPath,
    JSON.stringify({
      model: "claude-sonnet-4-6",
      hooks: { sessionStart: ["./scripts/x.sh"] },
      enabledPlugins: { "other-plugin@other-mp": true },
      extraKnownMarketplaces: {
        "other-mp": { source: { source: "directory", path: "/somewhere" } },
      },
    }),
  );

  const log: string[] = [];
  await runPluginInstall({
    userHome,
    pluginSourceDir,
    runClaude: makeRunClaude({}, log),
  });

  const after = JSON.parse(await readFile(settingsPath, "utf-8"));
  // Foreign keys survived.
  assert.equal(after.model, "claude-sonnet-4-6");
  assert.deepEqual(after.hooks, { sessionStart: ["./scripts/x.sh"] });
  // Foreign plugin + marketplace coexist with the minicode ones.
  assert.equal(after.enabledPlugins["other-plugin@other-mp"], true);
  assert.equal(after.enabledPlugins["minicode@minicode-local"], true);
  assert.ok(after.extraKnownMarketplaces["other-mp"]);
  assert.ok(after.extraKnownMarketplaces["minicode-local"]);

  // Uninstall should also leave the foreign entries intact.
  await runPluginUninstall({
    userHome,
    runClaude: makeRunClaude({}, log),
  });
  const afterUninstall = JSON.parse(await readFile(settingsPath, "utf-8"));
  assert.equal(afterUninstall.model, "claude-sonnet-4-6");
  assert.equal(afterUninstall.enabledPlugins["other-plugin@other-mp"], true);
  assert.equal(
    afterUninstall.enabledPlugins["minicode@minicode-local"],
    undefined,
  );
  assert.ok(afterUninstall.extraKnownMarketplaces["other-mp"]);
  assert.equal(
    afterUninstall.extraKnownMarketplaces["minicode-local"],
    undefined,
  );
});

test("runPluginInstall refuses to overwrite a malformed settings.json", async () => {
  // Silently treating parse errors as "empty settings" would destroy
  // whatever state we couldn't parse. Distinguish file-missing (return {})
  // from file-malformed (throw with a clear message).
  const { pluginSourceDir } = await createFakePackage({ version: "1.0.0" });
  const userHome = await createTempHome();
  const settingsPath = path.join(userHome, ".claude", "settings.json");
  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, "{not valid json,,,");

  await assert.rejects(
    runPluginInstall({
      userHome,
      pluginSourceDir,
      runClaude: makeRunClaude({}, []),
    }),
    /Refusing to overwrite malformed/,
  );

  // The malformed file must be left exactly as we found it.
  assert.equal(
    await readFile(settingsPath, "utf-8"),
    "{not valid json,,,",
  );
});

test("runPluginUninstall with scope=repo does NOT call global `claude plugin uninstall`", async () => {
  // Per-repo uninstall should remove the repo-local toggle only — running
  // the global CLI uninstall would yank the plugin out of every other
  // repo that enabled it.
  const { pluginSourceDir } = await createFakePackage({ version: "1.0.0" });
  const userHome = await createTempHome();
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "minicode-plugin-repo-"));
  tempDirs.push(repoRoot);
  execFileSync("git", ["init"], { cwd: repoRoot, stdio: "ignore" });

  const installLog: string[] = [];
  await runPluginInstall({
    userHome,
    pluginSourceDir,
    scope: "repo",
    repoRoot,
    runClaude: makeRunClaude({}, installLog),
  });
  const uninstallLog: string[] = [];
  const result = await runPluginUninstall({
    userHome,
    scope: "repo",
    repoRoot,
    runClaude: makeRunClaude({}, uninstallLog),
  });
  assert.equal(result.ok, true);
  // No `claude` invocations during the uninstall — we just strip the
  // repo-local setting and return.
  assert.deepEqual(uninstallLog, []);

  // Repo settings cleared.
  const repoSettings = JSON.parse(
    await readFile(
      path.join(repoRoot, ".claude", "settings.local.json"),
      "utf-8",
    ),
  );
  assert.equal(repoSettings.enabledPlugins["minicode@minicode-local"], undefined);
});

test("runPluginInstall with scope=repo writes to <repo>/.claude/settings.local.json", async () => {
  const { pluginSourceDir } = await createFakePackage({ version: "1.0.0" });
  const userHome = await createTempHome();
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "minicode-plugin-repo-"));
  tempDirs.push(repoRoot);
  execFileSync("git", ["init"], { cwd: repoRoot, stdio: "ignore" });

  const log: string[] = [];
  const result = await runPluginInstall({
    userHome,
    pluginSourceDir,
    scope: "repo",
    repoRoot,
    runClaude: makeRunClaude({}, log),
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(
    result.settingsPath,
    path.join(repoRoot, ".claude", "settings.local.json"),
  );
  const repoSettings = JSON.parse(
    await readFile(result.settingsPath, "utf-8"),
  );
  assert.equal(repoSettings.enabledPlugins["minicode@minicode-local"], true);

  // Global settings file should NOT have been touched.
  try {
    await readFile(path.join(userHome, ".claude", "settings.json"), "utf-8");
    assert.fail("global settings.json should not exist when scope=repo");
  } catch (err) {
    assert.match((err as NodeJS.ErrnoException).code ?? "", /ENOENT/);
  }
});

test("runPluginInstall reports claude-not-found when CLI is missing", async () => {
  const { pluginSourceDir } = await createFakePackage({ version: "1.0.0" });
  const userHome = await createTempHome();
  const log: string[] = [];
  // Probe returns nonzero → claude not on PATH.
  const runClaude: RunClaude = async (args) => {
    log.push(args.join(" "));
    return { code: 127, stdout: "", stderr: "not found" };
  };

  const result = await runPluginInstall({
    userHome,
    pluginSourceDir,
    runClaude,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.activation.ok, false);
  if (result.activation.ok) return;
  assert.equal(result.activation.reason, "claude-not-found");
  // We stop after the probe; no marketplace add / install attempts.
  assert.deepEqual(log, ["--version"]);

  // Settings + materialization still happened so user can manually activate.
  const home = path.join(userHome, ".minicode");
  await readFile(path.join(home, ".claude-plugin", "plugin.json"), "utf-8");
});

test("runPluginInstall re-runs `marketplace update` when marketplace is already known", async () => {
  const { pluginSourceDir } = await createFakePackage({ version: "1.0.0" });
  const userHome = await createTempHome();
  const log: string[] = [];
  const runClaude = makeRunClaude(
    {
      "plugin marketplace add": {
        code: 1,
        stdout: "",
        stderr: "marketplace already exists",
      },
    },
    log,
  );

  const result = await runPluginInstall({
    userHome,
    pluginSourceDir,
    runClaude,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.activation.ok, true);
  // marketplace add fails as "already known" → falls through to marketplace update.
  assert.ok(log.includes("plugin marketplace update minicode-local"));
  assert.ok(log.includes("plugin install minicode@minicode-local"));
});

test("runPluginInstall surfaces command-failed when marketplace add genuinely errors", async () => {
  const { pluginSourceDir } = await createFakePackage({ version: "1.0.0" });
  const userHome = await createTempHome();
  const log: string[] = [];
  const runClaude = makeRunClaude(
    {
      "plugin marketplace add": {
        code: 1,
        stdout: "",
        stderr: "boom: network unreachable",
      },
    },
    log,
  );

  const result = await runPluginInstall({
    userHome,
    pluginSourceDir,
    runClaude,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.activation.ok, false);
  if (result.activation.ok) return;
  assert.equal(result.activation.reason, "command-failed");
  assert.match(result.activation.detail ?? "", /marketplace add failed.*boom/);
});

test("runPluginUninstall removes settings entries and calls plugin uninstall", async () => {
  const { pluginSourceDir } = await createFakePackage({ version: "1.0.0" });
  const userHome = await createTempHome();
  const log: string[] = [];
  // Install first to populate state.
  await runPluginInstall({
    userHome,
    pluginSourceDir,
    runClaude: makeRunClaude({}, log),
  });
  log.length = 0;

  const uninstall = await runPluginUninstall({
    userHome,
    runClaude: makeRunClaude({}, log),
  });
  assert.equal(uninstall.ok, true);
  if (!uninstall.ok) return;
  assert.equal(uninstall.activation.ok, true);

  const settings = JSON.parse(
    await readFile(path.join(userHome, ".claude", "settings.json"), "utf-8"),
  );
  assert.equal(settings.enabledPlugins["minicode@minicode-local"], undefined);
  assert.equal(
    settings.extraKnownMarketplaces["minicode-local"],
    undefined,
  );
  assert.deepEqual(log, ["--version", "plugin uninstall minicode@minicode-local"]);
});

test("runPluginInstall returns error when plugin source dir is missing manifest", async () => {
  const userHome = await createTempHome();
  // Point at a nonexistent dir.
  const result = await runPluginInstall({
    userHome,
    pluginSourceDir: "/tmp/does-not-exist-minicode-test",
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /Plugin source not found/);
});
