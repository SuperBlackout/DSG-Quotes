import type { CustomerQuote } from "../api/types";
import { statusBanner, type BannerAction, type BannerActionId } from "../lib/status";

export const ACCEPT_MODAL_ID = "accept-modal";
export const CHANGES_MODAL_ID = "changes-modal";

/** Banner actions that open a dialog instead of calling the API directly. */
const MODAL_FOR: Partial<Record<BannerActionId, string>> = {
  accept: ACCEPT_MODAL_ID,
  "request-changes": CHANGES_MODAL_ID,
};

export function StatusBannerView({
  quote,
  busy,
  continueUrl,
  onAction,
}: {
  quote: CustomerQuote;
  busy: string | undefined;
  /** Set once /checkout returned: the only way out of customer accounts is a real link. */
  continueUrl: string | undefined;
  onAction: (id: BannerActionId) => void;
}) {
  const banner = statusBanner(quote);

  return (
    <s-banner tone={banner.tone} heading={banner.heading}>
      <s-stack direction="block" gap="base">
        {banner.body ? <s-text>{banner.body}</s-text> : null}
        {banner.actions.length > 0 ? (
          <s-stack direction="inline" gap="small">
            {banner.actions.map((a) => (
              <BannerButton key={a.id} action={a} busy={busy} continueUrl={continueUrl} onAction={onAction} />
            ))}
          </s-stack>
        ) : null}
      </s-stack>
    </s-banner>
  );
}

function BannerButton({
  action: a,
  busy,
  continueUrl,
  onAction,
}: {
  action: BannerAction;
  busy: string | undefined;
  continueUrl: string | undefined;
  onAction: (id: BannerActionId) => void;
}) {
  if (a.id === "buy" && continueUrl) {
    return (
      <s-button variant="primary" href={continueUrl}>
        Continue to checkout
      </s-button>
    );
  }
  const modal = MODAL_FOR[a.id];
  return (
    <s-button
      variant={a.variant}
      loading={busy === a.id}
      disabled={busy !== undefined && busy !== a.id}
      {...(modal ? { commandFor: modal, command: "--show" as const } : { onClick: () => onAction(a.id) })}
    >
      {a.label}
    </s-button>
  );
}
