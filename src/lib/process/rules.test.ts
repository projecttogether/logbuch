import { describe, expect, it } from "vitest";
import {
  blockingObjections,
  canStartObjectionRound,
  minimumFeedbackDeadline,
  objectionHandlingRequired,
  permissions,
  readiness,
  type ProposalSnapshot,
  type SnapshotResponse,
} from "./rules";

// Wednesday 2026-11-04, 10:00 in Amsterdam.
const NOW = new Date("2026-11-04T09:00:00Z");
const PAST = "2026-11-03";
const FUTURE = "2026-11-06";

const PROPOSER = "proposer";
const DECIDER = "decider";
const ANA = "ana";
const BEN = "ben";
const OTHER = "other";

let sequence = 0;
function response(personId: string, kind: SnapshotResponse["kind"], extra: Partial<SnapshotResponse> = {}): SnapshotResponse {
  sequence += 1;
  return {
    id: `r${sequence}`,
    personId,
    kind,
    versionNumber: 1,
    createdAt: new Date(Date.UTC(2026, 10, 3, 8, sequence)),
    resolvedAt: null,
    withdrawnAt: null,
    parentId: null,
    ...extra,
  };
}

function snapshot(overrides: Partial<ProposalSnapshot> = {}): ProposalSnapshot {
  return {
    status: "objection_round",
    reversibility: "two_way",
    proposerId: PROPOSER,
    deciderId: DECIDER,
    deciderHasAccess: true,
    submittedOn: "2026-10-28",
    feedbackDeadline: PAST,
    objectionPeriodDays: 1,
    objectionRoundStartedAt: new Date("2026-11-03T08:00:00Z"),
    objectionDeadline: FUTURE,
    currentVersion: 1,
    goResetAt: null,
    participants: [],
    responses: [],
    ...overrides,
  };
}

const feedbackGivers = [
  { personId: ANA, role: "feedback_giver" as const, hasAccess: true },
  { personId: BEN, role: "feedback_giver" as const, hasAccess: true },
];
const consentGivers = [
  { personId: ANA, role: "consent_giver" as const, hasAccess: true },
  { personId: BEN, role: "consent_giver" as const, hasAccess: true },
];

describe("start of the objection round", () => {
  const cases: [string, Partial<ProposalSnapshot>, boolean][] = [
    ["two-way, before the deadline, nobody asked", { reversibility: "two_way", feedbackDeadline: FUTURE }, false],
    ["two-way, after the deadline, nobody asked", { reversibility: "two_way", feedbackDeadline: PAST }, true],
    [
      "two-way, before the deadline, everyone asked gave feedback",
      { reversibility: "two_way", feedbackDeadline: FUTURE, participants: feedbackGivers, responses: [response(ANA, "feedback"), response(BEN, "feedback")] },
      true,
    ],
    [
      "two-way, before the deadline, one requested person is missing",
      { reversibility: "two_way", feedbackDeadline: FUTURE, participants: feedbackGivers, responses: [response(ANA, "feedback")] },
      false,
    ],
    [
      "one-way, before the deadline, even with all feedback",
      { reversibility: "one_way", feedbackDeadline: FUTURE, participants: consentGivers, responses: [response(ANA, "feedback"), response(BEN, "feedback")] },
      false,
    ],
    ["one-way, after the deadline", { reversibility: "one_way", feedbackDeadline: PAST, participants: consentGivers }, true],
    ["not in the feedback phase", { status: "objection_round", feedbackDeadline: PAST }, false],
  ];
  it.each(cases)("%s", (_name, overrides, expected) => {
    expect(canStartObjectionRound(snapshot({ status: "feedback", objectionRoundStartedAt: null, objectionDeadline: null, ...overrides }), NOW).ok).toBe(expected);
  });

  it("uses the end of the deadline day in the server's time zone", () => {
    const s = snapshot({ status: "feedback", feedbackDeadline: "2026-11-04", objectionRoundStartedAt: null, objectionDeadline: null });
    expect(canStartObjectionRound(s, new Date("2026-11-04T22:59:00Z")).ok).toBe(false);
    expect(canStartObjectionRound(s, new Date("2026-11-04T23:00:00Z")).ok).toBe(true);
  });
});

