import { getDirectoryConfig } from "@/lib/config";
import { getPool } from "@/lib/db/client";
import { createDirectoryAdapter } from "./adapter";
import { syncDirectory, type SyncResult, type SyncTrigger } from "./sync";
import type { DirectoryAdapter } from "./types";

let adapter: DirectoryAdapter | undefined;

/** The process-wide adapter, so the token cache is shared. Null for the manual directory. */
export function getDirectoryAdapter(): DirectoryAdapter | null {
  const config = getDirectoryConfig();
  if (config.DIRECTORY !== "keycloak") return null;
  adapter ??= createDirectoryAdapter(config);
  return adapter;
}

/** Runs a directory sync with this process's pool and adapter. The manual directory has nothing to sync. */
export async function runDirectorySync(trigger: SyncTrigger, minIntervalMs?: number): Promise<SyncResult> {
  const directoryAdapter = getDirectoryAdapter();
  if (!directoryAdapter) return { status: "skipped", reason: "no_directory" };
  return syncDirectory({ pool: getPool(), adapter: directoryAdapter, trigger, minIntervalMs });
}
