import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

export default function globalSetup() {
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
  process.env.HMS_E2E_ACCOUNTS_JSON = JSON.stringify(accounts);
}
