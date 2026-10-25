import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

// Both limiters count per client IP, and every browser here shares one: the login throttle and the
// broad API throttle (300 requests a minute). Clearing only the first lets a long run starve
// later sign-ins, so a test's setup clears both.
const RATE_KEY_PATTERNS = ["hms:login-rate:*", "hms:api-rate:*"];

export function clearRateLimits() {
  for (const pattern of RATE_KEY_PATTERNS) {
    const keys = execFileSync(
      "docker",
      ["compose", "exec", "-T", "redis", "redis-cli", "--scan", "--pattern", pattern],
      { cwd: repoRoot, encoding: "utf8" }
    ).trim().split("\n").filter(Boolean);
    if (keys.length) {
      execFileSync(
        "docker",
        ["compose", "exec", "-T", "redis", "redis-cli", "DEL", ...keys],
        { cwd: repoRoot, encoding: "utf8" }
      );
    }
  }
}

export function resetAuthTestAccounts(): Record<string, string> {
  const output = execFileSync(
    "docker",
    [
      "compose",
      "exec",
      "-T",
      "api",
      "python",
      "-m",
      "hms_backend.app.tooling.local_seed",
      "--auth-test-accounts",
      "--reset-existing"
    ],
    { cwd: repoRoot, encoding: "utf8" }
  );
  const accounts: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const cells = line.trim().split(/\s{2,}/);
    if (cells.length >= 3 && cells[0].endsWith("@example.test")) {
      accounts[cells[0]] = cells[2];
    }
  }
  if (Object.keys(accounts).length !== 6) {
    throw new Error("Expected six development auth accounts from the Docker seed command.");
  }
  clearRateLimits();
  return accounts;
}

export default function globalSetup() {
  process.env.HMS_E2E_ACCOUNTS_JSON = JSON.stringify(resetAuthTestAccounts());
}
