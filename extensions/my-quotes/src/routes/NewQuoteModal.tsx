// "+ New quote" dialog: name, job (existing or new) and PO. Creates an empty DRAFT; products are
// added from the shop with the "Add to Quote" button.
import { useState } from "preact/hooks";
import { api } from "../api/instance";
import { errorMessage } from "../ui/common";
import { valueOf } from "../ui/events";
import { go, useAction } from "../ui/hooks";

const NEW_JOB = "__new__";
const NO_JOB = "";


export function NewQuoteModal({ jobs }: { jobs: Array<{ id: string; name: string }> }) {
  const [title, setTitle] = useState("");
  const [jobChoice, setJobChoice] = useState<string>(NO_JOB);
  const [newJobName, setNewJobName] = useState("");
  const [po, setPo] = useState("");
  const action = useAction();

  const needsJobName = jobChoice === NEW_JOB;
  const valid = title.trim().length > 0 && (!needsJobName || newJobName.trim().length > 0);

  async function create() {
    if (!valid) return;
    const poNumber = po.trim() || undefined;
    const created = await action.run("create", () =>
      api().createQuote({
        title: title.trim(),
        setActive: true,
        ...(poNumber ? { poNumber } : {}),
        ...(needsJobName
          ? { newJob: { name: newJobName.trim(), ...(poNumber ? { poNumber } : {}) } }
          : jobChoice !== NO_JOB
            ? { jobId: jobChoice }
            : {}),
      }),
    );
    if (created) go({ name: "detail", id: created.id });
  }

  return (
    <s-modal id="new-quote-modal" heading="New quote">
      <s-stack direction="block" gap="base">
        {action.error ? <s-banner tone="critical">{errorMessage(action.error)}</s-banner> : null}
        <s-text-field
          label="Quote name"
          placeholder="Main system, option A"
          required
          value={title}
          onInput={(e: Event) => setTitle(valueOf(e))}
        />
        <s-select label="Job" value={jobChoice} onChange={(e: Event) => setJobChoice(valueOf(e))}>
          <s-option value={NO_JOB}>No job yet</s-option>
          {jobs.map((j) => (
            <s-option key={j.id} value={j.id}>
              {j.name}
            </s-option>
          ))}
          <s-option value={NEW_JOB}>New job…</s-option>
        </s-select>
        {needsJobName ? (
          <s-text-field
            label="New job name"
            placeholder="Lakeview Clinic"
            required
            value={newJobName}
            onInput={(e: Event) => setNewJobName(valueOf(e))}
          />
        ) : null}
        <s-text-field label="PO number (optional)" value={po} onInput={(e: Event) => setPo(valueOf(e))} />
      </s-stack>
      <s-button slot="secondary-actions" commandFor="new-quote-modal" command="--hide">
        Cancel
      </s-button>
      <s-button
        slot="primary-action"
        variant="primary"
        disabled={!valid}
        loading={action.busy === "create"}
        onClick={() => void create()}
      >
        Create quote
      </s-button>
    </s-modal>
  );
}
