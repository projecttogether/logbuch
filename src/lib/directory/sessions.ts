import { and, eq, inArray } from "drizzle-orm";
import type { Database, Transaction } from "@/lib/db/client";
import { authAccount, authSession } from "@/lib/db/schema";

/** Better Auth's provider ID of the OIDC login; also the last segment of the callback URL. */
export const OIDC_PROVIDER_ID = "oidc";

/** Ends every session of the people who log in with these OIDC subjects. Returns how many ended. */
export async function endSessionsForSubjects(tx: Database | Transaction, subjects: string[]): Promise<number> {
  if (subjects.length === 0) return 0;
  const userIds = tx
    .select({ userId: authAccount.userId })
    .from(authAccount)
    .where(and(eq(authAccount.providerId, OIDC_PROVIDER_ID), inArray(authAccount.accountId, subjects)));
  const deleted = await tx
    .delete(authSession)
    .where(inArray(authSession.userId, userIds))
    .returning({ id: authSession.id });
  return deleted.length;
}
