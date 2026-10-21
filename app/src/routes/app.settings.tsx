/**
 * Settings: staff, teams, price floor %, routing rules and saved replies (`/s/me`, `/s/staff`, `/s/teams`,
 * `/s/settings`, `/s/saved-replies`). Writes are manager or admin only (`canEditSettings`); everyone can manage
 * their own saved replies, and only managers can share them.
 */
import { useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { useLoaderData } from "react-router";
import type { RoutingRule, SavedReply, StaffMember, StaffRole, StaffSettings, Team } from "../lib/api-client";
import { getBrowserClients } from "../lib/browser-client";
import {
  editableReplies,
  isDefaultTeam,
  parseOptionalFloor,
  permissionsFor,
  ruleTarget,
  teamDeleteMessage,
  toSavedReplyInputs,
  toSettingsPayload,
  toggleTeam,
  upsertRule,
  validateFloorPct,
} from "../lib/staff";
import { ErrorBanner, LoadingPage, errorMessage } from "../components/common";

export const clientLoader = async () => {
  const { staff: api } = getBrowserClients();
  const [me, settings, staff, teams, replies] = await Promise.all([
    api.me(),
    api.getSettings(),
    api.listStaff().then((r) => r.items),
    api.listTeams().then((r) => r.items),
    api.listSavedReplies().then((r) => r.items),
  ]);
  return { me, settings, staff, teams, replies };
};
clientLoader.hydrate = true as const;

export function HydrateFallback() {
  return <LoadingPage heading="Settings" />;
}

export default function SettingsRoute() {
  const data = useLoaderData<typeof clientLoader>();
  return <Settings data={data} />;
}

type SettingsData = Awaited<ReturnType<typeof clientLoader>>;

const ROLES: { id: StaffRole; label: string }[] = [
  { id: "rep", label: "Rep" },
  { id: "manager", label: "Manager" },
  { id: "admin", label: "Admin" },
];

function Settings({ data }: { data: SettingsData }) {
  const shopify = useAppBridge();
  const { staff: api } = getBrowserClients();
  const perms = permissionsFor(data.me);
  const readOnly = !perms.canEditSettings;

  const [cfg, setCfg] = useState<StaffSettings>(data.settings);
  const [floorText, setFloorText] = useState(String(data.settings.defaultPriceFloorPct));
  const [staff, setStaff] = useState<StaffMember[]>(data.staff);
  const [teams, setTeams] = useState<Team[]>(data.teams);
  const [replies, setReplies] = useState<SavedReply[]>(data.replies);
  const [newTeam, setNewTeam] = useState("");
  const [renames, setRenames] = useState<Record<string, string>>({});
  const [newReply, setNewReply] = useState({ title: "", body: "", shared: false });
  const [newRule, setNewRule] = useState({ companyId: "", companyName: "", target: "" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const floor = validateFloorPct(floorText);
  const staffName = (id: string | null | undefined) => staff.find((m) => m.id === id)?.name ?? "Rep";

  const run = async (name: string, fn: () => Promise<void>, onError: (e: unknown) => string = errorMessage) => {
    setBusy(name);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(onError(e));
    } finally {
      setBusy(null);
    }
  };

  const reloadTeams = async () => setTeams((await api.listTeams()).items);

  const saveSettings = () =>
    run("settings", async () => {
      if (!floor.ok) throw new Error(floor.error);
      const saved = await api.putSettings(toSettingsPayload(cfg, floor.value));
      setCfg(saved);
      setFloorText(String(saved.defaultPriceFloorPct));
      shopify.toast.show("Settings saved");
    });

  const patchStaff = (id: string, patch: Parameters<typeof api.updateStaff>[1]) =>
    run(`staff-${id}`, async () => {
      const updated = await api.updateStaff(id, patch);
      setStaff((list) => list.map((m) => (m.id === id ? updated : m)));
      if (patch.teamIds) await reloadTeams();
    });

  const addTeam = () =>
    run("team-add", async () => {
      const name = newTeam.trim();
      if (!name) return;
      const t = await api.createTeam({ name });
      setTeams((l) => [...l, t]);
      setNewTeam("");
    });

  const renameTeam = (id: string) =>
    run(`team-${id}`, async () => {
      const name = (renames[id] ?? "").trim();
      if (!name) return;
      const t = await api.updateTeam(id, { name });
      setTeams((l) => l.map((x) => (x.id === id ? t : x)));
      setRenames(({ [id]: _drop, ...rest }) => rest);
    });

  const removeTeam = (id: string) =>
    run(
      `team-${id}`,
      async () => {
        await api.deleteTeam(id);
        setTeams((l) => l.filter((t) => t.id !== id));
        setStaff((l) => l.map((m) => ({ ...m, teamIds: m.teamIds.filter((x) => x !== id) })));
      },
      teamDeleteMessage,
    );

  const addRule = () => {
    const { companyId, companyName, target } = newRule;
    if (!companyId.trim() || !target) {
      setError("Company ID and an assignee are required for a routing rule.");
      return;
    }
    const rule: RoutingRule = { companyId: companyId.trim(), companyName: companyName.trim() || companyId.trim(), ...ruleTarget(target) };
    setCfg((c) => ({ ...c, routing: { ...c.routing, rules: upsertRule(c.routing.rules, rule) } }));
    setNewRule({ companyId: "", companyName: "", target: "" });
  };

  /** Full replace of what the caller may edit (personal replies; managers also the shared ones). */
  const saveReplies = (next: SavedReply[] | { title: string; body: string; shared: boolean }[]) =>
    run("replies", async () => {
      const saved = await api.putSavedReplies(toSavedReplyInputs(next as SavedReply[], perms.canManageSharedReplies));
      setReplies(saved.items);
      shopify.toast.show("Saved replies updated");
    });

  const assigneeName = (r: RoutingRule) =>
    r.repId ? staffName(r.repId) : (teams.find((t) => t.id === r.teamId)?.name ?? "Team");

  const mine = editableReplies(replies, perms.canManageSharedReplies);
  const readOnlyShared = replies.filter((r) => !mine.includes(r));

  return (
    <s-page heading="Settings" inlineSize="large">
      <s-button slot="primary-action" variant="primary" onClick={saveSettings} loading={busy === "settings"} disabled={!floor.ok || readOnly}>
        Save settings
      </s-button>

      <ErrorBanner message={error} onDismiss={() => setError(null)} />
      {readOnly ? (
        <s-banner tone="info" heading="View only">
          Only managers and admins can change the price floor, routing, staff and teams. You can still manage your own saved replies.
        </s-banner>
      ) : null}

      <s-section heading="Price floor">
        <s-stack gap="base">
          <s-text color="subdued">
            Minimum margin on each line, as a percent of the quote price. Lines below the floor, or with an unknown cost, cannot be sent
            without manager approval. A rep&apos;s personal floor (Staff, below) overrides this default. The server enforces it on send.
          </s-text>
          <s-text-field
            label="Default price floor (%)"
            value={floorText}
            error={floor.ok ? undefined : floor.error}
            disabled={readOnly}
            onInput={(e) => setFloorText(e.currentTarget.value)}
          />
        </s-stack>
      </s-section>

      <s-section heading="Routing">
        <s-stack gap="base">
          <s-select
            label="Default team for new submissions"
            value={cfg.routing.defaultTeamId ?? ""}
            disabled={readOnly}
            onChange={(e) => setCfg((c) => ({ ...c, routing: { ...c.routing, defaultTeamId: e.currentTarget.value || null } }))}
          >
            <s-option value="">No default team</s-option>
            {teams.map((t) => (
              <s-option key={t.id} value={t.id}>
                {t.name}
              </s-option>
            ))}
          </s-select>
          <s-switch
            label="Auto-assign by company"
            details="When on, new quotes from the companies below go straight to the listed rep or team. When off, the rules are kept but ignored."
            checked={cfg.routing.autoAssignByCompany}
            disabled={readOnly}
            onChange={(e) => setCfg((c) => ({ ...c, routing: { ...c.routing, autoAssignByCompany: e.currentTarget.checked } }))}
          />
          {cfg.routing.rules.length > 0 ? (
            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">Company</s-table-header>
                <s-table-header>Assign to</s-table-header>
                <s-table-header>Remove</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {cfg.routing.rules.map((r) => (
                  <s-table-row key={r.companyId}>
                    <s-table-cell>{r.companyName ?? r.companyId}</s-table-cell>
                    <s-table-cell>{assigneeName(r)}</s-table-cell>
                    <s-table-cell>
                      <s-button
                        variant="tertiary"
                        tone="critical"
                        icon="delete"
                        accessibilityLabel={`Remove rule for ${r.companyName ?? r.companyId}`}
                        disabled={readOnly}
                        onClick={() =>
                          setCfg((c) => ({ ...c, routing: { ...c.routing, rules: c.routing.rules.filter((x) => x.companyId !== r.companyId) } }))
                        }
                      />
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          ) : (
            <s-text color="subdued">No company rules yet.</s-text>
          )}
          <s-grid gridTemplateColumns="repeat(auto-fit, minmax(180px, 1fr))" gap="small" alignItems="end">
            <s-text-field
              label="Company ID"
              details="gid://shopify/Company/..."
              value={newRule.companyId}
              disabled={readOnly}
              onInput={(e) => setNewRule((r) => ({ ...r, companyId: e.currentTarget.value }))}
            />
            <s-text-field
              label="Company name (for this list)"
              value={newRule.companyName}
              disabled={readOnly}
              onInput={(e) => setNewRule((r) => ({ ...r, companyName: e.currentTarget.value }))}
            />
            <s-select label="Assign to" value={newRule.target} disabled={readOnly} onChange={(e) => setNewRule((r) => ({ ...r, target: e.currentTarget.value }))}>
              <s-option value="">Choose…</s-option>
              {staff
                .filter((m) => m.active)
                .map((m) => (
                  <s-option key={m.id} value={`rep:${m.id}`}>
                    {m.name}
                  </s-option>
                ))}
              {teams.map((t) => (
                <s-option key={t.id} value={`team:${t.id}`}>
                  {t.name} (team)
                </s-option>
              ))}
            </s-select>
            <s-button onClick={addRule} disabled={readOnly}>
              Add rule
            </s-button>
          </s-grid>
          <s-text color="subdued">Rules are saved with “Save settings” (the whole settings object is replaced).</s-text>
        </s-stack>
      </s-section>

      <s-section heading="Staff" padding="none">
        {staff.length === 0 ? (
          <s-box padding="base">
            <s-text color="subdued">No staff yet.</s-text>
          </s-box>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Name</s-table-header>
              <s-table-header>Role</s-table-header>
              <s-table-header>Teams</s-table-header>
              <s-table-header format="numeric">Personal floor %</s-table-header>
              <s-table-header>Active</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {staff.map((m) => (
                <StaffRow
                  key={`${m.id}-${m.priceFloorPct ?? "default"}`}
                  m={m}
                  teams={teams}
                  defaultFloor={floor.ok ? floor.value : data.settings.defaultPriceFloorPct}
                  disabled={readOnly || busy === `staff-${m.id}`}
                  onPatch={(p) => patchStaff(m.id, p)}
                  onError={setError}
                />
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section heading="Teams">
        <s-stack gap="base">
          {teams.length === 0 ? <s-text color="subdued">No teams yet.</s-text> : null}
          {teams.map((t) => {
            const isDefault = isDefaultTeam(cfg, t.id);
            const name = renames[t.id] ?? t.name;
            return (
              <s-stack key={t.id} direction="inline" gap="small" justifyContent="space-between" alignItems="end">
                <s-text-field
                  label={`Team name`}
                  labelAccessibilityVisibility="exclusive"
                  value={name}
                  disabled={readOnly}
                  details={`${t.memberIds.length} member${t.memberIds.length === 1 ? "" : "s"}${isDefault ? " · default team" : ""}`}
                  onInput={(e) => setRenames((r) => ({ ...r, [t.id]: e.currentTarget.value }))}
                />
                <s-stack direction="inline" gap="small-300">
                  <s-button
                    disabled={readOnly || name.trim() === "" || name.trim() === t.name}
                    loading={busy === `team-${t.id}`}
                    onClick={() => renameTeam(t.id)}
                  >
                    Rename
                  </s-button>
                  <s-button
                    variant="tertiary"
                    tone="critical"
                    disabled={readOnly || isDefault}
                    accessibilityLabel={isDefault ? `${t.name} is the default team and cannot be deleted` : `Delete ${t.name}`}
                    onClick={() => removeTeam(t.id)}
                  >
                    Delete
                  </s-button>
                </s-stack>
              </s-stack>
            );
          })}
          <s-stack direction="inline" gap="small" alignItems="end">
            <s-text-field label="New team" value={newTeam} disabled={readOnly} onInput={(e) => setNewTeam(e.currentTarget.value)} />
            <s-button onClick={addTeam} loading={busy === "team-add"} disabled={readOnly || newTeam.trim() === ""}>
              Add team
            </s-button>
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading="Saved replies" id="saved-replies">
        <s-stack gap="base">
          <s-text color="subdued">
            Insert these in the conversation. Personal replies are only yours
            {perms.canManageSharedReplies ? "; shared replies are visible to all staff." : "; shared replies are managed by managers."}
          </s-text>
          {readOnlyShared.map((r) => (
            <s-stack key={r.id} gap="small-500">
              <s-stack direction="inline" gap="small-300">
                <s-text type="strong">{r.title}</s-text>
                <s-badge>Shared</s-badge>
              </s-stack>
              <s-text color="subdued">{r.body}</s-text>
            </s-stack>
          ))}
          {mine.map((r) => (
            <s-stack key={r.id} direction="inline" justifyContent="space-between" alignItems="center">
              <s-stack gap="small-500">
                <s-stack direction="inline" gap="small-300">
                  <s-text type="strong">{r.title}</s-text>
                  {r.shared ? <s-badge>Shared</s-badge> : null}
                </s-stack>
                <s-text color="subdued">{r.body}</s-text>
              </s-stack>
              <s-button variant="tertiary" tone="critical" loading={busy === "replies"} onClick={() => saveReplies(mine.filter((x) => x.id !== r.id))}>
                Delete
              </s-button>
            </s-stack>
          ))}
          <s-divider />
          <s-text-field label="Title" value={newReply.title} onInput={(e) => setNewReply((r) => ({ ...r, title: e.currentTarget.value }))} />
          <s-text-area label="Reply text" rows={2} value={newReply.body} onInput={(e) => setNewReply((r) => ({ ...r, body: e.currentTarget.value }))} />
          {perms.canManageSharedReplies ? (
            <s-switch
              label="Share with all staff"
              checked={newReply.shared}
              onChange={(e) => setNewReply((r) => ({ ...r, shared: e.currentTarget.checked }))}
            />
          ) : null}
          <s-button
            disabled={!newReply.title.trim() || !newReply.body.trim()}
            loading={busy === "replies"}
            onClick={async () => {
              await saveReplies([...mine, { title: newReply.title.trim(), body: newReply.body.trim(), shared: newReply.shared }]);
              setNewReply({ title: "", body: "", shared: false });
            }}
          >
            Add saved reply
          </s-button>
        </s-stack>
      </s-section>
    </s-page>
  );
}

function StaffRow({
  m,
  teams,
  defaultFloor,
  disabled,
  onPatch,
  onError,
}: {
  m: StaffMember;
  teams: Team[];
  defaultFloor: number;
  disabled: boolean;
  onPatch: (p: { role?: StaffRole; teamIds?: string[]; priceFloorPct?: number | null; active?: boolean }) => void;
  onError: (msg: string | null) => void;
}) {
  const [floorText, setFloorText] = useState(m.priceFloorPct === null || m.priceFloorPct === undefined ? "" : String(m.priceFloorPct));
  return (
    <s-table-row>
      <s-table-cell>
        <s-stack gap="small-500">
          <s-text type="strong">{m.name}</s-text>
          <s-text color="subdued">{m.email}</s-text>
        </s-stack>
      </s-table-cell>
      <s-table-cell>
        <s-select
          label={`Role for ${m.name}`}
          labelAccessibilityVisibility="exclusive"
          value={m.role}
          disabled={disabled}
          onChange={(e) => onPatch({ role: e.currentTarget.value as StaffRole })}
        >
          {ROLES.map((r) => (
            <s-option key={r.id} value={r.id}>
              {r.label}
            </s-option>
          ))}
        </s-select>
      </s-table-cell>
      <s-table-cell>
        <s-stack gap="small-500">
          {teams.length === 0 ? <s-text color="subdued">No teams</s-text> : null}
          {teams.map((t) => (
            <s-checkbox
              key={t.id}
              label={t.name}
              checked={m.teamIds.includes(t.id)}
              disabled={disabled}
              onChange={(e) => onPatch({ teamIds: toggleTeam(m.teamIds, t.id, e.currentTarget.checked) })}
            />
          ))}
        </s-stack>
      </s-table-cell>
      <s-table-cell>
        <s-text-field
          label={`Price floor for ${m.name}`}
          labelAccessibilityVisibility="exclusive"
          placeholder={`Default (${defaultFloor})`}
          value={floorText}
          disabled={disabled}
          onInput={(e) => setFloorText(e.currentTarget.value)}
          onBlur={() => {
            const v = parseOptionalFloor(floorText);
            if (!v.ok) {
              onError(`${m.name}: ${v.error}`);
              setFloorText(m.priceFloorPct === null || m.priceFloorPct === undefined ? "" : String(m.priceFloorPct));
            } else if (v.value !== (m.priceFloorPct ?? null)) {
              onPatch({ priceFloorPct: v.value });
            }
          }}
        />
      </s-table-cell>
      <s-table-cell>
        <s-switch
          label={`${m.name} is active`}
          labelAccessibilityVisibility="exclusive"
          checked={m.active}
          disabled={disabled}
          onChange={(e) => onPatch({ active: e.currentTarget.checked })}
        />
      </s-table-cell>
    </s-table-row>
  );
}
