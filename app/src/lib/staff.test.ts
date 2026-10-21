import { describe, expect, it } from "vitest";
import { ApiError } from "./api-client";
import {
  DEFAULT_TEAM_DELETE_MESSAGE,
  canSearchCustomers,
  editableReplies,
  isDefaultTeam,
  parseOptionalFloor,
  permissionsFor,
  ruleTarget,
  teamDeleteMessage,
  teamNames,
  toSavedReplyInputs,
  toSettingsPayload,
  toggleTeam,
  upsertRule,
  validateFloorPct,
} from "./staff";

describe("permissions from GET /s/me", () => {
  it("allows nothing before me has loaded", () => {
    expect(permissionsFor(null)).toEqual({ canApproveFloor: false, canEditSettings: false, canManageSharedReplies: false });
  });

  it("uses the server flags when present", () => {
    expect(permissionsFor({ role: "rep", canApproveFloor: false, canEditSettings: false })).toMatchObject({ canApproveFloor: false, canEditSettings: false });
    expect(permissionsFor({ role: "manager", canApproveFloor: true, canEditSettings: false })).toMatchObject({ canApproveFloor: true, canEditSettings: false });
  });

  it("falls back to the role when the flags are absent", () => {
    expect(permissionsFor({ role: "rep" })).toEqual({ canApproveFloor: false, canEditSettings: false, canManageSharedReplies: false });
    expect(permissionsFor({ role: "manager" })).toEqual({ canApproveFloor: true, canEditSettings: true, canManageSharedReplies: true });
    expect(permissionsFor({ role: "admin" }).canEditSettings).toBe(true);
  });
});

describe("floor percentages", () => {
  it("validates the default floor", () => {
    expect(validateFloorPct("15")).toEqual({ ok: true, value: 15 });
    expect(validateFloorPct(" 12.505 ")).toEqual({ ok: true, value: 12.51 });
    expect(validateFloorPct("")).toMatchObject({ ok: false });
    expect(validateFloorPct("abc")).toMatchObject({ ok: false });
    expect(validateFloorPct("100")).toMatchObject({ ok: false });
    expect(validateFloorPct("-1")).toMatchObject({ ok: false });
  });

  it("treats a blank personal floor as null (use the default)", () => {
    expect(parseOptionalFloor("")).toEqual({ ok: true, value: null });
    expect(parseOptionalFloor("  ")).toEqual({ ok: true, value: null });
    expect(parseOptionalFloor("20")).toEqual({ ok: true, value: 20 });
    expect(parseOptionalFloor("x")).toMatchObject({ ok: false });
  });
});

describe("teams", () => {
  it("explains a 400 when deleting the default team", () => {
    expect(teamDeleteMessage(new ApiError(400, "BAD_REQUEST", "Cannot delete the default team"))).toBe(DEFAULT_TEAM_DELETE_MESSAGE);
    expect(teamDeleteMessage(new ApiError(403, "FORBIDDEN", "Managers only"))).toBe("Managers only");
    expect(teamDeleteMessage("boom")).toBe("Could not delete the team.");
  });

  it("detects the default team", () => {
    const s = { routing: { defaultTeamId: "t1", autoAssignByCompany: false, rules: [] } };
    expect(isDefaultTeam(s, "t1")).toBe(true);
    expect(isDefaultTeam(s, "t2")).toBe(false);
  });

  it("toggles team membership without duplicates", () => {
    expect(toggleTeam(["a"], "b", true)).toEqual(["a", "b"]);
    expect(toggleTeam(["a", "b"], "b", true)).toEqual(["a", "b"]);
    expect(toggleTeam(["a", "b"], "a", false)).toEqual(["b"]);
  });

  it("names teams and skips unknown ids", () => {
    expect(teamNames(["a", "zz", "b"], [{ id: "a", name: "Sales" }, { id: "b", name: "Install" }])).toEqual(["Sales", "Install"]);
  });
});

describe("settings payload (PUT /s/settings is a full replace)", () => {
  it("replaces rules per company and strips read-only fields", () => {
    const rules = upsertRule(
      [{ companyId: "c1", companyName: "Old", repId: "r1", teamId: null }],
      { companyId: "c1", repId: null, teamId: "t1" },
    );
    expect(rules).toEqual([{ companyId: "c1", repId: null, teamId: "t1" }]);

    const body = toSettingsPayload(
      {
        defaultPriceFloorPct: 10,
        routing: { autoAssignByCompany: true, rules: [{ id: "x", companyId: "c9", companyName: "Pure Vision", repId: "r1" }, { companyId: "c2", teamId: "t1" }] },
      },
      15,
    );
    expect(body).toEqual({
      defaultPriceFloorPct: 15,
      routing: {
        defaultTeamId: null,
        autoAssignByCompany: true,
        rules: [
          { id: "x", companyId: "c9", repId: "r1", teamId: null },
          { companyId: "c2", repId: null, teamId: "t1" },
        ],
      },
    });
  });

  it("reads rep:/team: select values", () => {
    expect(ruleTarget("rep:r1")).toEqual({ repId: "r1", teamId: null });
    expect(ruleTarget("team:t1")).toEqual({ repId: null, teamId: "t1" });
    expect(ruleTarget("")).toEqual({ repId: null, teamId: null });
  });
});

describe("saved replies", () => {
  const replies = [
    { id: "1", title: "Shared", body: "a", shared: true },
    { id: "2", title: "Mine", body: "b", shared: false },
  ];

  it("lets reps replace only their personal replies; managers replace everything", () => {
    expect(editableReplies(replies, false).map((r) => r.id)).toEqual(["2"]);
    expect(editableReplies(replies, true).map((r) => r.id)).toEqual(["1", "2"]);
  });

  it("never sends shared: true for a non-manager", () => {
    expect(toSavedReplyInputs(replies, false).map((r) => r.shared)).toEqual([false, false]);
    expect(toSavedReplyInputs(replies, true).map((r) => r.shared)).toEqual([true, false]);
    expect(toSavedReplyInputs([{ id: "n", title: "t", body: "b", shared: false }], true)[0]).toEqual({ id: "n", title: "t", body: "b", shared: false });
  });
});

describe("customer search", () => {
  it("needs at least two characters after trimming", () => {
    expect(canSearchCustomers("")).toBe(false);
    expect(canSearchCustomers(" a ")).toBe(false);
    expect(canSearchCustomers("pu")).toBe(true);
  });
});
