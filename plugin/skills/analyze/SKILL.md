---
description: Run structural analysis on the project to find dependency cycles, hotspots, and coupling issues
---

Use the minicode MCP server to analyze the project structure. Follow these steps:

1. Read the `minicode://structural-analysis` resource to get the full structural analysis report.
2. Summarize the findings for the user, grouped by type (cycles, hotspots, coupling).
3. For any high-severity findings, use `get_dependencies` or `find_references` on the affected symbols to provide additional context.
4. Suggest concrete next steps for addressing the most impactful findings.

Keep the summary concise. Focus on actionable findings, not noise.
