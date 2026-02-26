# minicode Plugin Template

A minimal template for creating [minicode](https://github.com/your-org/minicode) language plugins.

## Quick Start

1. Copy this directory or create a new package from it:

   ```bash
   cp -r templates/plugin-template my-minicode-plugin
   cd my-minicode-plugin
   ```

2. Update `package.json`:
   - Change `name` to `minicode-plugin-<your-language>`
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

See [docs/PLUGIN_SPEC.md](../../docs/PLUGIN_SPEC.md) in the minicode repo for the full interface specification.

## Distribution

- **Local**: Place compiled `dist/index.js` (or source) in `<workspace>/.minicode/plugins/`
- **npm**: Publish as `minicode-plugin-<language>`; minicode discovers it via `package.json` dependencies
