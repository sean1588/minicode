#!/usr/bin/env node
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

const outDir = "dist/src/web";

// Clean and recreate output directory
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// Bundle TS → JS
await build({
  entryPoints: ["src/web/app.ts"],
  bundle: true,
  outfile: path.join(outDir, "app.js"),
  format: "esm",
  target: "es2020",
  platform: "browser",
  external: [],
  minify: false,
  sourcemap: false,
});

// Copy static assets (HTML, CSS, favicon)
cpSync("src/web/index.html", path.join(outDir, "index.html"));
cpSync("src/web/style.css", path.join(outDir, "style.css"));
cpSync("src/web/favicon.svg", path.join(outDir, "favicon.svg"));
cpSync("src/web/favicon.ico", path.join(outDir, "favicon.ico"));

console.log("Web build complete → dist/src/web/");
