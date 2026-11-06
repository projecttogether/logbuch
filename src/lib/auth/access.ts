import { and, eq, isNull, sql } from "drizzle-orm";
import { recordAudit } from "@/lib/audit";
import type { DirectoryConfig } from "@/lib/config";
import type { Database } from "@/lib/db/client";
import { authUser, person } from "@/lib/db/schema";
import { findPersonBySubject, findSubjectForUser } from "@/lib/directory/queries";

/** Error code the login flow uses when someone has no access to Logbuch. */
export const NO_ACCESS_ERROR_CODE = "NO_ACCESS";

/** On-demand directory syncs at login run at most once per minute. */
export const LOGIN_SYNC_MIN_INTERVAL_MS = 60_000;

/** Serializes first logins in the manual directory, so an invitation is linked once. */
const LINK_LOCK_KEY = 7_261_002;

export interface LoginAccessOptions {
  directory: DirectoryConfig;
  /** Runs a directory sync now (Keycloak directory). */
  syncDirectoryNow: () => Promise<unknown>;
  now?: Date;
}

/**
 * Decides whether a Better Auth user may get a session. The OIDC `sub` must
 * belong to a person with access.
 *
 * - Keycloak directory: if no such person exists, one directory sync runs (at
 *   most once per minute) and the check repeats.
 * - Manual directory: at the first login, an invitation whose email matches
 *   the user's verified email is linked to the `sub`. While nobody is an admin
 *   yet, a verified email in INITIAL_ADMIN_EMAILS becomes the first admin.
 *   Afterwards the person is matched by `sub` only.
 */
export async function hasLoginAccess(db: Database, userId: string, options: LoginAccessOptions): Promise<boolean> {
  const subject = await findSubjectForUser(db, userId);
  if (!subject) return false;
  const known = await findPersonBySubject(db, subject);
  if (known?.hasAccess) return true;

  if (options.directory.DIRECTORY === "keycloak") {
    // The person may have been added to the access group since the last sync.
    await options.syncDirectoryNow();
    return (await findPersonBySubject(db, subject))?.hasAccess === true;
  }
  if (known) return false;
  return linkFirstLogin(db, userId, subject, options.directory.INITIAL_ADMIN_EMAILS, options.now ?? new Date());
}

async function linkFirstLogin(db: Database, userId: string, subject: string, initialAdmins: string[], now: Date): Promise<boolean> {
  const [user] = await db
    .select({ name: authUser.name, email: authUser.email, emailVerified: authUser.emailVerified })
    .from(authUser)
    .where(eq(authUser.id, userId));
  // Only an email the identity provider verified may claim an invitation.
  if (!user?.emailVerified || !user.email) return false;
  const email = user.email.trim().toLowerCase();
  const name = user.name.trim();

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${LINK_LOCK_KEY})`);
    // Another login of the same user may have linked it meanwhile.
    const linked = await findPersonBySubject(tx, subject);
    if (linked) return linked.hasAccess;

    const [invited] = await tx
      .select()
      .from(person)
      .where(and(sql`lower(${person.workEmail}) = ${email}`, isNull(person.oidcSubject), eq(person.hasAccess, true)))
      .orderBy(person.createdAt)
      .limit(1);
    if (invited) {
      await tx
        .update(person)
        .set({ oidcSubject: subject, displayName: name || invited.displayName, updatedAt: now })
        .where(eq(person.id, invited.id));
      await recordAudit(tx, { actorId: invited.id, action: "person.linked", payload: { email } });
      return true;
    }

    if (!initialAdmins.includes(email)) return false;
    const [admin] = await tx
      .select({ id: person.id })
      .from(person)
      .where(and(eq(person.isAdmin, true), eq(person.hasAccess, true)))
      .limit(1);
    if (admin) return false;
    const [created] = await tx
      .insert(person)
      .values({
        oidcSubject: subject,
        displayName: name || email,
        workEmail: email,
        hasAccess: true,
        isAdmin: true,
        accessChangedAt: now,
      })
      .returning({ id: person.id });
    await recordAudit(tx, { actorId: created!.id, action: "person.first_admin", payload: { email } });
    return true;
  });
}
