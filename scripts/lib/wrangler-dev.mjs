/**
 * Run the built Worker under `wrangler dev` (local workerd) for a measurement script.
 *
 * Values reach workerd through a temporary env file readable only by this user and removed when the process stops or
 * exits. Nothing is printed. Needs `npm run build`.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ROOT } from "./db.mjs";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export async function startWranglerDev({ port, inspectorPort, vars }) {
  const workDir = mkdtempSync(join(tmpdir(), "firstseen-wrangler-"));
  const envFile = join(workDir, "worker.env");
  const lines = Object.entries(vars).filter(([, value]) => value !== undefined && value !== "").map(([name, value]) => `${name}=${value}`);
  writeFileSync(envFile, `${lines.join("\n")}\n`, { mode: 0o600 });

  const wrangler = spawn(
    resolve(ROOT, "node_modules/.bin/wrangler"),
    [
      "dev",
      "--config", "apps/web/dist/server/wrangler.json",
      "--ip", "127.0.0.1",
      "--port", String(port),
      "--inspector-port", String(inspectorPort),
      "--env-file", envFile,
      "--show-interactive-dev-session=false",
      "--log-level", "error",
    ],
    {
      cwd: ROOT,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: join(workDir, "logs") },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let errors = "";
  wrangler.stderr.on("data", (chunk) => { errors += chunk; });

  const exited = new Promise((resolve) => wrangler.once("exit", resolve));
  const removeWorkDir = () => {
    // wrangler can still be writing its logs as it exits, which failed the whole measurement with ENOTEMPTY. Retry, and
    // if the directory still cannot go, remove at least the env file: it holds the service-role key.
    try {
      rmSync(workDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    } catch {
      rmSync(envFile, { force: true });
    }
  };
  let stopped = false;
  /**
   * Stop wrangler and wait until it has exited. Returning before it had let a run started right after reach the
   * previous workerd while it shut down, and fail with "terminated" (2 of 3 back-to-back runs).
   */
  const stop = async () => {
    if (!stopped) {
      stopped = true;
      wrangler.kill("SIGTERM");
      const timeout = sleep(10_000).then(() => "timeout");
      if ((await Promise.race([exited, timeout])) === "timeout") {
        wrangler.kill("SIGKILL");
        await exited;
      }
    }
    removeWorkDir();
  };
  // A last resort when the caller exits without awaiting stop(): signal wrangler and remove the env file synchronously.
  process.on("exit", () => {
    if (!stopped) wrangler.kill("SIGTERM");
    removeWorkDir();
  });
  process.on("SIGINT", () => process.exit(130));

  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${base}/signin`);
      await response.arrayBuffer();
      if (response.status < 500) return { base, stop, errors: () => errors };
    } catch {
      // not listening yet
    }
    await sleep(500);
  }
  stop();
  throw new Error(`wrangler dev did not start.\n${errors.slice(-2000)}`);
}
