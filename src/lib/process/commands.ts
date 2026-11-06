import { and, eq, isNull } from "drizzle-orm";
import { recordAudit } from "@/lib/audit";
import { addWorkingDays } from "@/lib/calendar";
import type { Database, Transaction } from "@/lib/db/client";
import {
  decision,
  entry,
  entryAffectedTeam,
  entryRelation,
  entryTag,
  outcome,
  participant,
  proposal,
  proposalVersion,
  response,
} from "@/lib/db/schema";
import {
  assertActiveTags,
  assertActiveTeam,
  assertPeopleWithAccess,
  assertPublishedEntries,
  assertSupersedable,
  assertTeams,
  EntryError,
  markSuperseded,
  refreshSearchText,
  setAffectedTeams,
  setRelations,
  setTags,
} from "@/lib/entries/commands";
import { SUMMARY_MAX } from "@/lib/entries/constants";
import { clipText, serverDate } from "@/lib/format";
import { notifyProposal, syncReadiness } from "@/lib/notifications/notify";
import { requestWebhook } from "@/lib/webhooks/sync";
import {
  MINIMUM_PERIODS,
  defaultFeedbackDeadline,
  isConsentGiver,
  minimumFeedbackDeadline,
  objectionHandlingRequired,
  openObjections,
  permissions,
  readiness,
  type Actor,
} from "./rules";
import type { ChangeReversibilityInput, ProposalDraftInput, PublishInput, ResponseInput, VersionInput } from "./schemas";
import { getDefaultPeriods } from "./settings";
import { loadProposal, type LoadedProposal } from "./snapshot";

/*
 * The process module: the only code that changes a proposal's status
 *. Every command locks the proposal, checks the rules,
 * writes, and records an audit event in one transaction. Drafts are private
 * and leave no audit trail until they are submitted.
 */

const forbidden = (message: string) => new EntryError("forbidden", message);
const invalid = (field: string, message: string) => new EntryError("invalid", message, { [field]: message });

/**
 * Runs a command on a locked proposal. Afterwards, in the same transaction,
 * readiness is updated: the decider is told if the write made the proposal
 * ready to decide.
 */
async function withProposal<T>(
  db: Database,
  actor: Actor,
  entryId: string,
  now: Date,
  run: (tx: Transaction, loaded: LoadedProposal) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const loaded = await loadProposal(tx, entryId, { lock: true });
    if (!loaded) throw new EntryError("not_found", "This proposal does not exist.");
    const result = await run(tx, loaded);
    await syncReadiness(tx, entryId, actor.personId, now);
    return result;
  });
}

function allow(allowed: boolean, message: string) {
  if (!allowed) throw forbidden(message);
}

const max = (a: string, b: string) => (a > b ? a : b);

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

async function validateDraftReferences(tx: Transaction, actor: Actor, input: ProposalDraftInput) {
  await assertActiveTeam(tx, input.teamId);
  await assertActiveTags(tx, input.tagIds);
  if (input.deciderId) await assertPeopleWithAccess(tx, "deciderId", [input.deciderId]);
  const consentGiverIds = input.reversibility === "one_way" ? input.consentGiverIds : [];
  await assertPeopleWithAccess(tx, "consentGiverIds", consentGiverIds);
  await assertPeopleWithAccess(tx, "feedbackGiverIds", input.feedbackGiverIds);
  if (consentGiverIds.includes(actor.personId)) throw invalid("consentGiverIds", "The proposer cannot be a consent giver.");
  await assertTeams(tx, "affectedTeamIds", input.affectedTeamIds);
  await assertPublishedEntries(tx, "relatedIds", input.relatedIds);
  if (input.supersedesId) await assertSupersedable(tx, input.supersedesId, { reversibility: input.reversibility, proposal: true });
}

async function writeDraftChildren(tx: Transaction, actor: Actor, entryId: string, input: ProposalDraftInput, now: Date) {
  const consentGiverIds = input.reversibility === "one_way" ? input.consentGiverIds : [];
  await tx.delete(participant).where(eq(participant.entryId, entryId));
  const participants = [
    ...consentGiverIds.map((personId) => ({ personId, role: "consent_giver" as const })),
    ...input.feedbackGiverIds.map((personId) => ({ personId, role: "feedback_giver" as const })),
  ];
  if (participants.length > 0) {
    await tx.insert(participant).values(participants.map((p) => ({ ...p, entryId, addedById: actor.personId, addedAt: now })));
  }
  await setAffectedTeams(tx, entryId, input.affectedTeamIds);
  await setTags(tx, entryId, input.tagIds);
  await setRelations(tx, entryId, input.relatedIds);
}

