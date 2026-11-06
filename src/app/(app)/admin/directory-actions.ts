"use server";

import { z } from "zod";
import { getDirectoryConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import {
  createTeam,
  invitePerson,
  renameTeam,
  setPersonAccess,
  setPersonAdmin,
  setTeamActive,
  updatePerson,
} from "@/lib/directory/manage";
import { invitePersonSchema, teamInputSchema, updatePersonSchema } from "@/lib/directory/schemas";
import { EntryError } from "@/lib/entries/commands";
import { handleFormAction as submit } from "@/lib/form-actions";
import type { FormState } from "@/lib/form-state";

/* People and teams of the manual directory. With the Keycloak directory they are read-only. */

const noFields = z.object({});

function assertManualDirectory() {
  if (getDirectoryConfig().DIRECTORY !== "manual") {
    throw new EntryError("forbidden", "People and teams come from Keycloak. Change them there.");
  }
}

export async function invitePersonAction(_state: FormState, formData: FormData): Promise<FormState> {
  return submit(formData, invitePersonSchema, async (actor, input) => {
    assertManualDirectory();
    await invitePerson(getDb(), actor, input);
    return "/admin/people";
  });
}

export async function updatePersonAction(personId: string, _state: FormState, formData: FormData): Promise<FormState> {
  return submit(formData, updatePersonSchema, async (actor, input) => {
    assertManualDirectory();
    await updatePerson(getDb(), actor, personId, input);
    return "/admin/people";
  });
}

export async function setPersonAccessAction(personId: string, hasAccess: boolean, _state: FormState, formData: FormData): Promise<FormState> {
  return submit(formData, noFields, async (actor) => {
    assertManualDirectory();
    await setPersonAccess(getDb(), actor, personId, hasAccess);
    return "/admin/people";
  });
}

export async function setPersonAdminAction(personId: string, isAdmin: boolean, _state: FormState, formData: FormData): Promise<FormState> {
  return submit(formData, noFields, async (actor) => {
    assertManualDirectory();
    await setPersonAdmin(getDb(), actor, personId, isAdmin);
    return "/admin/people";
  });
}

export async function createTeamAction(_state: FormState, formData: FormData): Promise<FormState> {
  return submit(formData, teamInputSchema, async (actor, input) => {
    assertManualDirectory();
    await createTeam(getDb(), actor, input);
    return "/admin/teams";
  });
}

export async function renameTeamAction(teamId: string, _state: FormState, formData: FormData): Promise<FormState> {
  return submit(formData, teamInputSchema, async (actor, input) => {
    assertManualDirectory();
    await renameTeam(getDb(), actor, teamId, input);
    return "/admin/teams";
  });
}

export async function setTeamActiveAction(teamId: string, isActive: boolean, _state: FormState, formData: FormData): Promise<FormState> {
  return submit(formData, noFields, async (actor) => {
    assertManualDirectory();
    await setTeamActive(getDb(), actor, teamId, isActive);
    return "/admin/teams";
  });
}
