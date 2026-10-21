// "Job details" card with an Edit dialog (PATCH /c/quotes/{id}).
import { useRef, useState } from "preact/hooks";
import { api } from "../api/instance";
import type { CustomerQuote } from "../api/types";
import { canEditJobDetails } from "../lib/detail";
import { formatLongDate } from "../lib/format";
import { buildJobUpdate, formatShipTo, jobFormFrom, validateJobForm, type JobForm } from "../lib/job-form";
import { WIDE_700, errorMessage } from "../ui/common";
import { valueOf } from "../ui/events";
import { useAction } from "../ui/hooks";

const MODAL_ID = "job-details-modal";

export function JobDetails({ quote, onQuote }: { quote: CustomerQuote; onQuote: (q: CustomerQuote) => void }) {
  const editable = canEditJobDetails(quote.status);
  const po = quote.poNumber ?? quote.job?.poNumber;
  const shipTo = formatShipTo(quote);

  return (
    <s-section heading="Job details">
      <s-stack direction="block" gap="base">
        <s-grid gridTemplateColumns={`${WIDE_700} repeat(4, minmax(0, 1fr)), repeat(2, minmax(0, 1fr))`} gap="base">
          <Fact label="Job name" value={quote.job?.name ?? "No job"} />
          <Fact label="PO #" value={po || "—"} />
          <Fact label="Ship to" value={shipTo || "—"} />
          <Fact label="Needed by" value={quote.neededBy ? formatLongDate(`${quote.neededBy}T12:00:00Z`, "UTC") : "—"} />
        </s-grid>
        <s-box background="subdued" padding="base" borderRadius="base">
          <s-stack direction="block" gap="small-300">
            <s-text color="subdued" type="small">
              Your note to sales
            </s-text>
            <s-text>{quote.notesToSales || "No note yet."}</s-text>
          </s-stack>
        </s-box>
        {editable ? (
          <s-stack direction="inline">
            <s-button commandFor={MODAL_ID} command="--show">
              Edit job details
            </s-button>
          </s-stack>
        ) : null}
      </s-stack>
      {editable ? <EditJobModal key={quote.updatedAt} quote={quote} onQuote={onQuote} /> : null}
    </s-section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <s-stack direction="block" gap="small-300">
      <s-text color="subdued" type="small">
        {label}
      </s-text>
      <s-text type="strong">{value}</s-text>
    </s-stack>
  );
}

function EditJobModal({ quote, onQuote }: { quote: CustomerQuote; onQuote: (q: CustomerQuote) => void }) {
  const [form, setForm] = useState<JobForm>(() => jobFormFrom(quote));
  const action = useAction();
  const modal = useRef<HTMLElementTagNameMap["s-modal"]>(null);
  const errors = validateJobForm(form);
  const patch = buildJobUpdate(quote, form);
  const set = (key: keyof JobForm) => (e: Event) => setForm((f) => ({ ...f, [key]: valueOf(e) }));

  async function save() {
    if (Object.keys(errors).length > 0 || !patch) return;
    const updated = await action.run("save", () => api().updateQuote(quote.id, patch));
    if (!updated) return;
    onQuote(updated);
    modal.current?.hideOverlay();
  }

  return (
    <s-modal ref={modal} id={MODAL_ID} heading="Edit job details">
      <s-stack direction="block" gap="base">
        {action.error ? <s-banner tone="critical">{errorMessage(action.error)}</s-banner> : null}
        <s-text-field label="Quote name" required value={form.title} error={errors.title} onInput={set("title")} />
        <s-text-field label="PO number" value={form.poNumber} onInput={set("poNumber")} />
        <s-date-field
          label="Needed by"
          value={form.neededBy}
          error={errors.neededBy}
          onChange={set("neededBy")}
        />
        <s-text-field label="Ship to: address" value={form.address1} onInput={set("address1")} />
        <s-text-field label="Apartment, suite, etc." value={form.address2} onInput={set("address2")} />
        <s-grid gridTemplateColumns="2fr 1fr 1fr" gap="small">
          <s-text-field label="City" value={form.city} onInput={set("city")} />
          <s-text-field label="State" value={form.province} onInput={set("province")} />
          <s-text-field label="ZIP" value={form.zip} onInput={set("zip")} />
        </s-grid>
        <s-text-area label="Note to sales" rows={3} value={form.notesToSales} onInput={set("notesToSales")} />
      </s-stack>
      <s-button slot="secondary-actions" commandFor={MODAL_ID} command="--hide" onClick={() => setForm(jobFormFrom(quote))}>
        Cancel
      </s-button>
      <s-button
        slot="primary-action"
        variant="primary"
        disabled={!patch || Object.keys(errors).length > 0}
        loading={action.busy === "save"}
        onClick={() => void save()}
      >
        Save changes
      </s-button>
    </s-modal>
  );
}
