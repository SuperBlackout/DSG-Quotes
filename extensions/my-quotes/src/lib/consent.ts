// SMS opt-in consent copy (screen 5). This exact string is what the A2P 10DLC campaign registration
// (docs/SETUP.md section 5) cites, it is what the customer sees next to the checkbox, and it is what
// is stored server-side as `smsConsentText` with `smsOptInAt`. Change it only together with the
// Twilio campaign and mockup 5; the unit test pins the exact wording.
export const SMS_CONSENT_TEXT =
  "I agree to receive quote alerts by text from DSG Distributors. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help.";

// The published SMS sections on dsg.direct. These are the same URLs cited in the A2P 10DLC campaign
// registration: Terms & Conditions (SMS Terms section) and Privacy Policy (Text messaging section).
// Shopify's default /policies/* paths are NOT used (terms-of-service 404s; privacy-policy is a
// different document without the SMS statement).
export const TERMS_URL = "https://dsg.direct/pages/terms-and-conditions#sms-terms";
export const PRIVACY_URL = "https://dsg.direct/pages/privacy-policy#sms";

/** What to put in PUT /c/notification-prefs for the consent fields. */
export function consentPayload(optedIn: boolean): { smsOptIn: boolean; smsConsentText?: string } {
  return optedIn ? { smsOptIn: true, smsConsentText: SMS_CONSENT_TEXT } : { smsOptIn: false };
}
