---
description: Explore a symbol and its neighborhood — dependencies, references, and connection paths
---

The user wants to focus on a specific symbol: "$ARGUMENTS"

Use the minicode MCP server tools to build a complete picture of this symbol:

1. Use `read_symbol` to get the full source, signature, and metadata.
2. Use `get_dependencies` (depth=2) to see what it depends on.
3. Use `find_references` to see what calls or uses it.
4. If the symbol connects to other important symbols, use `find_path` to show how they relate.

Present a clear summary of:
- What the symbol does
- Its key dependencies (what it calls/uses)
- Its key references (what calls/uses it)
- Its role in the broader architecture

Note: If minicode serve is running with the web UI, the dependency graph at localhost will update in real time as you explore.
