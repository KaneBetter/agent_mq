// Waits until Postgres accepts connections. Used by `pnpm setup`.
import { execSync } from "node:child_process";

const deadline = Date.now() + 60_000;
process.stdout.write("Waiting for Postgres");
while (Date.now() < deadline) {
  try {
    execSync("docker exec agentmq-db pg_isready -U agentmq -d agentmq", {
      stdio: "ignore",
    });
    console.log("\nPostgres is ready.");
    process.exit(0);
  } catch {
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 1500));
  }
}
console.error("\nTimed out waiting for Postgres.");
process.exit(1);
