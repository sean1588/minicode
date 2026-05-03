import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { createMcpTools } from "../src/mcp/client-registry.js";

const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "mcp-stdio-fixture.mjs",
);

test("createMcpTools roundtrips end-to-end against a stdio MCP server", async () => {
  const bundle = await createMcpTools({
    servers: [
      {
        name: "math",
        transport: "stdio",
        command: process.execPath,
        args: [FIXTURE_PATH],
      },
    ],
  });

  try {
    const names = bundle.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["math__add", "math__echo"]);

    const addTool = bundle.tools.find((t) => t.name === "math__add");
    assert.ok(addTool, "expected math__add to be present");
    const addOut = await addTool.execute({ a: 2, b: 40 });
    assert.equal(addOut, "42");

    const echoTool = bundle.tools.find((t) => t.name === "math__echo");
    assert.ok(echoTool, "expected math__echo to be present");
    const echoOut = await echoTool.execute({ message: "hi mom" });
    assert.equal(echoOut, "hi mom");
  } finally {
    await bundle.close();
  }
});

test("createMcpTools merges tools from multiple stdio servers", async () => {
  const bundle = await createMcpTools({
    servers: [
      {
        name: "alpha",
        transport: "stdio",
        command: process.execPath,
        args: [FIXTURE_PATH],
      },
      {
        name: "beta",
        transport: "stdio",
        command: process.execPath,
        args: [FIXTURE_PATH],
      },
    ],
  });

  try {
    const names = bundle.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "alpha__add",
      "alpha__echo",
      "beta__add",
      "beta__echo",
    ]);
  } finally {
    await bundle.close();
  }
});
