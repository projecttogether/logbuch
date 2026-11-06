import type { KeycloakDirectoryConfig } from "@/lib/config";
import { createKeycloakDirectoryAdapter } from "./keycloak-adapter";
import type { DirectoryAdapter } from "./types";

export function createDirectoryAdapter(config: KeycloakDirectoryConfig): DirectoryAdapter {
  return createKeycloakDirectoryAdapter({
    issuer: config.OIDC_ISSUER,
    clientId: config.KEYCLOAK_CLIENT_ID,
    clientSecret: config.KEYCLOAK_CLIENT_SECRET,
    accessGroup: config.KEYCLOAK_ACCESS_GROUP,
    adminGroup: config.KEYCLOAK_ADMIN_GROUP,
    teamsGroup: config.KEYCLOAK_TEAMS_GROUP,
  });
}
