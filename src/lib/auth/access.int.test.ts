import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { connectTestDatabase } from "../../../tests/integration/db";
import { directoryPerson, snapshot } from "../../../tests/fixtures/directory";
import type { DirectoryConfig } from "@/lib/config";
import { auditEvent, authAccount, authUser, person } from "@/lib/db/schema";
import { syncDirectory } from "@/lib/directory/sync";
import type { DirectoryAdapter } from "@/lib/directory/types";
import { hasLoginAccess } from "./access";

const testDb = connectTestDatabase();
const { db, pool } = testDb;

const KEYCLOAK: DirectoryConfig = {
  DIRECTORY: "keycloak",
  OIDC_ISSUER: "https://auth.example.org/realms/acme",
  KEYCLOAK_CLIENT_ID: "logbuch",
  KEYCLOAK_CLIENT_SECRET: "secret",
  KEYCLOAK_ACCESS_GROUP: "/logbuch",
  KEYCLOAK_ADMIN_GROUP: "/logbuch-admins",
  KEYCLOAK_TEAMS_GROUP: "/teams",
};
const manual = (initialAdmins: string[] = []): DirectoryConfig => ({ DIRECTORY: "manual", INITIAL_ADMIN_EMAILS: initialAdmins });

function syncWith(...ids: string[]) {
  const adapter: DirectoryAdapter = {
    name: "test",
    fetchSnapshot: async () => snapshot(ids.map((id) => directoryPerson({ externalId: id }))),
  };
  return () => syncDirectory({ pool, adapter, trigger: "login" });
}

/** A Better Auth user who logged in with the OIDC provider. */
async function oidcUser(subject: string, profile: { email?: string; name?: string; emailVerified?: boolean } = {}) {
  const userId = `user-${subject}`;
  await db.insert(authUser).values({
    id: userId,
    name: profile.name ?? subject,
    email: profile.email ?? `${subject}@example.test`,
    emailVerified: profile.emailVerified ?? true,
  });
  await db.insert(authAccount).values({ id: `account-${subject}`, accountId: subject, providerId: "oidc", userId });
  return userId;
}

beforeEach(() => testDb.reset());
afterAll(() => testDb.close());

describe("hasLoginAccess with the Keycloak directory", () => {
  it("allows a person with access without syncing", async () => {
    await syncWith("p1")();
    const userId = await oidcUser("sub-p1");
    const syncDirectoryNow = vi.fn();
    await expect(hasLoginAccess(db, userId, { directory: KEYCLOAK, syncDirectoryNow })).resolves.toBe(true);
    expect(syncDirectoryNow).not.toHaveBeenCalled();
  });

  it("syncs once when the person is unknown, then allows a newly added member", async () => {
    await syncWith("p1")();
    const userId = await oidcUser("sub-p2");
    const syncDirectoryNow = vi.fn(syncWith("p1", "p2"));
    await expect(hasLoginAccess(db, userId, { directory: KEYCLOAK, syncDirectoryNow })).resolves.toBe(true);
    expect(syncDirectoryNow).toHaveBeenCalledTimes(1);
  });

  it("denies someone outside the access group, even after a sync", async () => {
    await syncWith("p1")();
    const userId = await oidcUser("sub-outsider");
    const syncDirectoryNow = vi.fn(syncWith("p1"));
    await expect(hasLoginAccess(db, userId, { directory: KEYCLOAK, syncDirectoryNow })).resolves.toBe(false);
    expect(syncDirectoryNow).toHaveBeenCalledTimes(1);
  });

  it("denies a person who lost access", async () => {
    await syncWith("p1", "p2")();
    await syncWith("p1")();
    const userId = await oidcUser("sub-p2");
    await expect(hasLoginAccess(db, userId, { directory: KEYCLOAK, syncDirectoryNow: syncWith("p1") })).resolves.toBe(false);
  });

  it("denies a user without an OIDC account", async () => {
    await syncWith("p1")();
    await db.insert(authUser).values({ id: "local", name: "Local", email: "local@example.test" });
    await expect(hasLoginAccess(db, "local", { directory: KEYCLOAK, syncDirectoryNow: vi.fn() })).resolves.toBe(false);
  });
});

