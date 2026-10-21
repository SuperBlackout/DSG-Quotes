/**
 * PROPOSED contract additions. NOT in docs/openapi.yaml yet (CLAUDE.md rule 9: the lead owns the contract).
 * The settings page, rep/team pickers, the "Me" filter and saved replies need these. Every consumer must
 * tolerate failure (404 from the real API / Prism mock) and fall back to defaults, see `safe()`.
 *
 *   GET  /s/me                    -> StaffMe
 *   GET  /s/staff                 -> { items: StaffMember[] }
 *   PUT  /s/staff/{id}            -> StaffMember           body: StaffMemberPatch
 *   GET  /s/teams                 -> { items: Team[] }
 *   POST /s/teams                 -> Team                  body: { name }
 *   PUT  /s/teams/{id}            -> Team                  body: { name }
 *   DELETE /s/teams/{id}          -> 204
 *   GET  /s/settings              -> QuoteSettings
 *   PUT  /s/settings              -> QuoteSettings         body: QuoteSettings
 *   GET  /s/saved-replies         -> { items: SavedReply[] }
 *   PUT  /s/saved-replies         -> { items: SavedReply[] } body: { items: SavedReply[] }
 *
 * Also wanted on existing schemas: `rep=me` documented on GET /s/quotes (this module assumes the literal
 * `me` and `unassigned` are accepted), and `q` on GET /s/quotes matching the display number (Q-10482).
 */
import type { StaffClient } from "./api-client";

export interface StaffMe {
  id: string;
  name: string;
  email: string;
  isManager: boolean;
  teamId: string | null;
  /** Rep's personal floor %, falls back to the shop default. */
  priceFloorPct: number;
}

export interface StaffMember {
  id: string;
  name: string;
  email: string;
  isManager: boolean;
  teamId: string | null;
  priceFloorPct: number;
}

export interface StaffMemberPatch {
  isManager?: boolean;
  teamId?: string | null;
  priceFloorPct?: number;
}

export interface Team {
  id: string;
  name: string;
  memberCount?: number;
}

export interface AutoAssignRule {
  companyId: string;
  companyName: string;
  repId: string | null;
  teamId: string | null;
}

export interface QuoteSettings {
  /** Default price floor % (minimum margin) for reps without a personal override. */
  defaultPriceFloorPct: number;
  routing: {
    defaultTeamId: string | null;
    autoAssignByCompany: boolean;
    rules: AutoAssignRule[];
  };
}

export interface SavedReply {
  id: string;
  title: string;
  body: string;
}

export const DEFAULT_SETTINGS: QuoteSettings = {
  defaultPriceFloorPct: 15,
  routing: { defaultTeamId: null, autoAssignByCompany: false, rules: [] },
};

/** Used when /s/saved-replies is unavailable. Mirrors the mockup. */
export const DEFAULT_SAVED_REPLIES: SavedReply[] = [
  { id: "default-freight", title: "Freight is LTL to site", body: "Freight is LTL (less-than-truckload) delivered to the job site; the carrier will call to schedule a delivery window." },
  { id: "default-held", title: "Price held 14 days", body: "Pricing on this quote is held for 14 days from the date sent." },
];

/** Run a call to an endpoint that may not exist yet. Returns the fallback instead of throwing. */
export async function safe<T>(call: () => Promise<T>, fallback: T): Promise<{ data: T; available: boolean }> {
  try {
    return { data: await call(), available: true };
  } catch {
    return { data: fallback, available: false };
  }
}

export function createSettingsClient(c: StaffClient) {
  return {
    me: () => c.raw<StaffMe>("GET", "/s/me"),
    listStaff: () => c.raw<{ items: StaffMember[] }>("GET", "/s/staff"),
    updateStaff: (id: string, patch: StaffMemberPatch) =>
      c.raw<StaffMember>("PUT", `/s/staff/${encodeURIComponent(id)}`, patch),
    listTeams: () => c.raw<{ items: Team[] }>("GET", "/s/teams"),
    createTeam: (name: string) => c.raw<Team>("POST", "/s/teams", { name }),
    renameTeam: (id: string, name: string) => c.raw<Team>("PUT", `/s/teams/${encodeURIComponent(id)}`, { name }),
    deleteTeam: (id: string) => c.raw<void>("DELETE", `/s/teams/${encodeURIComponent(id)}`),
    getSettings: () => c.raw<QuoteSettings>("GET", "/s/settings"),
    putSettings: (s: QuoteSettings) => c.raw<QuoteSettings>("PUT", "/s/settings", s),
    listSavedReplies: () => c.raw<{ items: SavedReply[] }>("GET", "/s/saved-replies"),
    putSavedReplies: (items: SavedReply[]) => c.raw<{ items: SavedReply[] }>("PUT", "/s/saved-replies", { items }),
  };
}

export type SettingsClient = ReturnType<typeof createSettingsClient>;

/** Validation for the settings form (pure, tested). */
export function validateFloorPct(input: string): { ok: true; value: number } | { ok: false; error: string } {
  const n = Number(input.trim());
  if (input.trim() === "" || !Number.isFinite(n)) return { ok: false, error: "Enter a percentage, e.g. 15" };
  if (n < 0 || n >= 100) return { ok: false, error: "Must be at least 0 and less than 100" };
  return { ok: true, value: Math.round(n * 100) / 100 };
}