describe("readiness of a two-way decision", () => {
  const cases: [string, Partial<ProposalSnapshot>, boolean][] = [
    ["feedback phase", { status: "feedback" }, false],
    ["objection round, deadline ahead, nobody asked", { objectionDeadline: FUTURE }, false],
    ["objection round, deadline passed, nobody asked", { objectionDeadline: PAST }, true],
    [
      "deadline ahead, everyone asked answered with Go or objection",
      { objectionDeadline: FUTURE, participants: feedbackGivers, responses: [response(ANA, "go"), response(BEN, "objection")] },
      true,
    ],
    [
      "deadline ahead, one person asked has not answered",
      { objectionDeadline: FUTURE, participants: feedbackGivers, responses: [response(ANA, "go")] },
      false,
    ],
    [
      "deadline ahead, a withdrawn Go does not count",
      { objectionDeadline: FUTURE, participants: feedbackGivers, responses: [response(ANA, "go"), response(BEN, "go", { withdrawnAt: NOW })] },
      false,
    ],
    ["no answer by the deadline counts as no objection", { objectionDeadline: PAST, participants: feedbackGivers }, true],
    ["open objections do not block", { objectionDeadline: PAST, responses: [response(OTHER, "objection")] }, true],
    ["the decider lost access", { objectionDeadline: PAST, deciderHasAccess: false }, false],
  ];
  it.each(cases)("%s", (_name, overrides, expected) => {
    expect(readiness(snapshot({ reversibility: "two_way", ...overrides }), NOW).ready).toBe(expected);
  });
});

describe("readiness of a one-way decision", () => {
  const allGo = [response(ANA, "go"), response(BEN, "go")];
  const cases: [string, Partial<ProposalSnapshot>, boolean][] = [
    ["every consent giver gave a Go, period over", { responses: allGo }, true],
    ["every Go, but the objection period is not over", { objectionDeadline: FUTURE, responses: allGo }, false],
    ["no answer by the deadline does not count as a Go", { responses: [response(ANA, "go")] }, false],
    [
      "a Go on an older version does not count",
      { currentVersion: 2, responses: [response(ANA, "go", { versionNumber: 2 }), response(BEN, "go", { versionNumber: 1 })] },
      false,
    ],
    ["a withdrawn Go does not count", { responses: [response(ANA, "go"), response(BEN, "go", { withdrawnAt: NOW })] }, false],
    ["an open objection from a consent giver blocks", { responses: [...allGo, response(BEN, "objection")] }, false],
    [
      "a resolved objection does not block",
      { responses: [response(ANA, "go"), response(BEN, "objection", { resolvedAt: NOW }), response(BEN, "go")] },
      true,
    ],
    [
      "a later Go on the current version clears the objector's objection",
      { currentVersion: 2, responses: [response(BEN, "objection"), response(ANA, "go", { versionNumber: 2 }), response(BEN, "go", { versionNumber: 2 })] },
      true,
    ],
    ["an objection from someone else does not block", { responses: [...allGo, response(OTHER, "objection")] }, true],
    [
      "a consent giver without access must be replaced",
      { participants: [consentGivers[0]!, { ...consentGivers[1]!, hasAccess: false }], responses: allGo },
      false,
    ],
    ["without consent givers, nothing can be published", { participants: [], responses: [] }, false],
    [
      "a Go given before the proposal became one-way does not count",
      { goResetAt: new Date(Date.UTC(2026, 10, 3, 12)), responses: allGo },
      false,
    ],
  ];
  it.each(cases)("%s", (_name, overrides, expected) => {
    expect(readiness(snapshot({ reversibility: "one_way", objectionDeadline: PAST, participants: consentGivers, ...overrides }), NOW).ready).toBe(expected);
  });

  it("lists the open objections that block", () => {
    const s = snapshot({ reversibility: "one_way", participants: consentGivers, responses: [response(BEN, "objection"), response(OTHER, "objection")] });
    expect(blockingObjections(s).map((r) => r.personId)).toEqual([BEN]);
  });
});

