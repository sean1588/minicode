# Go language plugin

Built into minicode; no Go installation, language server, or workspace `package.json` is required.

The plugin uses `tree-sitter-go` to index `.go` files: functions, value/pointer/generic receiver methods, structs and other named types, aliases, interfaces and their methods, and package-level constants and variables. It preserves declaration line ranges, signatures, adjacent documentation comments, and Go's uppercase export convention. Structs use the SDK's `class` kind so receiver methods nest in the code map; aliases and other defined types use `type`.

Qualified names include the directory and package clause: `main.Run` at the workspace root, `internal/store/store.Open` in `internal/store`. This keeps packages in different directories and external test packages separate. Short names and `Type.Method` aliases remain searchable.

Dependency resolution is deliberately syntax-only: unambiguous bare function calls and named type references within the same directory/package, including across files. Locally shadowed names are conservatively suppressed throughout the containing declaration. Imported-package calls, receiver dispatch, generic call resolution, interface implementation, build tags, and module/workspace resolution are not supported. Files under `vendor/`, `testdata/`, and underscore-prefixed path segments are excluded. Other `.go` files are indexed regardless of build constraints; ambiguous targets are omitted. This is structural navigation, not Go type checking.

Like Python support, Go support is skipped with a warning if its native parser cannot load.

See [the plugin specification](../../docs/PLUGIN_SPEC.md#reference-go-plugin) for declaration mappings and packaging requirements.
