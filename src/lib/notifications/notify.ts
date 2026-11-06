import { and, asc, eq, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import { isWorkingDay } from "@/lib/calendar";
import type { Database, Transaction } from "@/lib/db/client";
import { decision, entry, entryAffectedTeam, notificationDelivery, participant, person, proposal, team } from "@/lib/db/schema";
import { serverDate, serverHour } from "@/lib/format";
import { readiness } from "@/lib/process/rules";
import { loadProposal, type LoadedProposal } from "@/lib/process/snapshot";
import {
  planAddendum,
  planEntryPost,
  planProposalEvent,
  planReminders,
  planReviewReminder,
  type LostRole,
  type PlannedDelivery,
  type PostInfo,
  type ProposalEvent,
} from "./plan";

/*
 * Records notifications as `notification_delivery` rows. Commands call these
 * functions inside their transaction, so a notification exists exactly when
 * its write does. The worker sends the rows; nothing is sent here.
 */

type Db = Database | Transaction;

/** Reminder emails go out from 09:00 in the server's time zone. */
export const REMINDER_HOUR = 9;

/**
 * Inserts the planned deliveries for people with access, and channel posts
 * (no recipient). A known delivery key is ignored.
 */
export async function enqueue(db: Db, planned: PlannedDelivery[], now: Date): Promise<number> {
  if (planned.length === 0) return 0;
  const ids = [...new Set(planned.map((p) => p.recipientId).filter((id): id is string => id !== null))];
  const withAccess = new Set(
    ids.length === 0
      ? []
      : (await db.select({ id: person.id }).from(person).where(and(inArray(person.id, ids), eq(person.hasAccess, true)))).map((p) => p.id),
  );
  const values = planned
    .filter((p) => p.recipientId === null || withAccess.has(p.recipientId))
    .map((p) => ({
      deliveryKey: p.key,
      event: p.event,
      entryId: p.entryId,
      recipientId: p.recipientId,
      channel: p.channel,
      message: p.message,
      createdAt: now,
      nextAttemptAt: now,
    }));
  if (values.length === 0) return 0;
  const inserted = await db
    .insert(notificationDelivery)
    .values(values)
    .onConflictDoNothing({ target: notificationDelivery.deliveryKey })
    .returning({ id: notificationDelivery.id });
  return inserted.length;
}

async function nameOf(db: Db, personId: string): Promise<string> {
  const [row] = await db.select({ name: person.displayName }).from(person).where(eq(person.id, personId));
  return row?.name ?? "Someone";
}

const entryInfo = (loaded: LoadedProposal) => ({ id: loaded.entry.id, number: loaded.entry.number, title: loaded.entry.title });

async function affectedTeamNames(db: Db, entryId: string): Promise<string[]> {
  const rows = await db
    .select({ name: team.name })
    .from(entryAffectedTeam)
    .innerJoin(team, eq(team.id, entryAffectedTeam.teamId))
    .where(eq(entryAffectedTeam.entryId, entryId))
    .orderBy(asc(team.name));
  return rows.map((row) => row.name);
}

/** What the channel post of an entry says, as of now. */
async function postInfo(db: Db, row: { id: string; type: PostInfo["type"]; summary: string; impact: PostInfo["impact"] }): Promise<PostInfo> {
  return { type: row.type, summary: row.summary, impact: row.impact, affectedTeams: await affectedTeamNames(db, row.id) };
}

/** Records the channel post for a published update, learning, or logged decision. */
export async function notifyEntryPost(db: Db, entryId: string, actorId: string, now: Date): Promise<void> {
  const [row] = await db
    .select({ id: entry.id, number: entry.number, title: entry.title, type: entry.type, summary: entry.summary, impact: entry.impact })
    .from(entry)
    .where(eq(entry.id, entryId));
  if (!row) return;
  await enqueue(db, [planEntryPost(row, await postInfo(db, row), await nameOf(db, actorId))], now);
}

/** Records the Slack messages for an event on a proposal, as of the state after the write. */
export async function notifyProposal(db: Db, entryId: string, actorId: string | null, event: ProposalEvent, now: Date): Promise<void> {
  const loaded = await loadProposal(db, entryId);
  if (!loaded) return;
  const actor = actorId ? { personId: actorId, name: await nameOf(db, actorId) } : null;
  const post = await postInfo(db, loaded.entry);
  await enqueue(db, planProposalEvent({ entry: entryInfo(loaded), s: loaded.snapshot, actor, post }, event), now);
}

/**
 * Keeps `proposal.ready_since` in step with the publish criteria. When a
 * proposal becomes ready, the decider is told once, unless their own action
 * made it ready; when it stops being ready, the next time counts anew. Call it
 * in a transaction: it locks the proposal.
 */
export async function syncReadiness(tx: Transaction, entryId: string, actorId: string | null, now: Date): Promise<void> {
  const loaded = await loadProposal(tx, entryId, { lock: true });
  if (!loaded) return;
  const ready = loaded.snapshot.status === "objection_round" && readiness(loaded.snapshot, now).ready;
  const since = loaded.proposal.readySince;
  if (ready && since === null) {
    await tx.update(proposal).set({ readySince: now }).where(eq(proposal.entryId, entryId));
    const actor = actorId ? { personId: actorId, name: await nameOf(tx, actorId) } : null;
    const post = await postInfo(tx, loaded.entry);
    await enqueue(tx, planProposalEvent({ entry: entryInfo(loaded), s: loaded.snapshot, actor, post }, { type: "ready", since: now }), now);
  } else if (!ready && since !== null) {
    await tx.update(proposal).set({ readySince: null }).where(eq(proposal.entryId, entryId));
  }
}

/**
 * Records the Slack messages for a new addendum: the author, the decider, and
 * everyone listed on the entry.
 */
export async function notifyAddendum(db: Db, entryId: string, addendumId: string, actorId: string, now: Date): Promise<void> {
  const [target] = await db
    .select({ id: entry.id, number: entry.number, title: entry.title, authorId: entry.authorId, deciderId: decision.deciderId })
    .from(entry)
    .leftJoin(decision, eq(decision.entryId, entry.id))
    .where(eq(entry.id, entryId));
  if (!target) return;
  const listed = await db
    .select({ personId: participant.personId })
    .from(participant)
    .where(and(eq(participant.entryId, entryId), isNull(participant.removedAt)));
  const recipients = [target.authorId, ...(target.deciderId ? [target.deciderId] : []), ...listed.map((p) => p.personId)];
  const actor = { personId: actorId, name: await nameOf(db, actorId) };
  await enqueue(db, planAddendum(target, addendumId, actor, recipients), now);
}

const OPEN_STATUSES = ["feedback", "objection_round"] as const;

async function openProposalIds(db: Db, statuses: readonly ("feedback" | "objection_round")[] = OPEN_STATUSES): Promise<string[]> {
  const rows = await db
    .select({ id: entry.id })
    .from(entry)
    .innerJoin(proposal, eq(proposal.entryId, entry.id))
    .where(inArray(entry.status, [...statuses]))
    .orderBy(asc(entry.number));
  return rows.map((r) => r.id);
}

/**
 * Runs every few minutes in the worker: tells deciders about proposals that
 * became ready as time passed (and notes those that stopped being ready after
 * a directory sync), and proposers about participants who lost access.
 * Delivery keys make repeated runs harmless.
 */
export async function watchProposals(db: Database, now: Date): Promise<void> {
  for (const id of await openProposalIds(db, ["objection_round"])) {
    await db.transaction((tx) => syncReadiness(tx, id, null, now));
  }

  const listed = await db
    .select({ entryId: entry.id, personId: person.id, name: person.displayName, since: person.accessChangedAt, role: participant.role })
    .from(participant)
    .innerJoin(entry, eq(entry.id, participant.entryId))
    .innerJoin(person, eq(person.id, participant.personId))
    .where(
      and(
        isNull(participant.removedAt),
        inArray(participant.role, ["consent_giver", "feedback_giver"]),
        inArray(entry.status, [...OPEN_STATUSES]),
        eq(person.hasAccess, false),
      ),
    );
  const deciders = await db
    .select({ entryId: entry.id, personId: person.id, name: person.displayName, since: person.accessChangedAt })
    .from(proposal)
    .innerJoin(entry, eq(entry.id, proposal.entryId))
    .innerJoin(decision, eq(decision.entryId, proposal.entryId))
    .innerJoin(person, eq(person.id, decision.deciderId))
    .where(and(inArray(entry.status, [...OPEN_STATUSES]), eq(person.hasAccess, false)));

  const lost = new Map<string, { entryId: string; personId: string; name: string; since: Date; roles: LostRole[] }>();
  for (const row of [...deciders.map((d) => ({ ...d, role: "decider" as const })), ...listed]) {
    const key = `${row.entryId}:${row.personId}`;
    const current = lost.get(key) ?? { entryId: row.entryId, personId: row.personId, name: row.name, since: row.since, roles: [] };
    current.roles.push(row.role as LostRole);
    lost.set(key, current);
  }
  for (const item of lost.values()) {
    await notifyProposal(db, item.entryId, null, { type: "lost_access", personId: item.personId, name: item.name, roles: item.roles, since: item.since }, now);
  }
}

/**
 * Records the reminder emails due today. Runs at 09:00 on working days; a run
 * before 09:00 or on a weekend or holiday does nothing. Returns the number of
 * new deliveries.
 */
export async function recordReminders(db: Database, now: Date): Promise<number> {
  const today = serverDate(now);
  if (!isWorkingDay(today) || serverHour(now) < REMINDER_HOUR) return 0;
  let count = 0;
  for (const id of await openProposalIds(db)) {
    const loaded = await loadProposal(db, id);
    if (!loaded) continue;
    const planned = planReminders({ entry: entryInfo(loaded), s: loaded.snapshot, today, now, readySince: loaded.proposal.readySince });
    count += await enqueue(db, planned, now);
  }

  // Review dates of decisions still in force that have come, logged or
  // decided through a proposal; the delivery key sends each reminder once,
  // also when a decision was published late.
  const reviews = await db
    .select({
      id: entry.id,
      number: entry.number,
      title: entry.title,
      authorId: entry.authorId,
      deciderId: decision.deciderId,
      reviewDate: decision.reviewDate,
    })
    .from(decision)
    .innerJoin(entry, eq(entry.id, decision.entryId))
    .where(
      and(
        inArray(entry.status, ["published", "decided"]),
        isNull(entry.supersededById),
        isNotNull(decision.reviewDate),
        lte(decision.reviewDate, today),
      ),
    );
  for (const review of reviews) {
    const info = { id: review.id, number: review.number, title: review.title };
    count += await enqueue(db, planReviewReminder({ entry: info, deciderId: review.deciderId, authorId: review.authorId, reviewDate: review.reviewDate!, today }), now);
  }
  return count;
}
