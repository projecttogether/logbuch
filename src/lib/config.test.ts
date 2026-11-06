import { describe, expect, it } from "vitest";
import {
  ConfigError,
  parseAuthConfig,
  parseDirectoryConfig,
  parseNotificationConfig,
  parseWebhookConfig,
  validateWebConfig,
  validateWorkerConfig,
} from "./config";

const auth = {
  LOGBUCH_BASE_URL: "https://logbuch.example.org/",
  BETTER_AUTH_SECRET: "x".repeat(32),
  OIDC_ISSUER: "https://auth.example.org/realms/acme/",
  OIDC_CLIENT_ID: "logbuch",
  OIDC_CLIENT_SECRET: "secret",
};

const keycloakDirectory = {
  DIRECTORY: "keycloak",
  OIDC_ISSUER: "https://auth.example.org/realms/acme",
  OIDC_CLIENT_ID: "logbuch",
  OIDC_CLIENT_SECRET: "secret",
  KEYCLOAK_ACCESS_GROUP: "/logbuch",
};

describe("parseAuthConfig", () => {
  it("strips trailing slashes from URLs and defaults the scopes", () => {
    const config = parseAuthConfig(auth);
    expect(config.LOGBUCH_BASE_URL).toBe("https://logbuch.example.org");
    expect(config.OIDC_ISSUER).toBe("https://auth.example.org/realms/acme");
    expect(config.OIDC_SCOPES).toBe("openid profile email");
  });

  it("treats blank values as missing", () => {
    expect(() => parseAuthConfig({ ...auth, OIDC_CLIENT_SECRET: "  " })).toThrow(/OIDC_CLIENT_SECRET/);
  });

  it("requires a long secret, and not the example one in production", () => {
    expect(() => parseAuthConfig({ ...auth, BETTER_AUTH_SECRET: "short" })).toThrow(/at least 32/);
    const example = { ...auth, BETTER_AUTH_SECRET: "development-secret-development-secret" };
    expect(() => parseAuthConfig(example)).not.toThrow();
    expect(() => parseAuthConfig({ ...example, NODE_ENV: "production" })).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("has no default identity provider", () => {
    expect(() => parseAuthConfig({ ...auth, OIDC_ISSUER: undefined })).toThrow(/OIDC_ISSUER/);
  });
});

describe("parseDirectoryConfig", () => {
  it("is manual by default, with an optional list of first admins", () => {
    expect(parseDirectoryConfig({})).toEqual({ DIRECTORY: "manual", INITIAL_ADMIN_EMAILS: [] });
    expect(parseDirectoryConfig({ INITIAL_ADMIN_EMAILS: "Ada@Example.org, bob@example.org;carl@example.org" })).toEqual({
      DIRECTORY: "manual",
      INITIAL_ADMIN_EMAILS: ["ada@example.org", "bob@example.org", "carl@example.org"],
    });
    expect(() => parseDirectoryConfig({ INITIAL_ADMIN_EMAILS: "not-an-email" })).toThrow(/INITIAL_ADMIN_EMAILS/);
  });

  it("uses the login client for the Keycloak directory unless it has its own", () => {
    expect(parseDirectoryConfig(keycloakDirectory)).toMatchObject({
      DIRECTORY: "keycloak",
      KEYCLOAK_CLIENT_ID: "logbuch",
      KEYCLOAK_CLIENT_SECRET: "secret",
      KEYCLOAK_ACCESS_GROUP: "/logbuch",
    });
    expect(
      parseDirectoryConfig({ ...keycloakDirectory, KEYCLOAK_CLIENT_ID: "logbuch-directory", KEYCLOAK_CLIENT_SECRET: "other" }),
    ).toMatchObject({ KEYCLOAK_CLIENT_ID: "logbuch-directory", KEYCLOAK_CLIENT_SECRET: "other" });
  });

  it("requires a Keycloak realm URL and group paths", () => {
    expect(() => parseDirectoryConfig({ ...keycloakDirectory, OIDC_ISSUER: "https://accounts.example.org" })).toThrow(/realms/);
    expect(() => parseDirectoryConfig({ ...keycloakDirectory, KEYCLOAK_ACCESS_GROUP: "" })).toThrow(/KEYCLOAK_ACCESS_GROUP/);
    expect(() => parseDirectoryConfig({ ...keycloakDirectory, KEYCLOAK_ACCESS_GROUP: "logbuch" })).toThrow(/group path/);
    expect(parseDirectoryConfig({ ...keycloakDirectory, KEYCLOAK_TEAMS_GROUP: "/org/teams" })).toMatchObject({
      KEYCLOAK_TEAMS_GROUP: "/org/teams",
    });
  });

  it("rejects an unknown directory", () => {
    expect(() => parseDirectoryConfig({ DIRECTORY: "ldap" })).toThrow(/DIRECTORY/);
  });
});

describe("validateWebConfig", () => {
  it("reports every missing variable at once", () => {
    let error: unknown;
    try {
      validateWebConfig({});
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as Error).message;
    for (const name of ["DATABASE_URL", "LOGBUCH_BASE_URL", "BETTER_AUTH_SECRET", "OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET"]) {
      expect(message).toContain(name);
    }
    expect(message).not.toContain("KEYCLOAK");
  });

  it("passes with a complete configuration", () => {
    expect(() => validateWebConfig({ DATABASE_URL: "postgres://u:p@db:5432/logbuch", ...auth })).not.toThrow();
    expect(() => validateWebConfig({ DATABASE_URL: "postgres://u:p@db:5432/logbuch", ...auth, ...keycloakDirectory })).not.toThrow();
  });
});

describe("parseNotificationConfig", () => {
  const base = { LOGBUCH_BASE_URL: "https://logbuch.example.org/" };

  it("sends for real in production and only logs elsewhere", () => {
    expect(parseNotificationConfig({ ...base, NODE_ENV: "production" }).NOTIFICATION_TRANSPORT).toBe("live");
    expect(parseNotificationConfig({ ...base, NODE_ENV: "development" }).NOTIFICATION_TRANSPORT).toBe("console");
    expect(parseNotificationConfig({ ...base, NODE_ENV: "production", NOTIFICATION_TRANSPORT: "console" }).NOTIFICATION_TRANSPORT).toBe("console");
  });

  it("treats Slack and email as optional, blank as unset", () => {
    const config = parseNotificationConfig({ ...base, SLACK_BOT_TOKEN: "", SMTP_URL: " ", MAILERSEND_API_TOKEN: " ", MAIL_FROM: "" });
    expect(config).toMatchObject({
      LOGBUCH_BASE_URL: "https://logbuch.example.org",
      SLACK_BOT_TOKEN: undefined,
      SMTP_URL: undefined,
      MAILERSEND_API_TOKEN: undefined,
      MAIL_FROM_NAME: "Logbuch",
    });
  });

  it("takes a Slack channel ID, not a channel name", () => {
    expect(parseNotificationConfig({ ...base, SLACK_CHANNEL_ID: "C07LOGBUCH" }).SLACK_CHANNEL_ID).toBe("C07LOGBUCH");
    expect(() => parseNotificationConfig({ ...base, SLACK_CHANNEL_ID: "#logbuch" })).toThrow(/SLACK_CHANNEL_ID/);
  });

  it("rejects a user token for Slack", () => {
    expect(() => parseNotificationConfig({ ...base, SLACK_BOT_TOKEN: "xoxp-123" })).toThrow(/SLACK_BOT_TOKEN/);
  });

  it("needs a sender for email, and one way to send it", () => {
    expect(parseNotificationConfig({ ...base, SMTP_URL: "smtps://user:pass@mail.example.org:465", MAIL_FROM: "logbuch@example.org" }).SMTP_URL).toBe(
      "smtps://user:pass@mail.example.org:465",
    );
    expect(() => parseNotificationConfig({ ...base, SMTP_URL: "smtp://mail.example.org" })).toThrow(/MAIL_FROM/);
    expect(() => parseNotificationConfig({ ...base, MAILERSEND_API_TOKEN: "mlsn.abc" })).toThrow(/MAIL_FROM/);
    expect(() => parseNotificationConfig({ ...base, MAILERSEND_API_TOKEN: "mlsn.abc", MAIL_FROM: "not-an-email" })).toThrow(/MAIL_FROM/);
    expect(() => parseNotificationConfig({ ...base, SMTP_URL: "https://mail.example.org", MAIL_FROM: "logbuch@example.org" })).toThrow(/SMTP_URL/);
    expect(() =>
      parseNotificationConfig({ ...base, SMTP_URL: "smtp://mail.example.org", MAILERSEND_API_TOKEN: "mlsn.abc", MAIL_FROM: "logbuch@example.org" }),
    ).toThrow(/either SMTP_URL or MAILERSEND_API_TOKEN/);
  });
});

describe("validateWorkerConfig", () => {
  it("needs the base URL for links in messages", () => {
    expect(() => validateWorkerConfig({ DATABASE_URL: "postgres://u:p@db:5432/logbuch" })).toThrow(/LOGBUCH_BASE_URL/);
    expect(() => validateWorkerConfig({ DATABASE_URL: "postgres://u:p@db:5432/logbuch", LOGBUCH_BASE_URL: "https://logbuch.example.org" })).not.toThrow();
  });
});

describe("parseWebhookConfig", () => {
  it("is off without a URL and needs a long secret once the URL is set", () => {
    expect(parseWebhookConfig({ WEBHOOK_URL: "" })).toEqual({ WEBHOOK_URL: undefined, WEBHOOK_SECRET: undefined });
    expect(() => parseWebhookConfig({ WEBHOOK_URL: "https://hooks.example.org/logbuch" })).toThrow(/WEBHOOK_SECRET/);
    expect(() => parseWebhookConfig({ WEBHOOK_URL: "https://hooks.example.org/logbuch", WEBHOOK_SECRET: "short" })).toThrow(/WEBHOOK_SECRET/);
    expect(parseWebhookConfig({ WEBHOOK_URL: "https://hooks.example.org/logbuch", WEBHOOK_SECRET: "s".repeat(32) }).WEBHOOK_URL).toBe(
      "https://hooks.example.org/logbuch",
    );
  });
});
