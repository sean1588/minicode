---
description: Search for symbols in the codebase by name or pattern
---

The user is searching for: "$ARGUMENTS"

Use the minicode MCP server's `search_code_map` tool to find matching symbols. If the search returns results:

1. List the matching symbols with their kind, file location, and signature.
2. If there are only a few matches, use `read_symbol` on the most relevant ones to show their source.
3. Suggest related symbols the user might also want to explore.

If no results are found, suggest alternative search terms or broader patterns.
