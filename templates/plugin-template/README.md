# mini-coder Plugin Template

A minimal template for creating [mini-coder](https://github.com/your-org/mini-coder) language plugins.

## Quick Start

1. Copy this directory or create a new package from it:

   ```bash
   cp -r templates/plugin-template my-mini-coder-plugin
   cd my-mini-coder-plugin
   ```

2. Update `package.json`:
   - Change `name` to `mini-coder-plugin-<your-language>`
   - Update `description`

3. Implement `src/index.ts`:
   - Set `extensions` to your language's file extensions (e.g. `[".py"]`)
   - Implement `indexFile()` to parse content and return `IndexedSymbol[]`

4. Build and test:

   ```bash
   npm install
   npm run build
   npm test
   ```

## Plugin Spec

See [docs/PLUGIN_SPEC.md](../../docs/PLUGIN_SPEC.md) in the mini-coder repo for the full interface specification.

## Distribution

- **Local**: Place compiled `dist/index.js` (or source) in `<workspace>/.mini-coder/plugins/`
- **npm**: Publish as `mini-coder-plugin-<language>`; mini-coder discovers it via `package.json` dependencies