/** Creates a private draft, or saves changes to the actor's own draft. */
export async function saveDraft(db: Database, actor: Actor, input: ProposalDraftInput, draftId?: string, now = new Date()) {
  return db.transaction(async (tx) => {
    await validateDraftReferences(tx, actor, input);
    const periods = await getDefaultPeriods(tx);
    const feedbackDeadline = input.feedbackDeadline ?? defaultFeedbackDeadline(input.reversibility, periods, serverDate(now));
    const entryValues = {
      title: input.title,
      // Questions may be longer than a summary.
      summary: input.summary ?? clipText(input.question, SUMMARY_MAX),
      body: input.body ?? "",
      impact: input.impact ?? null,
      teamId: input.teamId,
      links: input.links.map((url) => ({ url })),
      supersedesId: input.supersedesId ?? null,
      updatedAt: now,
    };
    const decisionValues = {
      reversibility: input.reversibility,
      reversibilityReason: input.reversibility === "one_way" ? (input.reversibilityReason ?? null) : null,
      deciderId: input.deciderId ?? actor.personId,
      howDecided: "integrative_process" as const,
      reviewDate: input.reviewDate ?? null,
      updatedAt: now,
    };
    const proposalValues = {
      question: input.question,
      feedbackDeadline,
      objectionPeriodDays: input.objectionPeriodDays,
      updatedAt: now,
    };

    if (draftId) {
      const [current] = await tx.select().from(entry).where(eq(entry.id, draftId)).for("update");
      const [isProposal] = current ? await tx.select({ id: proposal.entryId }).from(proposal).where(eq(proposal.entryId, draftId)) : [];
      if (!current || !isProposal) throw new EntryError("not_found", "This draft does not exist.");
      if (current.authorId !== actor.personId) throw forbidden("Only the proposer can edit a draft.");
      if (current.status !== "draft") throw forbidden("A submitted proposal changes through new versions.");
      await tx.update(entry).set(entryValues).where(eq(entry.id, draftId));
      await tx.update(decision).set(decisionValues).where(eq(decision.entryId, draftId));
      await tx.update(proposal).set(proposalValues).where(eq(proposal.entryId, draftId));
      await tx
        .update(proposalVersion)
        .set({ text: input.proposalText ?? "" })
        .where(and(eq(proposalVersion.entryId, draftId), eq(proposalVersion.number, 1)));
      await writeDraftChildren(tx, actor, draftId, input, now);
      return { id: current.id, number: current.number };
    }

    const [created] = await tx
      .insert(entry)
      .values({ ...entryValues, type: "decision", status: "draft", authorId: actor.personId, createdAt: now })
      .returning({ id: entry.id, number: entry.number });
    if (!created) throw new Error("Could not create the draft");
    await tx.insert(decision).values({ ...decisionValues, entryId: created.id });
    await tx.insert(proposal).values({ ...proposalValues, entryId: created.id, currentVersion: 1 });
    await tx.insert(proposalVersion).values({
      entryId: created.id,
      number: 1,
      text: input.proposalText ?? "",
      createdById: actor.personId,
      createdAt: now,
    });
    await writeDraftChildren(tx, actor, created.id, input, now);
    return created;
  });
}

/** Deletes an unsubmitted draft (the only deletion Logbuch allows). */
export async function discardDraft(db: Database, actor: Actor, entryId: string) {
  await db.transaction(async (tx) => {
    const [current] = await tx.select().from(entry).where(eq(entry.id, entryId)).for("update");
    const [isProposal] = current ? await tx.select({ id: proposal.entryId }).from(proposal).where(eq(proposal.entryId, entryId)) : [];
    if (!current || !isProposal || current.status !== "draft") throw new EntryError("not_found", "This draft does not exist.");
    if (current.authorId !== actor.personId) throw forbidden("Only the proposer can discard a draft.");
    await tx.delete(entryAffectedTeam).where(eq(entryAffectedTeam.entryId, entryId));
    await tx.delete(entryTag).where(eq(entryTag.entryId, entryId));
    await tx.delete(entryRelation).where(eq(entryRelation.entryId, entryId));
    await tx.delete(participant).where(eq(participant.entryId, entryId));
    await tx.delete(proposalVersion).where(eq(proposalVersion.entryId, entryId));
    await tx.delete(proposal).where(eq(proposal.entryId, entryId));
    await tx.delete(decision).where(eq(decision.entryId, entryId));
    await tx.delete(entry).where(eq(entry.id, entryId));
  });
}

