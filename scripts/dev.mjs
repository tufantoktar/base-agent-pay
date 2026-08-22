import { spawn } from "node:child_process";

const children = [];

function run(label, command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk) => {
    process.stdout.write(`[${label}] ${chunk}`);
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[${label}] ${chunk}`);
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      process.stderr.write(`[${label}] stopped by ${signal}\n`);
      return;
    }
    process.stderr.write(`[${label}] exited with code ${code}\n`);
    if (code !== 0) {
      shutdown(code ?? 1);
    }
  });

  children.push(child);
  return child;
}

function shutdown(code = 0) {
  for (const child of children) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

run("api", "node", ["api/dev-server.js"], {
  PORT: process.env.PORT ?? "8787",
});

run(
  "web",
  "npm",
  ["run", "dev", "--workspace", "frontend", "--", "--host", "127.0.0.1"],
  {
    VITE_API_URL: process.env.VITE_API_URL ?? "http://127.0.0.1:8787/api/task",
  },
);

