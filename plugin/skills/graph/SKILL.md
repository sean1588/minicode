---
description: Get a high-level overview of the project structure from the code map
---

Use the minicode MCP server to provide a project overview:

1. Read the `minicode://code-map` resource to get the ranked project skeleton.
2. Summarize the key architectural layers and their main symbols.
3. Highlight entry points, heavily-referenced symbols, and exported APIs.

If the user provided specific arguments ("$ARGUMENTS"), focus the overview on that area of the codebase. Use `search_code_map` to find relevant symbols and `get_dependencies` to trace their connections.

Note: If minicode serve is running, the web UI at localhost shows an interactive visual dependency graph of this same data.