/** Problems that keep a draft from being submitted, by field. */
export async function submissionErrors(tx: Database | Transaction, loaded: LoadedProposal, now: Date): Promise<Record<string, string>> {
  const { proposal: p, decision: d, entry: e, snapshot: s } = loaded;
  const errors: Record<string, string> = {};
  const [version] = await tx
    .select({ text: proposalVersion.text })
    .from(proposalVersion)
    .where(and(eq(proposalVersion.entryId, p.entryId), eq(proposalVersion.number, 1)));
  if (!e.body.trim()) errors.body = "Describe the context: why this matters now.";
  if (!version?.text.trim()) errors.proposalText = "Write the proposal.";
  if (!e.impact) errors.impact = "Choose the impact.";
  if (!s.deciderHasAccess) errors.deciderId = "Choose a decider who has access.";
  if (s.reversibility === "one_way") {
    if (!d.reversibilityReason?.trim()) errors.reversibilityReason = "Explain why the decision is hard to reverse.";
    const givers = s.participants.filter((x) => x.role === "consent_giver");
    if (givers.length === 0) errors.consentGiverIds = "A one-way proposal needs at least one consent giver.";
    else if (givers.some((x) => !x.hasAccess)) errors.consentGiverIds = "Every consent giver needs access.";
  }
  const minimum = minimumFeedbackDeadline(s.reversibility, serverDate(now));
  if (p.feedbackDeadline < minimum) errors.feedbackDeadline = `The feedback deadline must be ${minimum} or later.`;
  if (p.objectionPeriodDays < MINIMUM_PERIODS[s.reversibility].objection) {
    errors.objectionPeriodDays = `At least ${MINIMUM_PERIODS[s.reversibility].objection} working days.`;
  }
  return errors;
}

/** Submits a draft: the feedback phase starts and everyone with access can see it. */
export async function submitProposal(db: Database, actor: Actor, entryId: string, now = new Date()) {
  return withProposal(db, actor, entryId, now, async (tx, loaded) => {
    allow(permissions(loaded.snapshot, actor, now).submit, "Only the proposer can submit a draft.");
    const errors = await submissionErrors(tx, loaded, now);
    if (loaded.entry.supersedesId) {
      await assertSupersedable(tx, loaded.entry.supersedesId, { reversibility: loaded.snapshot.reversibility, proposal: true }).catch((error: unknown) => {
        if (error instanceof EntryError) Object.assign(errors, error.fieldErrors);
        else throw error;
      });
    }
    if (Object.keys(errors).length > 0) throw new EntryError("invalid", "The proposal is not complete yet.", errors);

    await tx
      .update(entry)
      .set({ status: "feedback", submittedAt: now, publishedAt: now, personalDataConfirmedAt: now, updatedAt: now })
      .where(eq(entry.id, entryId));
    await tx.update(proposalVersion).set({ personalDataConfirmedAt: now }).where(eq(proposalVersion.id, loaded.currentVersionId));
    await refreshSearchText(tx, entryId);
    await recordAudit(tx, {
      actorId: actor.personId,
      action: "proposal.submitted",
      entryId,
      payload: { reversibility: loaded.snapshot.reversibility, feedbackDeadline: loaded.proposal.feedbackDeadline },
    });
    await notifyProposal(tx, entryId, actor.personId, { type: "submitted" }, now);
  });
}

// ---------------------------------------------------------------------------
// Versions and responses
// ---------------------------------------------------------------------------

/** A new version of the proposal text. For one-way, every earlier Go must be given again. */
export async function addVersion(db: Database, actor: Actor, entryId: string, input: VersionInput, now = new Date()) {
  return withProposal(db, actor, entryId, now, async (tx, loaded) => {
    allow(permissions(loaded.snapshot, actor, now).newVersion, "Only the proposer adds versions while the proposal is open.");
    const number = loaded.proposal.currentVersion + 1;
    await tx.insert(proposalVersion).values({
      entryId,
      number,
      text: input.proposalText,
      changeNote: input.changeNote ?? null,
      createdById: actor.personId,
      personalDataConfirmedAt: now,
      createdAt: now,
    });
    await tx.update(proposal).set({ currentVersion: number, updatedAt: now }).where(eq(proposal.entryId, entryId));
    await tx.update(entry).set({ updatedAt: now }).where(eq(entry.id, entryId));
    await refreshSearchText(tx, entryId);
    await recordAudit(tx, { actorId: actor.personId, action: "proposal.version_added", entryId, payload: { version: number } });
    await notifyProposal(tx, entryId, actor.personId, { type: "version", version: number }, now);
    return number;
  });
}