describe("objections at publish time", () => {
  it("require an explanation for two-way decisions", () => {
    expect(objectionHandlingRequired(snapshot({ responses: [response(OTHER, "objection")] }))).toBe(true);
    expect(objectionHandlingRequired(snapshot({ responses: [response(OTHER, "objection", { withdrawnAt: NOW })] }))).toBe(false);
    expect(objectionHandlingRequired(snapshot({ responses: [] }))).toBe(false);
    expect(objectionHandlingRequired(snapshot({ reversibility: "one_way", responses: [response(OTHER, "objection")] }))).toBe(false);
  });
});

describe("minimum feedback deadline", () => {
  it("is 1 working day for two-way and 5 for one-way", () => {
    expect(minimumFeedbackDeadline("two_way", "2026-11-06")).toBe("2026-11-09");
    expect(minimumFeedbackDeadline("one_way", "2026-11-04")).toBe("2026-11-11");
  });
});

describe("permissions", () => {
  const actor = (personId: string, isAdmin = false) => ({ personId, isAdmin });

  it("let only consent givers give a Go on one-way proposals", () => {
    const s = snapshot({ reversibility: "one_way", participants: consentGivers });
    expect(permissions(s, actor(ANA), NOW).go).toBe(true);
    expect(permissions(s, actor(OTHER), NOW).go).toBe(false);
    expect(permissions(s, actor(OTHER), NOW).object).toBe(true);
  });

  it("ask a consent giver to confirm again after a new version", () => {
    const s = snapshot({ reversibility: "one_way", currentVersion: 2, participants: consentGivers, responses: [response(ANA, "go")] });
    expect(permissions(s, actor(ANA), NOW).go).toBe(true);
    const confirmed = snapshot({ ...s, responses: [response(ANA, "go", { versionNumber: 2 })] });
    expect(permissions(confirmed, actor(ANA), NOW)).toMatchObject({ go: false, withdrawGo: true });
  });

  it("let requested people answer two-way proposals with a Go", () => {
    const s = snapshot({ reversibility: "two_way", participants: feedbackGivers });
    expect(permissions(s, actor(ANA), NOW).go).toBe(true);
    expect(permissions(s, actor(OTHER), NOW).go).toBe(false);
  });

  it("let the decider publish only when ready, and reject while open", () => {
    expect(permissions(snapshot({ objectionDeadline: FUTURE }), actor(DECIDER), NOW)).toMatchObject({ publish: false, reject: true });
    expect(permissions(snapshot({ objectionDeadline: PAST }), actor(DECIDER), NOW)).toMatchObject({ publish: true, reject: true });
    expect(permissions(snapshot({ objectionDeadline: PAST }), actor(PROPOSER), NOW)).toMatchObject({ publish: false, reject: false, withdraw: true });
  });

  it("allow one-way to two-way only in the feedback phase; two-way to one-way until publication", () => {
    expect(permissions(snapshot({ reversibility: "one_way", status: "objection_round" }), actor(PROPOSER), NOW).changeReversibility).toBe(false);
    expect(permissions(snapshot({ reversibility: "one_way", status: "feedback" }), actor(PROPOSER), NOW).changeReversibility).toBe(true);
    expect(permissions(snapshot({ reversibility: "two_way", status: "objection_round" }), actor(PROPOSER), NOW).changeReversibility).toBe(true);
    expect(permissions(snapshot({ status: "decided" }), actor(PROPOSER), NOW).changeReversibility).toBe(false);
  });

  it("let the proposer change the decider in the feedback phase, afterwards only an admin", () => {
    expect(permissions(snapshot({ status: "feedback" }), actor(PROPOSER), NOW).changeDecider).toBe(true);
    expect(permissions(snapshot({ status: "objection_round" }), actor(PROPOSER), NOW).changeDecider).toBe(false);
    expect(permissions(snapshot({ status: "objection_round" }), actor(OTHER, true), NOW).changeDecider).toBe(true);
  });

  it("allow nothing on closed proposals", () => {
    const p = permissions(snapshot({ status: "decided" }), actor(PROPOSER), NOW);
    expect(Object.entries(p).filter(([, value]) => value === true)).toEqual([]);
  });
});
