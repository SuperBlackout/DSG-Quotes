/**
 * Settings: staff, teams, price floor %, routing. Uses the PROPOSED endpoints in ../lib/proposed-api.ts
 * (not yet in docs/openapi.yaml). When they are missing the page says so and stays read-only.
 */
import { useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { useLoaderData } from "react-router";
import { getBrowserClients } from "../lib/browser-client";
import {
  DEFAULT_SAVED_REPLIES,
  DEFAULT_SETTINGS,
  safe,
  validateFloorPct,
  type AutoAssignRule,
  type QuoteSettings,
  type SavedReply,
  type StaffMember,
  type Team,
} from "../lib/proposed-api";
import { ErrorBanner, LoadingPage, errorMessage } from "../components/common";

interface SettingsData {
  settings: QuoteSettings;
  staff: StaffMember[];
  teams: Team[];
  replies: SavedReply[];
  available: { settings: boolean; staff: boolean; teams: boolean; replies: boolean };
}

export const clientLoader = async (): Promise<SettingsData> => {
  const { settings: api } = getBrowserClients();
  const [s, st, t, r] = await Promise.all([
    safe(() => api.getSettings(), DEFAULT_SETTINGS),
    safe(() => api.listStaff().then((x) => x.items), [] as StaffMember[]),
    safe(() => api.listTeams().then((x) => x.items), [] as Team[]),
    safe(() => api.listSavedReplies().then((x) => x.items), DEFAULT_SAVED_REPLIES),
  ]);
  return {
    settings: s.data,
    staff: st.data,
    teams: t.data,
    replies: r.data,
    available: { settings: s.available, staff: st.available, teams: t.available, replies: r.available },
  };
};
clientLoader.hydrate = true as const;

export function HydrateFallback() {
  return <LoadingPage heading="Settings" />;
}

export default function SettingsRoute() {
  const data = useLoaderData<typeof clientLoader>();
  return <Settings data={data} />;
}

function Settings({ data }: { data: SettingsData }) {
  const shopify = useAppBridge();
  const { settings: api } = getBrowserClients();

  const [cfg, setCfg] = useState<QuoteSettings>(data.settings);
  const [floorText, setFloorText] = useState(String(data.settings.defaultPriceFloorPct));
  const [staff, setStaff] = useState<StaffMember[]>(data.staff);
  const [teams, setTeams] = useState<Team[]>(data.teams);
  const [replies, setReplies] = useState<SavedReply[]>(data.replies);
  const [newTeam, setNewTeam] = useState("");
  const [newReply, setNewReply] = useState({ title: "", body: "" });
  const [newRule, setNewRule] = useState<{ companyId: string; companyName: string; target: string }>({
    companyId: "",
    companyName: "",
    target: "",
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const floor = validateFloorPct(floorText);
  const unavailable = [
    !data.available.settings && "/s/settings",
    !data.available.staff && "/s/staff",
    !data.available.teams && "/s/teams",
  ].filter(Boolean);

  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const saveSettings = () =>
    run("settings", async () => {
      if (!floor.ok) throw new Error(floor.error);
      const saved = await api.putSettings({ ...cfg, defaultPriceFloorPct: floor.value });
      setCfg(saved);
      setFloorText(String(saved.defaultPriceFloorPct));
      shopify.toast.show("Settings saved");
    });

  const patchStaff = (id: string, patch: Parameters<typeof api.updateStaff>[1]) =>
    run(`staff-${id}`, async () => {
      const updated = await api.updateStaff(id, patch);
      setStaff((list) => list.map((m) => (m.id === id ? updated : m)));
    });

  const addTeam = () =>
    run("team-add", async () => {
      const name = newTeam.trim();
      if (!name) return;
      const t = await api.createTeam(name);
      setTeams((l) => [...l, t]);
      setNewTeam("");
    });

  const removeTeam = (id: string) =>
    run(`team-${id}`, async () => {
      await api.deleteTeam(id);
      setTeams((l) => l.filter((t) => t.id !== id));
      setCfg((c) => (c.routing.defaultTeamId === id ? { ...c, routing: { ...c.routing, defaultTeamId: null } } : c));
    });

  const addRule = () => {
    const { companyId, companyName, target } = newRule;
    if (!companyId.trim() || !target) {
      setError("Company ID and an assignee are required for a routing rule.");
      return;
    }
    const rule: AutoAssignRule = {
      companyId: companyId.trim(),
      companyName: companyName.trim() || companyId.trim(),
      repId: target.startsWith("rep:") ? target.slice(4) : null,
      teamId: target.startsWith("team:") ? target.slice(5) : null,
    };
    setCfg((c) => ({
      ...c,
      routing: { ...c.routing, rules: [...c.routing.rules.filter((r) => r.companyId !== rule.companyId), rule] },
    }));
    setNewRule({ companyId: "", companyName: "", target: "" });
  };

  const saveReplies = (next: SavedReply[]) =>
    run("replies", async () => {
      const saved = await api.putSavedReplies(next);
      setReplies(saved.items);
      shopify.toast.show("Saved replies updated");
    });

  const assigneeName = (r: AutoAssignRule) =>
    r.repId ? (staff.find((m) => m.id === r.repId)?.name ?? "Rep") : (teams.find((t) => t.id === r.teamId)?.name ?? "Team");

  return (
    <s-page heading="Settings" inlineSize="large">
      <s-button slot="primary-action" variant="primary" onClick={saveSettings} loading={busy === "settings"} disabled={!floor.ok || !data.available.settings}>
        Save settings
      </s-button>

      <ErrorBanner message={error} onDismiss={() => setError(null)} />
      {unavailable.length > 0 ? (
        <s-banner tone="warning" heading="Settings API not available yet">
          This page needs {unavailable.join(", ")} on the quotes API. Until the backend ships them, values shown are defaults and
          cannot be changed.
        </s-banner>
      ) : null}

      <s-section heading="Price floor">
        <s-stack gap="base">
          <s-text color="subdued">
            Minimum margin on each line, as a percent of the quote price. Lines below the floor cannot be sent without manager approval.
            The server enforces this on send.
          </s-text>
          <s-text-field
            label="Default price floor (%)"
            value={floorText}
            error={floor.ok ? undefined : floor.error}
            disabled={!data.available.settings}
            onInput={(e) => setFloorText(e.currentTarget.value)}
          />
        </s-stack>
      </s-section>

      <s-section heading="Routing">
        <s-stack gap="base">
          <s-select
            label="Default team for new submissions"
            value={cfg.routing.defaultTeamId ?? ""}
            disabled={!data.available.settings}
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
            details="New quotes from the companies below go straight to the listed rep or team."
            checked={cfg.routing.autoAssignByCompany}
            disabled={!data.available.settings}
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
                    <s-table-cell>{r.companyName}</s-table-cell>
                    <s-table-cell>{assigneeName(r)}</s-table-cell>
                    <s-table-cell>
                      <s-button
                        variant="tertiary"
                        tone="critical"
                        icon="delete"
                        accessibilityLabel={`Remove rule for ${r.companyName}`}
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
            <s-text-field label="Company ID" value={newRule.companyId} onInput={(e) => setNewRule((r) => ({ ...r, companyId: e.currentTarget.value }))} />
            <s-text-field label="Company name" value={newRule.companyName} onInput={(e) => setNewRule((r) => ({ ...r, companyName: e.currentTarget.value }))} />
            <s-select label="Assign to" value={newRule.target} onChange={(e) => setNewRule((r) => ({ ...r, target: e.currentTarget.value }))}>
              <s-option value="">Choose…</s-option>
              {staff.map((m) => (
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
            <s-button onClick={addRule}>Add rule</s-button>
          </s-grid>
          <s-text color="subdued">Rules are saved with “Save settings”.</s-text>
        </s-stack>
      </s-section>

      <s-section heading="Staff" padding="none">
        {staff.length === 0 ? (
          <s-box padding="base">
            <s-text color="subdued">No staff loaded.</s-text>
          </s-box>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Name</s-table-header>
              <s-table-header>Team</s-table-header>
              <s-table-header>Manager</s-table-header>
              <s-table-header format="numeric">Personal floor %</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {staff.map((m) => (
                <StaffRow key={m.id} m={m} teams={teams} busy={busy === `staff-${m.id}`} onPatch={(p) => patchStaff(m.id, p)} onError={setError} />
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section heading="Teams">
        <s-stack gap="base">
          {teams.map((t) => (
            <s-stack key={t.id} direction="inline" justifyContent="space-between" alignItems="center">
              <s-text>
                {t.name}
                {t.memberCount !== undefined ? ` · ${t.memberCount} member${t.memberCount === 1 ? "" : "s"}` : ""}
              </s-text>
              <s-button variant="tertiary" tone="critical" loading={busy === `team-${t.id}`} onClick={() => removeTeam(t.id)}>
                Delete
              </s-button>
            </s-stack>
          ))}
          <s-stack direction="inline" gap="small" alignItems="end">
            <s-text-field label="New team" value={newTeam} onInput={(e) => setNewTeam(e.currentTarget.value)} />
            <s-button onClick={addTeam} loading={busy === "team-add"} disabled={!data.available.teams || newTeam.trim() === ""}>
              Add team
            </s-button>
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading="Saved replies">
        <s-stack gap="base">
          {replies.map((r) => (
            <s-stack key={r.id} direction="inline" justifyContent="space-between" alignItems="center">
              <s-text>{r.title}</s-text>
              <s-button variant="tertiary" tone="critical" disabled={!data.available.replies} onClick={() => saveReplies(replies.filter((x) => x.id !== r.id))}>
                Delete
              </s-button>
            </s-stack>
          ))}
          <s-text-field label="Title" value={newReply.title} onInput={(e) => setNewReply((r) => ({ ...r, title: e.currentTarget.value }))} />
          <s-text-area label="Reply text" rows={2} value={newReply.body} onInput={(e) => setNewReply((r) => ({ ...r, body: e.currentTarget.value }))} />
          <s-button
            disabled={!data.available.replies || !newReply.title.trim() || !newReply.body.trim()}
            loading={busy === "replies"}
            onClick={async () => {
              await saveReplies([...replies, { id: `new-${Date.now()}`, title: newReply.title.trim(), body: newReply.body.trim() }]);
              setNewReply({ title: "", body: "" });
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
  busy,
  onPatch,
  onError,
}: {
  m: StaffMember;
  teams: Team[];
  busy: boolean;
  onPatch: (p: { teamId?: string | null; isManager?: boolean; priceFloorPct?: number }) => void;
  onError: (msg: string | null) => void;
}) {
  const [floorText, setFloorText] = useState(String(m.priceFloorPct));
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
          label={`Team for ${m.name}`}
          labelAccessibilityVisibility="exclusive"
          value={m.teamId ?? ""}
          disabled={busy}
          onChange={(e) => onPatch({ teamId: e.currentTarget.value || null })}
        >
          <s-option value="">No team</s-option>
          {teams.map((t) => (
            <s-option key={t.id} value={t.id}>
              {t.name}
            </s-option>
          ))}
        </s-select>
      </s-table-cell>
      <s-table-cell>
        <s-switch
          label={`${m.name} is a manager`}
          labelAccessibilityVisibility="exclusive"
          checked={m.isManager}
          disabled={busy}
          onChange={(e) => onPatch({ isManager: e.currentTarget.checked })}
        />
      </s-table-cell>
      <s-table-cell>
        <s-text-field
          label={`Price floor for ${m.name}`}
          labelAccessibilityVisibility="exclusive"
          value={floorText}
          disabled={busy}
          onInput={(e) => setFloorText(e.currentTarget.value)}
          onBlur={() => {
            const v = validateFloorPct(floorText);
            if (!v.ok) {
              onError(`${m.name}: ${v.error}`);
              setFloorText(String(m.priceFloorPct));
            } else if (v.value !== m.priceFloorPct) {
              onPatch({ priceFloorPct: v.value });
            }
          }}
        />
      </s-table-cell>
    </s-table-row>
  );
}