const RESPONSE_AUDIT = {
  question: "proposal.question_asked",
  feedback: "proposal.feedback_given",
  objection: "proposal.objection_raised",
} as const;

/** A question, feedback, or objection on the current version. */
export async function postResponse(db: Database, actor: Actor, entryId: string, input: ResponseInput, now = new Date()) {
  return withProposal(db, actor, entryId, now, async (tx, loaded) => {
    const p = permissions(loaded.snapshot, actor, now);
    const allowed = { question: p.ask, feedback: p.giveFeedback, objection: p.object }[input.kind];
    const message = {
      question: "Questions are possible while the proposal is open.",
      feedback: "Feedback is possible in the feedback phase.",
      objection: "Objections are possible in the objection round.",
    }[input.kind];
    allow(allowed, message);
    const [created] = await tx
      .insert(response)
      .values({ entryId, personId: actor.personId, kind: input.kind, versionId: loaded.currentVersionId, text: input.text, createdAt: now })
      .returning({ id: response.id });
    await tx.update(entry).set({ updatedAt: now }).where(eq(entry.id, entryId));
    await recordAudit(tx, { actorId: actor.personId, action: RESPONSE_AUDIT[input.kind], entryId, payload: { responseId: created?.id } });
    if (created && input.kind !== "feedback") {
      await notifyProposal(tx, entryId, actor.personId, { type: input.kind, responseId: created.id }, now);
    }
    return created;
  });
}

export async function answerQuestion(db: Database, actor: Actor, entryId: string, input: { questionId: string; text: string }, now = new Date()) {
  return withProposal(db, actor, entryId, now, async (tx, loaded) => {
    allow(permissions(loaded.snapshot, actor, now).answer, "The proposer answers questions while the proposal is open.");
    const question = loaded.snapshot.responses.find((r) => r.id === input.questionId && r.kind === "question");
    if (!question) throw invalid("questionId", "This question does not exist.");
    if (loaded.snapshot.responses.some((r) => r.kind === "answer" && r.parentId === question.id)) {
      throw invalid("questionId", "This question has been answered.");
    }
    await tx.insert(response).values({
      entryId,
      personId: actor.personId,
      kind: "answer",
      versionId: loaded.currentVersionId,
      text: input.text,
      parentId: question.id,
      createdAt: now,
    });
    await recordAudit(tx, { actorId: actor.personId, action: "proposal.question_answered", entryId, payload: { questionId: question.id } });
  });
}

/**
 * A Go on the version the person read (one-way: consent givers; two-way:
 * requested people). If a newer version was added meanwhile, the Go is refused.
 */
export async function giveGo(db: Database, actor: Actor, entryId: string, input: { text?: string; version: number }, now = new Date()) {
  return withProposal(db, actor, entryId, now, async (tx, loaded) => {
    allow(permissions(loaded.snapshot, actor, now).go, "You cannot give a Go on this proposal now.");
    if (input.version !== loaded.proposal.currentVersion) {
      throw invalid("version", `Version ${loaded.proposal.currentVersion} was added after you opened the page. Read it, then give your Go.`);
    }
    await tx.insert(response).values({
      entryId,
      personId: actor.personId,
      kind: "go",
      versionId: loaded.currentVersionId,
      text: input.text ?? "",
      createdAt: now,
    });
    await recordAudit(tx, { actorId: actor.personId, action: "proposal.go_given", entryId, payload: { version: loaded.proposal.currentVersion } });
  });
}

/** Withdraws the actor's Go; allowed until publication. */
export async function withdrawGo(db: Database, actor: Actor, entryId: string, now = new Date()) {
  return withProposal(db, actor, entryId, now, async (tx, loaded) => {
    allow(permissions(loaded.snapshot, actor, now).withdrawGo, "There is no Go to withdraw.");
    await tx
      .update(response)
      .set({ withdrawnAt: now })
      .where(and(eq(response.entryId, entryId), eq(response.personId, actor.personId), eq(response.kind, "go"), isNull(response.withdrawnAt)));
    await recordAudit(tx, { actorId: actor.personId, action: "proposal.go_withdrawn", entryId });
  });
}

