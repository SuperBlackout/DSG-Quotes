// SMS opt-in consent copy (screen 5). This exact string is what the A2P 10DLC campaign registration
// (docs/SETUP.md section 5) cites, it is what the customer sees next to the checkbox, and it is what
// is stored server-side as `smsConsentText` with `smsOptInAt`. Change it only together with the
// Twilio campaign and mockup 5; the unit test pins the exact wording.
export const SMS_CONSENT_TEXT =
  "I agree to receive quote alerts by text from DSG Distributors. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help.";

// Shopify's default policy paths on the storefront domain. The mockup shows "Terms" and "Privacy"
// links with no URL; confirm these resolve on dsg.direct before launch.
export const TERMS_URL = "https://dsg.direct/policies/terms-of-service";
export const PRIVACY_URL = "https://dsg.direct/policies/privacy-policy";

/** What to put in PUT /c/notification-prefs for the consent fields. */
export function consentPayload(optedIn: boolean): { smsOptIn: boolean; smsConsentText?: string } {
  return optedIn ? { smsOptIn: true, smsConsentText: SMS_CONSENT_TEXT } : { smsOptIn: false };
}
