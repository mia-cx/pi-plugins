# pi-plugins

One pi package. `package.json` → `pi.extensions` loads every `extensions/*/index.ts`; other files in a plugin folder are modules, not plugins.

- Types come from the pinned `devDependencies`; pi supplies `@earendil-works/*` at runtime, so they stay `peerDependencies` with `"*"`.
- Plugins talk through `pi.events`. `extensions/usage/report.ts` owns the usage event and its shapes; the statusline only reads them.
- `pnpm check` runs Biome and `tsc`. Try a change with `pi -e .`.
- The README and CONTRIBUTING.md carry the 0rwx AI:W disclosure.
