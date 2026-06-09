## Install

`claude-pty` is a drop-in replacement for `claude -p` that drives the real interactive Claude Code TUI. Download the archive for your platform below, extract it, and put it on your `PATH`.

> **Keep them together.** Each archive contains the `claude-pty` binary **and** a `node_modules/node-pty/` folder. The binary loads the native `node-pty` from next to itself — always keep both in the same directory.

**Prerequisite:** [Claude Code](https://claude.com/claude-code) must be installed (`claude-pty` drives the real `claude`). If `claude` isn't on your `PATH`, set `CLAUDE_PTY_BIN=/path/to/claude`.

### Windows — `claude-pty-windows-x64.zip`

1. Extract the zip into a folder, e.g. `%LOCALAPPDATA%\claude-pty` (you'll get `claude-pty.exe` + `node_modules\`).
2. Add that folder to your user `PATH` (persists for new shells):
   ```cmd
   setx PATH "%PATH%;%LOCALAPPDATA%\claude-pty"
   ```
3. Open a **new** terminal: `claude-pty "hello"`

### macOS (Apple Silicon) — `claude-pty-darwin-arm64.tar.gz` · Linux x64 — `claude-pty-linux-x64.tar.gz`

```bash
mkdir -p ~/.local/claude-pty
# replace <archive> with the file you downloaded:
tar -xzf <archive>.tar.gz --strip-components=1 -C ~/.local/claude-pty
chmod +x ~/.local/claude-pty/claude-pty

# put it on PATH — either add the folder:
echo 'export PATH="$HOME/.local/claude-pty:$PATH"' >> ~/.zshrc   # or ~/.bashrc
# …or symlink just the binary into a dir already on PATH:
ln -s ~/.local/claude-pty/claude-pty ~/.local/bin/claude-pty

claude-pty "hello"
```

A symlink works because `node-pty` is resolved relative to the binary's **real** path — just keep the binary and its `node_modules/node-pty/` folder together.

> On the **first** run in a brand-new directory, Claude's interactive workspace-trust prompt may appear — `claude-pty` auto-accepts it and continues.

Full documentation → **[README · Install](https://github.com/atinseau/claude-pty#install-release-binary)** · [Usage](https://github.com/atinseau/claude-pty#usage)

---