/** The objector marks their objection resolved. */
export async function resolveObjection(
  db: Database,
  actor: Actor,
  entryId: string,
  input: { responseId: string; note?: string },
  now = new Date(),
) {
  return withProposal(db, actor, entryId, now, async (tx, loaded) => {
    const objection = loaded.snapshot.responses.find((r) => r.id === input.responseId && r.kind === "objection");
    if (!objection) throw invalid("responseId", "This objection does not exist.");
    allow(objection.personId === actor.personId, "Only the person who raised an objection can resolve it.");
    allow(loaded.snapshot.status === "feedback" || loaded.snapshot.status === "objection_round", "The proposal is closed.");
    if (objection.resolvedAt || objection.withdrawnAt) throw invalid("responseId", "This objection is already resolved.");
    await tx
      .update(response)
      .set({ resolvedAt: now, resolvedById: actor.personId, resolutionNote: input.note ?? null })
      .where(eq(response.id, objection.id));
    await recordAudit(tx, { actorId: actor.personId, action: "proposal.objection_resolved", entryId, payload: { responseId: objection.id } });
  });
}

// ---------------------------------------------------------------------------
// Phases and deadlines
// ---------------------------------------------------------------------------

/** The objection deadline is set now, from the period in working days. */
export async function startObjectionRound(db: Database, actor: Actor, entryId: string, now = new Date()) {
  return withProposal(db, actor, entryId, now, async (tx, loaded) => {
    const check = permissions(loaded.snapshot, actor, now).startObjectionRound;
    if (!check.ok) throw new EntryError(actor.personId === loaded.snapshot.proposerId ? "invalid" : "forbidden", check.reason ?? "Not possible now.");
    const objectionDeadline = addWorkingDays(serverDate(now), loaded.proposal.objectionPeriodDays);
    await tx.update(entry).set({ status: "objection_round", updatedAt: now }).where(eq(entry.id, entryId));
    await tx
      .update(proposal)
      .set({ objectionRoundStartedAt: now, objectionDeadline, updatedAt: now })
      .where(eq(proposal.entryId, entryId));
    await recordAudit(tx, { actorId: actor.personId, action: "proposal.objection_round_started", entryId, payload: { objectionDeadline } });
    await notifyProposal(tx, entryId, actor.personId, { type: "objection_round" }, now);
    return objectionDeadline;
  });
}

/** Deadlines can be extended, never shortened. */
export async function extendDeadline(
  db: Database,
  actor: Actor,
  entryId: string,
  input: { phase: "feedback" | "objection"; deadline: string },
  now = new Date(),
) {
  return withProposal(db, actor, entryId, now, async (tx, loaded) => {
    const p = permissions(loaded.snapshot, actor, now);
    if (input.phase === "feedback") {
      allow(p.extendFeedbackDeadline, "The proposer extends the feedback deadline during the feedback phase.");
      if (input.deadline <= loaded.proposal.feedbackDeadline) throw invalid("deadline", "Choose a date after the current deadline.");
      await tx.update(proposal).set({ feedbackDeadline: input.deadline, updatedAt: now }).where(eq(proposal.entryId, entryId));
    } else {
      allow(p.extendObjectionDeadline, "The proposer extends the objection deadline during the objection round.");
      if (!loaded.proposal.objectionDeadline || input.deadline <= loaded.proposal.objectionDeadline) {
        throw invalid("deadline", "Choose a date after the current deadline.");
      }
      await tx.update(proposal).set({ objectionDeadline: input.deadline, updatedAt: now }).where(eq(proposal.entryId, entryId));
    }
    const from = input.phase === "feedback" ? loaded.proposal.feedbackDeadline : loaded.proposal.objectionDeadline;
    await recordAudit(tx, { actorId: actor.personId, action: "proposal.deadline_extended", entryId, payload: { phase: input.phase, from, to: input.deadline } });
    await notifyProposal(tx, entryId, actor.personId, { type: "deadline_extended", phase: input.phase, deadline: input.deadline }, now);
  });
}

/**
 * Two-way to one-way is allowed until publication and needs consent givers;
 * during the objection round the proposal returns to Feedback with at least 5
 * working days. One-way to two-way only in the feedback phase, with a reason;
 * consent givers become feedback givers.
 */
