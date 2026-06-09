# claude-pty

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.3.14. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

## Scripts

- `bun run check` — lint + format check (Biome), the CI/pre-commit gate
- `bun run check:fix` — apply Biome lint + format fixes
- `bun run format` — write formatting only
- `bun run lint` — lint only
- `bun run check-types` — `tsc --noEmit`
- `bun run test` — `bun test`
- `bun run build` — compile a binary for the current platform
- `bun run build:all` — cross-compile for all main platforms into `dist/`

## Build

`bun run build` compiles the app to `claude-pty.exe` for the current platform.
`bun run build:all` cross-compiles for the main targets into `dist/`:

- `dist/claude-pty-windows-x64.exe`
- `dist/claude-pty-linux-x64`
- `dist/claude-pty-linux-arm64`
- `dist/claude-pty-darwin-x64`
- `dist/claude-pty-darwin-arm64`

### Important: binaries are NOT standalone

claude-pty depends on **node-pty**, a native module. The compiled binary does
**not** bundle node-pty's native code. At runtime the binary still requires
`node_modules/node-pty/` (with the prebuild matching the host OS/arch) to be
present in the run directory.

Consequently, the cross-compiled binaries produced by `build:all` are only
guaranteed to run on a host where the corresponding node-pty prebuild is
installed. `build:all` produces the executables, but they are not portable,
self-contained binaries — ship them alongside a matching `node_modules/node-pty/`.
