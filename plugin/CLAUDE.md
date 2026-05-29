# Minicode Plugin Instructions

You have access to minicode's code intelligence tools via MCP. These tools provide AST-level symbol navigation that is more precise and context-efficient than reading entire files.

## Tool Preference

When exploring or understanding code that minicode has indexed (TypeScript and JavaScript built-in; Python via `minicode-plugin-python`; other languages via custom plugins):

- **Prefer `read_symbol`** over reading entire files. It returns the source, signature, dependencies, references, and annotations for a specific function, class, or type — everything you need in one call.
- **Prefer `search_code_map`** over generic file search when looking for symbols by name. It searches the indexed symbol table directly.
- **Use `find_references`** before modifying a symbol to understand its impact.
- **Use `get_dependencies`** to understand what a symbol depends on before making changes.
- **Use `find_path`** to understand how two symbols are connected through the dependency graph.

## Resources

- Read `minicode://code-map` to get a ranked overview of all symbols in the project.
- Read `minicode://structural-analysis` to get dependency cycles, hotspots, and coupling findings.

## Annotations

Symbols may have user-attached annotations that provide special instructions (e.g., "stable API — don't modify", "deprecated — use X instead"). These annotations are automatically included in tool results. You can also add annotations with `add_annotation` and view them with `list_annotations`.

## Web UI

If minicode serve is running, the web UI at localhost shows a live interactive dependency graph. As you use the MCP tools, the graph updates in real time — nodes pulse and expand to visualize your exploration. The user may be watching this as you work.
