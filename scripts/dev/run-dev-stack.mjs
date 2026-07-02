import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const commands = [
  {
    name: "frontend",
    color: "\x1b[36m",
    command: "npm",
    args: ["run", "dev"],
  },
  {
    name: "backend",
    color: "\x1b[35m",
    command: "npm",
    args: ["--prefix", "live-backend", "run", "dev:watch"],
  },
];

const reset = "\x1b[0m";
const children = new Set();
let shuttingDown = false;

function prefixOutput(child, streamName, command) {
  const lineReader = createInterface({ input: child[streamName] });

  lineReader.on("line", (line) => {
    const output = streamName === "stderr" ? process.stderr : process.stdout;
    output.write(`${command.color}[${command.name}]${reset} ${line}\n`);
  });
}

function stopAll(signal = "SIGTERM") {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  for (const child of children) {
    if (!child.killed) {
      child.kill(signal);
    }
  }
}

for (const command of commands) {
  const child = spawn(command.command, command.args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["inherit", "pipe", "pipe"],
  });

  children.add(child);
  prefixOutput(child, "stdout", command);
  prefixOutput(child, "stderr", command);

  child.on("exit", (code, signal) => {
    children.delete(child);

    if (!shuttingDown) {
      const reason = signal ? `signal ${signal}` : `exit code ${code}`;
      const output = code === 0 ? process.stdout : process.stderr;
      output.write(`${command.color}[${command.name}]${reset} stopped with ${reason}\n`);
      stopAll();
      process.exitCode = code ?? 1;
    }

    if (children.size === 0) {
      process.exit(process.exitCode);
    }
  });
}

process.on("SIGINT", () => stopAll("SIGINT"));
process.on("SIGTERM", () => stopAll("SIGTERM"));