export async function changeReversibility(db: Database, actor: Actor, entryId: string, input: ChangeReversibilityInput, now = new Date()) {
  return withProposal(db, actor, entryId, now, async (tx, loaded) => {
    const { snapshot: s, proposal: p } = loaded;
    allow(permissions(s, actor, now).changeReversibility, "Two-way or one-way cannot be changed now.");
    if (input.to === s.reversibility) throw invalid("to", `The proposal is already ${input.to === "one_way" ? "one-way" : "two-way"}.`);
    // A one-way decision can only be replaced through a one-way proposal.
    if (loaded.entry.supersedesId) await assertSupersedable(tx, loaded.entry.supersedesId, { reversibility: input.to, proposal: true });
    const today = serverDate(now);

    if (input.to === "one_way") {
      if (!input.reversibilityReason) throw invalid("reversibilityReason", "Explain why the decision is hard to reverse.");
      const existing = s.participants.filter((x) => x.role === "consent_giver").map((x) => x.personId);
      const added = input.consentGiverIds.filter((id) => !existing.includes(id));
      if (existing.length + added.length === 0) throw invalid("consentGiverIds", "A one-way proposal needs at least one consent giver.");
      if (added.includes(s.proposerId)) throw invalid("consentGiverIds", "The proposer cannot be a consent giver.");
      await assertPeopleWithAccess(tx, "consentGiverIds", added);
      if (added.length > 0) {
        await tx
          .insert(participant)
          .values(added.map((personId) => ({ entryId, personId, role: "consent_giver" as const, addedById: actor.personId, addedAt: now })));
      }
      const minimumFrom = s.status === "objection_round" ? today : (s.submittedOn ?? today);
      const feedbackDeadline = max(p.feedbackDeadline, addWorkingDays(minimumFrom, MINIMUM_PERIODS.one_way.feedback));
      await tx
        .update(decision)
        .set({ reversibility: "one_way", reversibilityReason: input.reversibilityReason, updatedAt: now })
        .where(eq(decision.entryId, entryId));
      await tx
        .update(proposal)
        .set({
          feedbackDeadline,
          objectionPeriodDays: Math.max(p.objectionPeriodDays, MINIMUM_PERIODS.one_way.objection),
          objectionRoundStartedAt: null,
          objectionDeadline: null,
          // Gos given under two-way rules are not binding consent.
          goResetAt: now,
          updatedAt: now,
        })
        .where(eq(proposal.entryId, entryId));
      if (s.status === "objection_round") {
        await tx.update(entry).set({ status: "feedback", updatedAt: now }).where(eq(entry.id, entryId));
      }
    } else {
      const givers = s.participants.filter((x) => x.role === "consent_giver").map((x) => x.personId);
      if (givers.length > 0) {
        await tx
          .update(participant)
          .set({ removedAt: now, removedById: actor.personId, removalReason: "Changed to two-way" })
          .where(and(eq(participant.entryId, entryId), eq(participant.role, "consent_giver"), isNull(participant.removedAt)));
        const feedbackGivers = s.participants.filter((x) => x.role === "feedback_giver").map((x) => x.personId);
        const toAdd = givers.filter((id) => !feedbackGivers.includes(id));
        if (toAdd.length > 0) {
          await tx
            .insert(participant)
            .values(toAdd.map((personId) => ({ entryId, personId, role: "feedback_giver" as const, addedById: actor.personId, addedAt: now })));
        }
      }
      await tx.update(decision).set({ reversibility: "two_way", reversibilityReason: null, updatedAt: now }).where(eq(decision.entryId, entryId));
      await tx.update(proposal).set({ updatedAt: now }).where(eq(proposal.entryId, entryId));
    }
    await recordAudit(tx, {
      actorId: actor.personId,
      action: "proposal.type_changed",
      entryId,
      payload: { from: s.reversibility, to: input.to, reason: input.reason, backToFeedback: s.status === "objection_round" },
    });
    if (input.to === "one_way") {
      await notifyProposal(tx, entryId, actor.personId, { type: "one_way", at: now, backToFeedback: s.status === "objection_round" }, now);
    }
  });
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export async function addParticipant(
  db: Database,
  actor: Actor,
  entryId: string,
  input: { personId: string; role: "consent_giver" | "feedback_giver" },
  now = new Date(),
) {
  return withProposal(db, actor, entryId, now, async (tx, loaded) => {
    const { snapshot: s } = loaded;
    allow(permissions(s, actor, now).manageParticipants, "The proposer manages participants while the proposal is open.");
    if (input.role === "consent_giver" && s.reversibility !== "one_way") throw invalid("role", "Only one-way proposals have consent givers.");
    if (input.role === "consent_giver" && input.personId === s.proposerId) throw invalid("personId", "The proposer cannot be a consent giver.");
    if (s.participants.some((x) => x.personId === input.personId && x.role === input.role)) throw invalid("personId", "This person is already listed.");
    await assertPeopleWithAccess(tx, "personId", [input.personId]);
    await tx.insert(participant).values({ entryId, personId: input.personId, role: input.role, addedById: actor.personId, addedAt: now });
    await recordAudit(tx, { actorId: actor.personId, action: "proposal.participant_added", entryId, payload: { personId: input.personId, role: input.role } });
    await notifyProposal(tx, entryId, actor.personId, { type: "participant_added", personId: input.personId, role: input.role, at: now }, now);
  });
}

/**
 * Removal rules: the proposer removes people in the
 * feedback phase; a consent giver in the objection round only by the decider
 * with a reason; never while that person has an open objection, except by an
 * admin with a reason. A one-way proposal keeps at least one consent giver.
 */
export async function removeParticipant(
  db: Database,
  actor: Actor,
  entryId: string,
  input: { personId: string; role: "consent_giver" | "feedback_giver"; reason?: string },
  now = new Date(),
) {
  return withProposal(db, actor, entryId, now, async (tx, loaded) => {
    const { snapshot: s } = loaded;
    const p = permissions(s, actor, now);
    const listed = s.participants.some((x) => x.personId === input.personId && x.role === input.role);
    if (!listed) throw invalid("personId", "This person is not listed.");

    if (input.role === "feedback_giver") {
      allow(p.manageParticipants || p.adminOverride, "The proposer manages participants while the proposal is open.");
    } else {
      const byProposer = p.manageParticipants && s.status === "feedback";
      const byDecider = p.removeConsentGiverInObjectionRound;
      allow(byProposer || byDecider || p.adminOverride, "In the objection round, only the decider can remove a consent giver.");
      if ((byDecider || (p.adminOverride && !byProposer)) && !input.reason) throw invalid("reason", "Give a reason.");
      const hasOpenObjection = openObjections(s).some((r) => r.personId === input.personId);
      if (hasOpenObjection && !(p.adminOverride && input.reason)) {
        throw invalid("personId", "This person has an open objection. Only an admin can remove them, with a reason.");
      }
      if (s.participants.filter((x) => x.role === "consent_giver").length === 1) {
        throw invalid("personId", "A one-way proposal needs a consent giver. Add another one first.");
      }
    }
    await tx
      .update(participant)
      .set({ removedAt: now, removedById: actor.personId, removalReason: input.reason ?? null })
      .where(
        and(eq(participant.entryId, entryId), eq(participant.personId, input.personId), eq(participant.role, input.role), isNull(participant.removedAt)),
      );
    await recordAudit(tx, {
      actorId: actor.personId,
      action: "proposal.participant_removed",
      entryId,
      payload: { personId: input.personId, role: input.role, reason: input.reason ?? null },
    });
  });
}

/** An admin replaces a consent giver in a stuck process, with a recorded reason. */
export async function replaceConsentGiver(
  db: Database,
  actor: Actor,
  entryId: string,
  input: { personId: string; replacementId: string; reason: string },
  now = new Date(),
) {
  return withProposal(db, actor, entryId, now, async (tx, loaded) => {
    const { snapshot: s } = loaded;
    allow(permissions(s, actor, now).adminOverride, "Only an admin can replace a consent giver.");
    if (!isConsentGiver(s, input.personId)) throw invalid("personId", "This person is not a consent giver.");
    if (isConsentGiver(s, input.replacementId)) throw invalid("replacementId", "This person is already a consent giver.");
    if (input.replacementId === s.proposerId) throw invalid("replacementId", "The proposer cannot be a consent giver.");
    await assertPeopleWithAccess(tx, "replacementId", [input.replacementId]);
    await tx
      .update(participant)
      .set({ removedAt: now, removedById: actor.personId, removalReason: input.reason })
      .where(and(eq(participant.entryId, entryId), eq(participant.personId, input.personId), eq(participant.role, "consent_giver"), isNull(participant.removedAt)));
    await tx
      .insert(participant)
      .values({ entryId, personId: input.replacementId, role: "consent_giver", addedById: actor.personId, addedAt: now });
    await recordAudit(tx, {
      actorId: actor.personId,
      action: "proposal.participant_removed",
      entryId,
      payload: { personId: input.personId, role: "consent_giver", reason: input.reason, replacedBy: input.replacementId },
    });
    await recordAudit(tx, { actorId: actor.personId, action: "proposal.participant_added", entryId, payload: { personId: input.replacementId, role: "consent_giver" } });
    await notifyProposal(tx, entryId, actor.personId, { type: "participant_added", personId: input.replacementId, role: "consent_giver", at: now }, now);
  });
}

/** The proposer changes the decider in the feedback phase; afterwards only an admin, with a reason. */
export async function changeDecider(db: Database, actor: Actor, entryId: string, input: { deciderId: string; reason?: string }, now = new Date()) {
  return withProposal(db, actor, entryId, now, async (tx, loaded) => {
    const { snapshot: s } = loaded;
    const byProposer = actor.personId === s.proposerId && s.status === "feedback";
    allow(permissions(s, actor, now).changeDecider, "The decider cannot be changed now.");
    if (!byProposer && !input.reason) throw invalid("reason", "Give a reason.");
    if (input.deciderId === s.deciderId) throw invalid("deciderId", "This person is already the decider.");
    await assertPeopleWithAccess(tx, "deciderId", [input.deciderId]);
    // readySince starts again, so a new decider of a ready proposal is told.
    await tx.update(decision).set({ deciderId: input.deciderId, updatedAt: now }).where(eq(decision.entryId, entryId));
    await tx.update(proposal).set({ readySince: null, updatedAt: now }).where(eq(proposal.entryId, entryId));
    await recordAudit(tx, {
      actorId: actor.personId,
      action: "proposal.decider_changed",
      entryId,
      payload: { from: s.deciderId, to: input.deciderId, reason: input.reason ?? null },
    });
    await notifyProposal(tx, entryId, actor.personId, { type: "decider_changed", at: now }, now);
  });
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

/** The decider publishes the decision once the criteria are met. */
export async function publishDecision(db: Database, actor: Actor, entryId: string, input: PublishInput, now = new Date()) {
  return withProposal(db, actor, entryId, now, async (tx, loaded) => {
    const { snapshot: s } = loaded;
    allow(actor.personId === s.deciderId, "Only the decider publishes the decision.");
    const ready = readiness(s, now);
    if (!ready.ready) throw new EntryError("invalid", "The publish criteria are not met yet.");
    if (objectionHandlingRequired(s) && !input.objectionHandling) {
      throw invalid("objectionHandling", "Explain how the objections were addressed.");
    }
    if (loaded.entry.supersedesId) await assertSupersedable(tx, loaded.entry.supersedesId, { reversibility: s.reversibility, proposal: true });

    await tx
      .update(entry)
      .set({ status: "decided", summary: input.summary, rationale: input.rationale, personalDataConfirmedAt: now, updatedAt: now })
      .where(eq(entry.id, entryId));
    await tx.update(decision).set({ effectiveDate: input.effectiveDate ?? null, updatedAt: now }).where(eq(decision.entryId, entryId));
    await tx.insert(outcome).values({
      entryId,
      result: "adopted",
      finalText: input.finalText,
      objectionHandling: input.objectionHandling ?? null,
      decidedById: actor.personId,
      decidedOn: serverDate(now),
      personalDataConfirmedAt: now,
      createdAt: now,
    });
    if (loaded.entry.supersedesId) await markSuperseded(tx, actor.personId, loaded.entry.supersedesId, entryId, now);
    await refreshSearchText(tx, entryId);
    await recordAudit(tx, { actorId: actor.personId, action: "proposal.decided", entryId, payload: { version: s.currentVersion } });
    await requestWebhook(tx, entryId, now);
    await notifyProposal(tx, entryId, actor.personId, { type: "closed", result: "decided" }, now);
  });
}

async function close(
  tx: Transaction,
  actor: Actor,
  loaded: LoadedProposal,
  result: "rejected" | "withdrawn",
  rationale: string,
  now: Date,
) {
  const entryId = loaded.entry.id;
  await tx.update(entry).set({ status: result, rationale, personalDataConfirmedAt: now, updatedAt: now }).where(eq(entry.id, entryId));
  await tx.insert(outcome).values({
    entryId,
    result,
    finalText: "",
    decidedById: actor.personId,
    decidedOn: serverDate(now),
    personalDataConfirmedAt: now,
    createdAt: now,
  });
  await refreshSearchText(tx, entryId);
  await recordAudit(tx, { actorId: actor.personId, action: result === "rejected" ? "proposal.rejected" : "proposal.withdrawn", entryId });
  // Withdrawn proposals are not sent to the webhook.
  if (result === "rejected") await requestWebhook(tx, entryId, now);
  await notifyProposal(tx, entryId, actor.personId, { type: "closed", result }, now);
}

/** The only way to reject a proposal: the decider, with a rationale. */
export async function rejectProposal(db: Database, actor: Actor, entryId: string, input: { rationale: string }, now = new Date()) {
  return withProposal(db, actor, entryId, now, async (tx, loaded) => {
    allow(permissions(loaded.snapshot, actor, now).reject, "Only the decider rejects an open proposal.");
    await close(tx, actor, loaded, "rejected", input.rationale, now);
  });
}

export async function withdrawProposal(db: Database, actor: Actor, entryId: string, input: { reason?: string }, now = new Date()) {
  return withProposal(db, actor, entryId, now, async (tx, loaded) => {
    allow(permissions(loaded.snapshot, actor, now).withdraw, "Only the proposer withdraws an open proposal.");
    await close(tx, actor, loaded, "withdrawn", input.reason ?? "", now);
  });
}
