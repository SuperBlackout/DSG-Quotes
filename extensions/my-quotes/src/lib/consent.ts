// SMS opt-in consent copy (screen 5). This exact string is what the A2P 10DLC campaign registration
// (docs/SETUP.md section 5) cites, it is what the customer sees next to the checkbox, and it is what
// is stored server-side as `smsConsentText` with `smsOptInAt`. Change it only together with the
// Twilio campaign and mockup 5; the unit test pins the exact wording.
export const SMS_CONSENT_TEXT =
  "I agree to receive quote alerts by text from DSG Distributors. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help.";

/**
 * Storefront origin used for the Terms / Privacy links. Set the "Storefront URL" extension setting
 * (checkout and accounts editor) so a domain change needs no code change. The fallback is only used
 * when the setting is empty or not an https origin. It must be the primary domain (www), because the
 * bare domain redirects to www and drops the path.
 */
export const DEFAULT_STOREFRONT_URL = "https://www.dsg.direct";

/** Pure so it can be unit tested: accepts the raw setting value, returns an origin without a trailing slash. */
export function normalizeStorefrontUrl(value: unknown): string {
  if (typeof value === "string") {
    const v = value.trim().replace(/\/+$/, "");
    if (/^https:\/\/[^/\s]+$/.test(v)) return v;
  }
  return DEFAULT_STOREFRONT_URL;
}

function storefrontUrl(): string {
  try {
    return normalizeStorefrontUrl(shopify.settings.value?.storefront_url);
  } catch {
    return DEFAULT_STOREFRONT_URL; // settings unavailable in some preview contexts
  }
}

// Shopify's default policy paths on the storefront domain.
export const termsUrl = (): string => `${storefrontUrl()}/policies/terms-of-service`;
export const privacyUrl = (): string => `${storefrontUrl()}/policies/privacy-policy`;

/** What to put in PUT /c/notification-prefs for the consent fields. */
export function consentPayload(optedIn: boolean): { smsOptIn: boolean; smsConsentText?: string } {
  return optedIn ? { smsOptIn: true, smsConsentText: SMS_CONSENT_TEXT } : { smsOptIn: false };
}
