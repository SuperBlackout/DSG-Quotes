/**
 * Pure helpers for the staff-facing parts of the contract (GET /s/me, staff, teams, settings, saved replies,
 * customer search). No React, no I/O.
 */
import { ApiError, type RoutingRule, type SavedReply, type SavedReplyInput, type StaffMe, type StaffSettings, type Team } from "./api-client";

/* ------------------------------------------------------------------------------------ permissions */

export interface Permissions {
  /** May call `approve-floor`. Reps request approval instead. */
  canApproveFloor: boolean;
  /** May write settings, teams and staff. */
  canEditSettings: boolean;
  /** May create or edit shared saved replies. */
  canManageSharedReplies: boolean;
}

/**
 * Role and capability flags from `GET /s/me`. The server flags win; the role is the fallback when the optional
 * flags are absent. Before `me` has loaded nothing is allowed (hide, never show then retract).
 */
export function permissionsFor(me: Pick<StaffMe, "role" | "canApproveFloor" | "canEditSettings"> | null | undefined): Permissions {
  if (!me) return { canApproveFloor: false, canEditSettings: false, canManageSharedReplies: false };
  const elevated = me.role === "manager" || me.role === "admin";
  return {
    canApproveFloor: me.canApproveFloor ?? elevated,
    canEditSettings: me.canEditSettings ?? elevated,
    canManageSharedReplies: elevated,
  };
}

/* ---------------------------------------------------------------------------------------- floors */

/** Validation for a floor percentage typed by a user (pure, tested). */
export function validateFloorPct(input: string): { ok: true; value: number } | { ok: false; error: string } {
  const n = Number(input.trim());
  if (input.trim() === "" || !Number.isFinite(n)) return { ok: false, error: "Enter a percentage, e.g. 15" };
  if (n < 0 || n >= 100) return { ok: false, error: "Must be at least 0 and less than 100" };
  return { ok: true, value: Math.round(n * 100) / 100 };
}

/** A personal floor may be blank, which means "use the shop default" (`null` in `PUT /s/staff/{id}`). */
export function parseOptionalFloor(input: string): { ok: true; value: number | null } | { ok: false; error: string } {
  if (input.trim() === "") return { ok: true, value: null };
  return validateFloorPct(input);
}

/* ------------------------------------------------------------------------------------------ teams */

export const DEFAULT_TEAM_DELETE_MESSAGE =
  "This is the default team for new quotes. Pick a different default team under Routing, save settings, then delete it.";

/** Friendly message for a failed team delete. The API answers 400 when the team is the default team. */
export function teamDeleteMessage(e: unknown): string {
  if (e instanceof ApiError && e.status === 400) return DEFAULT_TEAM_DELETE_MESSAGE;
  if (e instanceof Error) return e.message;
  return "Could not delete the team.";
}

export function teamNames(ids: readonly string[], teams: readonly Pick<Team, "id" | "name">[]): string[] {
  return ids.map((id) => teams.find((t) => t.id === id)?.name).filter((n): n is string => !!n);
}

/** Toggle one team in a staff member's `teamIds` (no duplicates). */
export function toggleTeam(teamIds: readonly string[], teamId: string, on: boolean): string[] {
  const without = teamIds.filter((id) => id !== teamId);
  return on ? [...without, teamId] : without;
}

/* -------------------------------------------------------------------------------------- settings */

/** One rule per company: adding a rule for a company replaces the earlier one. */
export function upsertRule(rules: readonly RoutingRule[], rule: RoutingRule): RoutingRule[] {
  return [...rules.filter((r) => r.companyId !== rule.companyId), rule];
}

/** `rep:<id>` / `team:<id>` select values to a rule target. */
export function ruleTarget(value: string): { repId: string | null; teamId: string | null } {
  return {
    repId: value.startsWith("rep:") ? value.slice(4) : null,
    teamId: value.startsWith("team:") ? value.slice(5) : null,
  };
}

/** Body for `PUT /s/settings` (full replace). Read-only fields such as `companyName` are dropped. */
export function toSettingsPayload(s: StaffSettings, defaultPriceFloorPct: number): StaffSettings {
  return {
    defaultPriceFloorPct,
    routing: {
      defaultTeamId: s.routing.defaultTeamId ?? null,
      autoAssignByCompany: s.routing.autoAssignByCompany,
      rules: s.routing.rules.map((r) => ({
        ...(r.id ? { id: r.id } : {}),
        companyId: r.companyId,
        repId: r.repId ?? null,
        teamId: r.teamId ?? null,
      })),
    },
  };
}

/** The default team cannot be deleted; the UI disables the button instead of waiting for the 400. */
export function isDefaultTeam(settings: Pick<StaffSettings, "routing">, teamId: string): boolean {
  return settings.routing.defaultTeamId === teamId;
}

/* ---------------------------------------------------------------------------------- saved replies */

/** Replies the caller may replace with `PUT /s/saved-replies`: managers everything, reps only their personal ones. */
export function editableReplies(replies: readonly SavedReply[], canShare: boolean): SavedReply[] {
  return canShare ? [...replies] : replies.filter((r) => !r.shared);
}

/** Body items for `PUT /s/saved-replies`. `shared` is forced false for non-managers (the API answers 403 otherwise). */
export function toSavedReplyInputs(replies: readonly Pick<SavedReply, "id" | "title" | "body" | "shared">[], canShare: boolean): SavedReplyInput[] {
  return replies.map((r) => ({ id: r.id, title: r.title, body: r.body, shared: canShare ? r.shared : false }));
}

/* ------------------------------------------------------------------------------ customer search */

export const MIN_CUSTOMER_SEARCH = 2;
export const CUSTOMER_SEARCH_DEBOUNCE_MS = 300;

/** The server rejects `q` shorter than 2 characters, so the UI does not call it. */
export function canSearchCustomers(input: string): boolean {
  return input.trim().length >= MIN_CUSTOMER_SEARCH;
}
