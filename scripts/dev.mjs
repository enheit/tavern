import { spawn } from "node:child_process";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const children = new Set();
const rendererPollMs = 200;
let stopping = false;

function start(args, env = process.env) {
  const child = spawn(pnpm, args, { cwd: process.cwd(), env, stdio: "inherit" });
  children.add(child);
  child.once("exit", (code, signal) => {
    children.delete(child);
    if (!stopping && (code !== 0 || signal !== null)) stop(code ?? 1);
  });
  return child;
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGINT");
  process.exitCode = code;
}

for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => stop());

start(["-F", "@tavern/worker", "dev"]);
start(["-F", "@tavern/app", "dev"]);

const rendererUrl = "http://localhost:5173";
async function waitForRenderer(url) {
  if (stopping) return false;
  try {
    const response = await fetch(url);
    if (response.ok) return true;
  } catch (error) {
    // A refused connection is the expected readiness signal while Vite is still starting. Other
    // failures are programming or platform errors and must stop the dev stack instead of looping.
    if (!(error instanceof TypeError)) throw error;
  }
  await new Promise((resolve) => setTimeout(resolve, rendererPollMs));
  return waitForRenderer(url);
}

if (await waitForRenderer(rendererUrl)) {
  start(["-F", "@tavern/desktop", "dev"], {
    ...process.env,
    TAVERN_RENDERER_URL: rendererUrl,
  });
}