describe("hasLoginAccess with the manual directory", () => {
  const options = (initialAdmins: string[] = []) => ({ directory: manual(initialAdmins), syncDirectoryNow: vi.fn() });

  async function invite(email: string, values: Partial<typeof person.$inferInsert> = {}) {
    const [row] = await db.insert(person).values({ displayName: "Invited Name", workEmail: email, hasAccess: true, ...values }).returning();
    return row!;
  }

  it("links an invitation to the first login with the same verified email", async () => {
    const invited = await invite("Erika@Example.org");
    const userId = await oidcUser("sub-erika", { email: "erika@example.org", name: "Erika Example" });
    await expect(hasLoginAccess(db, userId, options())).resolves.toBe(true);

    const [linked] = await db.select().from(person).where(eq(person.id, invited.id));
    expect(linked).toMatchObject({ oidcSubject: "sub-erika", displayName: "Erika Example", hasAccess: true });
    const events = await db.select().from(auditEvent);
    expect(events.map((e) => e.action)).toEqual(["person.linked"]);

    // Later logins match the subject, not the email.
    await expect(hasLoginAccess(db, userId, options())).resolves.toBe(true);
    expect(await db.select().from(auditEvent)).toHaveLength(1);
  });

  it("does not link an unverified email", async () => {
    await invite("erika@example.org");
    const userId = await oidcUser("sub-erika", { email: "erika@example.org", emailVerified: false });
    await expect(hasLoginAccess(db, userId, options())).resolves.toBe(false);
    const [row] = await db.select().from(person);
    expect(row?.oidcSubject).toBeNull();
  });

  it("links an unverified email when the provider's addresses are trusted (OIDC_TRUST_EMAIL)", async () => {
    const invited = await invite("erika@example.org");
    const userId = await oidcUser("sub-erika", { email: "erika@example.org", emailVerified: false });
    await expect(hasLoginAccess(db, userId, { ...options(), trustEmail: true })).resolves.toBe(true);
    const [linked] = await db.select().from(person).where(eq(person.id, invited.id));
    expect(linked?.oidcSubject).toBe("sub-erika");
  });

  it("denies someone who was not invited, and an invitation whose access was taken away", async () => {
    await invite("gone@example.org", { hasAccess: false });
    await expect(hasLoginAccess(db, await oidcUser("sub-gone", { email: "gone@example.org" }), options())).resolves.toBe(false);
    await expect(hasLoginAccess(db, await oidcUser("sub-stranger", { email: "stranger@example.org" }), options())).resolves.toBe(false);
  });

  it("denies a linked person whose access was taken away", async () => {
    await invite("erika@example.org", { oidcSubject: "sub-erika", hasAccess: false });
    const userId = await oidcUser("sub-erika", { email: "erika@example.org" });
    await expect(hasLoginAccess(db, userId, options())).resolves.toBe(false);
  });

  it("makes the first admin from INITIAL_ADMIN_EMAILS while there is no admin", async () => {
    const userId = await oidcUser("sub-owner", { email: "Owner@Example.org", name: "Olivia Owner" });
    await expect(hasLoginAccess(db, userId, options(["owner@example.org"]))).resolves.toBe(true);
    const [owner] = await db.select().from(person);
    expect(owner).toMatchObject({ oidcSubject: "sub-owner", displayName: "Olivia Owner", workEmail: "owner@example.org", isAdmin: true, hasAccess: true });
    expect((await db.select().from(auditEvent)).map((e) => e.action)).toEqual(["person.first_admin"]);

    // Once there is an admin, the list grants nothing more.
    const second = await oidcUser("sub-second", { email: "second@example.org" });
    await expect(hasLoginAccess(db, second, options(["owner@example.org", "second@example.org"]))).resolves.toBe(false);
  });

  it("does not make an unverified email the first admin", async () => {
    const userId = await oidcUser("sub-owner", { email: "owner@example.org", emailVerified: false });
    await expect(hasLoginAccess(db, userId, options(["owner@example.org"]))).resolves.toBe(false);
    expect(await db.select().from(person)).toHaveLength(0);
  });
});
