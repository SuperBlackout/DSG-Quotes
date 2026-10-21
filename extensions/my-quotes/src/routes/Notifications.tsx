// Screen 5: notification settings (PUT /c/notification-prefs).
import { useEffect, useState } from "preact/hooks";
import { api } from "../api/instance";
import type { NotificationPrefs } from "../api/types";
import { PRIVACY_URL, SMS_CONSENT_TEXT, TERMS_URL } from "../lib/consent";
import { formatShortDate } from "../lib/format";
import {
  EVENT_DEFS,
  anySmsEnabled,
  formFromPrefs,
  isEmail,
  prefsToPut,
  timeOptions,
  validatePrefs,
  type PrefsForm,
} from "../lib/notifications";
import { ErrorBanner, Loading, NavLink, WIDE_900, errorMessage } from "../ui/common";
import { checkedOf, valueOf } from "../ui/events";
import { useAction, useAsync } from "../ui/hooks";


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
  const [newWatcher, setNewWatcher] = useState("");
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
  const setEvent = (key: string, channel: "email" | "sms", on: boolean) =>
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

  function addWatcher() {
    const email = newWatcher.trim();
    if (!isEmail(email)) {
      setShowErrors(true);
      return;
    }
    if (form && !form.watchers.some((w) => w.toLowerCase() === email.toLowerCase())) {
      update({ watchers: [...form.watchers, email] });
    }
    setNewWatcher("");
  }

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
                    Teammates who follow your quotes get the same alerts by email. They can read and reply, not accept.
                  </s-text>
                  {form.watchers.length === 0 ? <s-text color="subdued">No one added yet.</s-text> : null}
                  {form.watchers.map((w) => (
                    <s-stack key={w} direction="inline" gap="small" alignItems="center" justifyContent="space-between">
                      <s-text type="strong">{w}</s-text>
                      <s-button
                        tone="critical"
                        accessibilityLabel={`Remove ${w}`}
                        onClick={() => update({ watchers: form.watchers.filter((x) => x !== w) })}
                      >
                        Remove
                      </s-button>
                    </s-stack>
                  ))}
                  {visibleErrors.watchers ? <s-text tone="critical">{visibleErrors.watchers}</s-text> : null}
                  <s-grid gridTemplateColumns="1fr auto" gap="small" alignItems="end">
                    <s-text-field
                      label="Teammate email"
                      placeholder="sam@example.com"
                      value={newWatcher}
                      error={showErrors && newWatcher && !isEmail(newWatcher) ? "Enter a valid email address." : undefined}
                      onInput={(e: Event) => setNewWatcher(valueOf(e))}
                    />
                    <s-button onClick={addWatcher}>+ Add person</s-button>
                  </s-grid>
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
