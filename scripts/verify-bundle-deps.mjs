#!/usr/bin/env node
/**
 * Verifies every external `import` in the published artifact resolves
 * to a package the root `package.json` declares — either as a direct
 * dependency or via `bundleDependencies`.
 *
 * Catches regressions where a workspace package (e.g. agent-sdk)
 * adds a new runtime dep that isn't propagated to the root, leaving
 * the published tarball unable to resolve it (the class of bug
 * fixed by adding `ajv` to root deps after PR #172).
 *
 * Run as a CI step after `npm run build`.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SCAN_ROOTS = ["dist/src", "dist/scripts"];

const NODE_BUILTINS = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console",
  "constants", "crypto", "dgram", "diagnostics_channel", "dns", "domain",
  "events", "fs", "http", "http2", "https", "inspector", "module", "net",
  "os", "path", "perf_hooks", "process", "punycode", "querystring",
  "readline", "repl", "stream", "string_decoder", "sys", "timers", "tls",
  "trace_events", "tty", "url", "util", "v8", "vm", "wasi", "worker_threads",
  "zlib",
]);

function isBuiltin(spec) {
  if (spec.startsWith("node:")) return true;
  const head = spec.split("/")[0];
  return NODE_BUILTINS.has(head);
}

function isRelative(spec) {
  return spec.startsWith(".") || spec.startsWith("/");
}

/**
 * Map an import specifier to its package name.
 *   "react" → "react"
 *   "react/jsx-runtime" → "react"
 *   "@anthropic-ai/sdk" → "@anthropic-ai/sdk"
 *   "@minicode/agent-sdk/dist/foo.js" → "@minicode/agent-sdk"
 */
function packageNameOf(spec) {
  if (spec.startsWith("@")) {
    const parts = spec.split("/");
    return parts.slice(0, 2).join("/");
  }
  return spec.split("/")[0];
}

async function* walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile() && /\.(m?js|cjs)$/.test(entry.name)) {
      yield full;
    }
  }
}

const STATIC_IMPORT_RE =
  /(?:^|[\s;{}])(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const REQUIRE_RE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

async function specifiersIn(file) {
  const src = await readFile(file, "utf8");
  const found = new Set();
  for (const re of [STATIC_IMPORT_RE, DYNAMIC_IMPORT_RE, REQUIRE_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      found.add(m[1]);
    }
  }
  return found;
}

async function loadAllowedPackages() {
  const pkgRaw = await readFile(path.join(ROOT, "package.json"), "utf8");
  const pkg = JSON.parse(pkgRaw);
  const allowed = new Set();
  for (const name of Object.keys(pkg.dependencies ?? {})) allowed.add(name);
  for (const name of Object.keys(pkg.optionalDependencies ?? {})) allowed.add(name);
  for (const name of pkg.bundleDependencies ?? []) allowed.add(name);

  // Workspace packages map back to themselves and aren't installed from
  // npm, but consumers of the published tarball get them via bundle
  // inclusion. They must be in `bundleDependencies` to ship.
  const workspaceRoots = pkg.workspaces ?? [];
  for (const ws of workspaceRoots) {
    const expanded = ws.replace(/\/\*$/, "");
    try {
      const dirs = await readdir(path.join(ROOT, expanded));
      for (const d of dirs) {
        try {
          const wsPkg = JSON.parse(
            await readFile(
              path.join(ROOT, expanded, d, "package.json"),
              "utf8",
            ),
          );
          if (wsPkg.name) allowed.add(wsPkg.name);
        } catch {
          // skip
        }
      }
    } catch {
      // skip
    }
  }
  return { allowed, bundle: new Set(pkg.bundleDependencies ?? []) };
}

async function main() {
  const { allowed } = await loadAllowedPackages();

  const missing = new Map(); // pkgName → Set<file>
  for (const root of SCAN_ROOTS) {
    const abs = path.join(ROOT, root);
    try {
      await stat(abs);
    } catch {
      continue;
    }
    for await (const file of walk(abs)) {
      const specs = await specifiersIn(file);
      for (const spec of specs) {
        if (isRelative(spec) || isBuiltin(spec)) continue;
        const pkg = packageNameOf(spec);
        if (!allowed.has(pkg)) {
          if (!missing.has(pkg)) missing.set(pkg, new Set());
          missing.get(pkg).add(path.relative(ROOT, file));
        }
      }
    }
  }

  // Also scan workspace packages' compiled output, since they're bundled
  // into the published tarball and their imports must resolve too.
  const wsDistRoots = [
    "packages/agent-sdk/dist/src",
    "packages/minicode-plugin-python/dist/src",
  ];
  for (const root of wsDistRoots) {
    const abs = path.join(ROOT, root);
    try {
      await stat(abs);
    } catch {
      continue;
    }
    for await (const file of walk(abs)) {
      const specs = await specifiersIn(file);
      for (const spec of specs) {
        if (isRelative(spec) || isBuiltin(spec)) continue;
        const pkg = packageNameOf(spec);
        if (!allowed.has(pkg)) {
          if (!missing.has(pkg)) missing.set(pkg, new Set());
          missing.get(pkg).add(path.relative(ROOT, file));
        }
      }
    }
  }

  if (missing.size === 0) {
    console.log(
      "OK — every external import in dist/ + workspace dist/ is covered by root dependencies or bundleDependencies.",
    );
    return;
  }

  console.error(
    `\nFAIL — ${missing.size} package(s) imported but not declared in root package.json:\n`,
  );
  for (const [pkg, files] of missing) {
    console.error(`  ${pkg}`);
    for (const file of [...files].slice(0, 3)) {
      console.error(`    used in: ${file}`);
    }
    if (files.size > 3) console.error(`    ...and ${files.size - 3} more file(s)`);
  }
  console.error(
    "\nFix by adding the package to `dependencies` and (if it should ship inside the published tarball) `bundleDependencies` in the root package.json.",
  );
  process.exit(1);
}

main().catch((err) => {
  console.error("verify-bundle-deps crashed:", err);
  process.exit(2);
});
