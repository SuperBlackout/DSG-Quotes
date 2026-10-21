// Screen 5: notification settings (PUT /c/notification-prefs).
import { useEffect, useState } from "preact/hooks";
import { api } from "../api/instance";
import type { NotificationEvent, NotificationPrefs } from "../api/types";
import { PRIVACY_URL, SMS_CONSENT_TEXT, TERMS_URL } from "../lib/consent";
import { formatShortDate } from "../lib/format";
import {
  EVENT_DEFS,
  describeWatcher,
  emptyWatcher,
  scopeOptions,
  watcherError,
  watcherKey,
  anySmsEnabled,
  formFromPrefs,
  prefsToPut,
  timeOptions,
  validatePrefs,
  type PrefsForm,
  type WatcherForm,
} from "../lib/notifications";
import { ErrorBanner, Loading, NavLink, WIDE_700, WIDE_900, errorMessage } from "../ui/common";
import { checkedOf, valueOf } from "../ui/events";
import { useAction, useAsync } from "../ui/hooks";


/** Distinct jobs across the customer's quotes, for the watcher scope picker. */
async function loadJobs(): Promise<Array<{ id: string; name: string }>> {
  const jobs = new Map<string, { id: string; name: string }>();
  let cursor: string | undefined;
  for (let i = 0; i < 20; i++) {
    const page = await api().listQuotes({ limit: 100, cursor });
    for (const q of page.items) if (q.job && !jobs.has(q.job.id)) jobs.set(q.job.id, { id: q.job.id, name: q.job.name });
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return [...jobs.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function detectTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York";
  } catch {
    return "America/New_York";
  }
}

export function Notifications() {
  const prefs = useAsync(() => api().getNotificationPrefs(), []);
  const [form, setForm] = useState<PrefsForm | undefined>(undefined);
  const [saved, setSaved] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [draft, setDraft] = useState<WatcherForm>(emptyWatcher());
  const [watcherTouched, setWatcherTouched] = useState(false);
  // Jobs only feed the watcher scope picker; if the list fails the page still works.
  const jobs = useAsync(loadJobs, []);
  const action = useAction();

  // (Re)seed the form whenever prefs load or are replaced by a save.
  useEffect(() => {
    if (prefs.data) setForm(formFromPrefs(prefs.data, detectTimezone()));
  }, [prefs.data]);

  if (prefs.loading && !prefs.data) {
    return (
      <Shell>
        <Loading label="Loading settings" />
      </Shell>
    );
  }
  if (!prefs.data || !form) {
    return <Shell>{prefs.error ? <ErrorBanner error={prefs.error} onRetry={prefs.reload} /> : null}</Shell>;
  }

  const original: NotificationPrefs = prefs.data;
  const errors = validatePrefs(form);
  const visibleErrors = showErrors ? errors : {};
  const update = (patch: Partial<PrefsForm>) => {
    setSaved(false);
    setForm((f) => (f ? { ...f, ...patch } : f));
  };
  const setEvent = (key: NotificationEvent, channel: "email" | "sms", on: boolean) =>
    update({ events: { ...form.events, [key]: { ...form.events[key]!, [channel]: on } } });

  async function save() {
    setShowErrors(true);
    if (Object.keys(errors).length > 0 || !form) return;
    const res = await action.run("save", () => api().putNotificationPrefs(prefsToPut(original, form)));
    if (res) {
      prefs.set(res);
      setSaved(true);
      setShowErrors(false);
    }
  }

  const updateWatcher = (index: number, patch: Partial<WatcherForm>) => {
    update({ watchers: form.watchers.map((w, i) => (i === index ? { ...w, ...patch } : w)) });
  };

  const scopes = scopeOptions(jobs.data ?? [], form.watchers);
  const draftError =
    watcherError(draft) ??
    (form.watchers.some((w) => watcherKey(w) === watcherKey(draft))
      ? `${draft.email.trim()} is already listed for that scope.`
      : undefined);

  const addWatcher = () => {
    setWatcherTouched(true);
    if (draftError) return;
    update({ watchers: [...form.watchers, { ...draft, email: draft.email.trim() }] });
    setDraft(emptyWatcher());
    setWatcherTouched(false);
  };

  const times = timeOptions();
  const withCurrent = (v: string) => (times.some((t) => t.value === v) ? times : [{ value: v, label: v }, ...times]);

  return (
    <Shell>
      <s-query-container>
        <s-stack direction="block" gap="base">
          <s-text color="subdued">
            Choose what you hear about and how. Replying to any alert email or text posts straight into that quote's
            conversation.
          </s-text>

          {prefs.error ? <ErrorBanner error={prefs.error} onRetry={prefs.reload} /> : null}
          {action.error ? (
            <s-banner tone="critical" heading="Could not save" dismissible onDismiss={action.clearError}>
              {errorMessage(action.error)}
            </s-banner>
          ) : null}
          {saved ? (
            <s-banner tone="success" heading="Settings saved" dismissible onDismiss={() => setSaved(false)} />
          ) : null}

          <s-grid gridTemplateColumns={`${WIDE_900} 3fr 2fr, 1fr`} gap="base" alignItems="start">
            {/* ---------------- left column ---------------- */}
            <s-stack direction="block" gap="base">
              <s-section heading="When should we alert you?">
                <s-stack direction="block" gap="base">
                  <s-grid gridTemplateColumns="minmax(0, 1fr) 4.5rem 4.5rem" gap="small" alignItems="center">
                    <s-text color="subdued" type="strong">Event</s-text>
                    <s-text color="subdued" type="strong">Email</s-text>
                    <s-text color="subdued" type="strong">Text</s-text>
                  </s-grid>
                  {EVENT_DEFS.map((def) => (
                    <s-stack key={def.key} direction="block" gap="base">
                      <s-divider />
                      <s-grid gridTemplateColumns="minmax(0, 1fr) 4.5rem 4.5rem" gap="small" alignItems="center">
                        <s-stack direction="block" gap="small-300">
                          <s-text type="strong">{def.title}</s-text>
                          <s-text color="subdued" type="small">{def.description}</s-text>
                        </s-stack>
                        <s-checkbox
                          accessibilityLabel={`Email: ${def.title}`}
                          checked={form.events[def.key]?.email ?? false}
                          onChange={(e: Event) =>
                            setEvent(def.key, "email", checkedOf(e))
                          }
                        />
                        {def.sms ? (
                          <s-checkbox
                            accessibilityLabel={`Text: ${def.title}`}
                            checked={form.events[def.key]?.sms ?? false}
                            onChange={(e: Event) =>
                              setEvent(def.key, "sms", checkedOf(e))
                            }
                          />
                        ) : (
                          <s-text color="subdued" accessibilityVisibility="hidden">—</s-text>
                        )}
                      </s-grid>
                    </s-stack>
                  ))}
                </s-stack>
              </s-section>

              <s-section heading="Also notify">
                <s-stack direction="block" gap="base">
                  <s-text color="subdued" type="small">
                    Teammates who follow your quotes get the alerts you choose for them, for all quotes or one job. They can
                    read and reply, not accept. Texts to a teammate also need their own opt-in.
                  </s-text>
                  {form.watchers.length === 0 ? <s-text color="subdued">No one added yet.</s-text> : null}
                  {form.watchers.map((w, i) => (
                    <s-box key={i} background="subdued" padding="base" borderRadius="base">
                      <s-stack direction="block" gap="small">
                        <s-stack direction="inline" gap="small" alignItems="center" justifyContent="space-between">
                          <s-stack direction="block" gap="small-300">
                            <s-text type="strong">{w.name.trim() || w.email}</s-text>
                            <s-text color="subdued" type="small">
                              {w.name.trim() ? `${w.email} · ` : ""}
                              {describeWatcher({ ...w, name: "" }, scopes)}
                            </s-text>
                          </s-stack>
                          <s-button
                            tone="critical"
                            accessibilityLabel={`Remove ${w.email}`}
                            onClick={() => update({ watchers: form.watchers.filter((_, j) => j !== i) })}
                          >
                            Remove
                          </s-button>
                        </s-stack>
                        <s-grid gridTemplateColumns={`${WIDE_700} 1fr 1fr, 1fr`} gap="small" alignItems="end">
                          <s-select
                            label="Follows"
                            value={w.scope}
                            onChange={(e: Event) => updateWatcher(i, { scope: valueOf(e) })}
                          >
                            {scopes.map((s) => (
                              <s-option key={s.value} value={s.value}>{s.label}</s-option>
                            ))}
                          </s-select>
                          <s-stack direction="inline" gap="base">
                            <s-checkbox
                              label="Email"
                              checked={w.channels.email}
                              onChange={(e: Event) => updateWatcher(i, { channels: { ...w.channels, email: checkedOf(e) } })}
                            />
                            <s-checkbox
                              label="Text"
                              checked={w.channels.sms}
                              onChange={(e: Event) => updateWatcher(i, { channels: { ...w.channels, sms: checkedOf(e) } })}
                            />
                          </s-stack>
                        </s-grid>
                      </s-stack>
                    </s-box>
                  ))}
                  {visibleErrors.watchers ? <s-text tone="critical">{visibleErrors.watchers}</s-text> : null}

                  <s-divider />
                  <s-text type="strong">Add a teammate</s-text>
                  <s-grid gridTemplateColumns={`${WIDE_700} 1fr 1fr, 1fr`} gap="small">
                    <s-text-field
                      label="Name"
                      placeholder="Sam Lee"
                      value={draft.name}
                      onInput={(e: Event) => setDraft((d) => ({ ...d, name: valueOf(e) }))}
                    />
                    <s-text-field
                      label="Role"
                      placeholder="Project manager"
                      value={draft.role}
                      onInput={(e: Event) => setDraft((d) => ({ ...d, role: valueOf(e) }))}
                    />
                  </s-grid>
                  <s-text-field
                    label="Email"
                    placeholder="sam@example.com"
                    value={draft.email}
                    error={watcherTouched ? draftError : undefined}
                    onInput={(e: Event) => setDraft((d) => ({ ...d, email: valueOf(e) }))}
                  />
                  <s-select
                    label="Follows"
                    value={draft.scope}
                    onChange={(e: Event) => setDraft((d) => ({ ...d, scope: valueOf(e) }))}
                  >
                    {scopes.map((s) => (
                      <s-option key={s.value} value={s.value}>{s.label}</s-option>
                    ))}
                  </s-select>
                  <s-stack direction="inline" gap="base">
                    <s-checkbox
                      label="Email"
                      checked={draft.channels.email}
                      onChange={(e: Event) => setDraft((d) => ({ ...d, channels: { ...d.channels, email: checkedOf(e) } }))}
                    />
                    <s-checkbox
                      label="Text"
                      checked={draft.channels.sms}
                      onChange={(e: Event) => setDraft((d) => ({ ...d, channels: { ...d.channels, sms: checkedOf(e) } }))}
                    />
                  </s-stack>
                  <s-stack direction="inline">
                    <s-button onClick={addWatcher}>+ Add person</s-button>
                  </s-stack>
                </s-stack>
              </s-section>
            </s-stack>

            {/* ---------------- right column ---------------- */}
            <s-stack direction="block" gap="base">
              <s-section heading="Where to reach you">
                <s-stack direction="block" gap="base">
                  <s-text-field
                    label="Email"
                    value={form.email}
                    error={visibleErrors.email}
                    onInput={(e: Event) => update({ email: valueOf(e) })}
                  />
                  <s-text-field
                    label="Mobile for texts"
                    value={form.phone}
                    error={visibleErrors.phone}
                    onInput={(e: Event) => update({ phone: valueOf(e) })}
                  />
                  <s-box background="subdued" padding="base" borderRadius="base">
                    <s-stack direction="block" gap="small">
                      {/* The label IS the consent text recorded with smsOptInAt: keep it verbatim. */}
                      <s-checkbox
                        label={SMS_CONSENT_TEXT}
                        checked={form.smsOptIn}
                        error={visibleErrors.smsOptIn}
                        onChange={(e: Event) =>
                          update({ smsOptIn: checkedOf(e) })
                        }
                      />
                      <s-stack direction="inline" gap="small">
                        <s-link href={TERMS_URL} target="_blank">Terms</s-link>
                        <s-text color="subdued">·</s-text>
                        <s-link href={PRIVACY_URL} target="_blank">Privacy</s-link>
                      </s-stack>
                    </s-stack>
                  </s-box>
                  {original.smsOptIn && original.smsOptInAt ? (
                    <s-stack direction="inline" gap="small-200" alignItems="center">
                      <s-icon type="check" tone="success" />
                      <s-text tone="success">Number confirmed {formatShortDate(original.smsOptInAt)}</s-text>
                    </s-stack>
                  ) : null}
                  {!form.smsOptIn && anySmsEnabled(form) ? (
                    <s-text tone="warning" type="small">Texts stay off until you agree above.</s-text>
                  ) : null}
                </s-stack>
              </s-section>

              <s-section heading="Quiet hours for texts">
                <s-stack direction="block" gap="base">
                  <s-switch
                    label="Quiet hours"
                    checked={form.quietEnabled}
                    onChange={(e: Event) =>
                      update({ quietEnabled: checkedOf(e) })
                    }
                  />
                  {form.quietEnabled ? (
                    <s-grid gridTemplateColumns="1fr 1fr" gap="small">
                      <s-select label="From" value={form.quietStart} onChange={(e: Event) => update({ quietStart: valueOf(e) })}>
                        {withCurrent(form.quietStart).map((t) => (
                          <s-option key={t.value} value={t.value}>{t.label}</s-option>
                        ))}
                      </s-select>
                      <s-select label="Until" value={form.quietEnd} onChange={(e: Event) => update({ quietEnd: valueOf(e) })}>
                        {withCurrent(form.quietEnd).map((t) => (
                          <s-option key={t.value} value={t.value}>{t.label}</s-option>
                        ))}
                      </s-select>
                    </s-grid>
                  ) : null}
                  <s-text color="subdued" type="small">
                    Texts during quiet hours wait until morning. Email still arrives.
                  </s-text>
                </s-stack>
              </s-section>

              <s-button variant="primary" inlineSize="fill" loading={action.busy === "save"} onClick={() => void save()}>
                Save settings
              </s-button>
            </s-stack>
          </s-grid>
        </s-stack>
      </s-query-container>
    </Shell>
  );
}

function Shell({ children }: { children?: preact.ComponentChildren }) {
  return (
    <s-page heading="Quote notifications">
      <NavLink slot="breadcrumb-actions" route={{ name: "list" }}>
        My Quotes
      </NavLink>
      {children}
    </s-page>
  );
}
