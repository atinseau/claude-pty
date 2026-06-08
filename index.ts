import { spawn } from "node-pty";

const pty = spawn("C:\\Users\\arthur\\.local\\bin\\claude.exe", [], {});

pty.onData((data) => {
  console.log(data);
});

pty.onExit(({ exitCode, signal }) => {
  console.log(`Process exited with code ${exitCode} and signal ${signal}`);
});
