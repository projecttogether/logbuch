import { validateWorkerConfig } from "@/lib/config";
import { getPool } from "@/lib/db/client";
import { runDirectorySync } from "@/lib/directory/service";
import { logger } from "@/lib/logger";

// Runs one Keycloak directory sync now: `npm run directory:sync`, or in the
// container `node dist/directory-sync.mjs`. The manual directory has nothing
// to sync.
async function main() {
  validateWorkerConfig();
  const result = await runDirectorySync("manual");
  await getPool().end();
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.status === "failed" ? 1 : 0);
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, "directory sync failed");
  process.exit(1);
});
