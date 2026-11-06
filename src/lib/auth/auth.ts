import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { getAuthConfig, getDirectoryConfig, type AuthConfig, type DirectoryConfig } from "@/lib/config";
import { getDb, type Database } from "@/lib/db/client";
import { authAccount, authSession, authUser, authVerification } from "@/lib/db/schema";
import { OIDC_PROVIDER_ID } from "@/lib/directory/sessions";
import { runDirectorySync } from "@/lib/directory/service";
import { logger } from "@/lib/logger";
import { hasLoginAccess, LOGIN_SYNC_MIN_INTERVAL_MS, NO_ACCESS_ERROR_CODE } from "./access";
import { discoveryUrl } from "./discovery-url";

export interface CreateAuthOptions {
  config: AuthConfig;
  directory: DirectoryConfig;
  db: Database;
  syncDirectoryNow: () => Promise<unknown>;
}

/**
 * Better Auth with one OpenID Connect provider (authorization code flow with
 * PKCE) as the only login. Endpoints, including logout, come from the
 * provider's discovery document. Sessions live in PostgreSQL and are read on
 * every request, so ending a session takes effect immediately.
 */
export function createAuth({ config, directory, db, syncDirectoryNow }: CreateAuthOptions) {
  return betterAuth({
    appName: "Logbuch",
    baseURL: config.LOGBUCH_BASE_URL,
    basePath: "/api/auth",
    secret: config.BETTER_AUTH_SECRET,
    trustedOrigins: [config.LOGBUCH_BASE_URL],
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { user: authUser, session: authSession, account: authAccount, verification: authVerification },
    }),
    emailAndPassword: { enabled: false },
    session: {
      // No cookie cache: every request checks the session in the database.
      cookieCache: { enabled: false },
    },
    advanced: {
      cookiePrefix: "logbuch",
      useSecureCookies: config.LOGBUCH_BASE_URL.startsWith("https://"),
    },
    onAPIError: { errorURL: `${config.LOGBUCH_BASE_URL}/login` },
    databaseHooks: {
      session: {
        create: {
          // The access rule runs before a session exists, so people without
          // access never get one.
          before: async (session) => {
            const allowed = await hasLoginAccess(db, session.userId, { directory, syncDirectoryNow });
            if (!allowed) {
              logger.info({ userId: session.userId }, "login denied: no access");
              throw new APIError("FORBIDDEN", {
                code: NO_ACCESS_ERROR_CODE,
                message: "You do not have access to Logbuch.",
              });
            }
          },
        },
      },
    },
    plugins: [
      genericOAuth({
        config: [
          {
            providerId: OIDC_PROVIDER_ID,
            discoveryUrl: discoveryUrl(config.OIDC_ISSUER),
            clientId: config.OIDC_CLIENT_ID,
            clientSecret: config.OIDC_CLIENT_SECRET,
            scopes: config.OIDC_SCOPES.split(/[\s,]+/).filter(Boolean),
            pkce: true,
            requireIdTokenVerification: true,
            postLogoutRedirectURI: `${config.LOGBUCH_BASE_URL}/`,
          },
        ],
      }),
      // Must be last: applies cookies set by auth.api calls in Server Actions.
      nextCookies(),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

const globalForAuth = globalThis as unknown as { logbuchAuth?: Auth };

export function getAuth(): Auth {
  const directory = getDirectoryConfig();
  globalForAuth.logbuchAuth ??= createAuth({
    config: getAuthConfig(),
    directory,
    db: getDb(),
    syncDirectoryNow: () =>
      directory.DIRECTORY === "keycloak" ? runDirectorySync("login", LOGIN_SYNC_MIN_INTERVAL_MS) : Promise.resolve(),
  });
  return globalForAuth.logbuchAuth;
}
