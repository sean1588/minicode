/**
 * Install the minicode Claude Code plugin globally.
 *
 * Creates a symlink from ~/.claude/plugins/minicode → the plugin directory
 * shipped alongside the minicode package.
 */
import { mkdir, symlink, readlink, unlink, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the plugin source directory.
 * In dev (tsx): __dirname = src/cli → go up to project root, then plugin/
 * In prod (dist): __dirname = dist/src/cli → go up to project root, then plugin/
 */
function getPluginSourceDir(): string {
  if (__dirname.includes(`${path.sep}dist${path.sep}`)) {
    return path.resolve(__dirname, "../../../plugin");
  }
  return path.resolve(__dirname, "../../plugin");
}

export async function installPlugin(): Promise<void> {
  const pluginsDir = path.join(os.homedir(), ".claude", "plugins");
  const targetDir = path.join(pluginsDir, "minicode");
  const sourceDir = getPluginSourceDir();

  // Verify the plugin source exists
  try {
    await stat(path.join(sourceDir, ".claude-plugin", "plugin.json"));
  } catch {
    console.error(`Error: plugin source not found at ${sourceDir}`);
    console.error("Make sure you are running from a minicode installation.");
    process.exit(1);
  }

  // Create ~/.claude/plugins/ if it doesn't exist
  await mkdir(pluginsDir, { recursive: true });

  // Check if target already exists
  try {
    const existing = await readlink(targetDir);
    if (existing === sourceDir) {
      console.log(`Plugin already installed at ${targetDir}`);
      console.log(`  → ${sourceDir}`);
      return;
    }
    // Different target — remove and re-link
    await unlink(targetDir);
  } catch {
    // Check if it's a directory (not a symlink) that exists
    try {
      const stats = await stat(targetDir);
      if (stats.isDirectory()) {
        console.error(`Error: ${targetDir} exists and is not a symlink.`);
        console.error("Remove it manually if you want to reinstall.");
        process.exit(1);
      }
    } catch {
      // Doesn't exist — good
    }
  }

  await symlink(sourceDir, targetDir, "dir");

  console.log("minicode plugin installed for Claude Code");
  console.log(`  ${targetDir} → ${sourceDir}`);
  console.log("\nThe plugin will load automatically in Claude Code sessions.");
  console.log("Make sure minicode serve is running for the MCP tools to work:");
  console.log("  minicode serve");
}
