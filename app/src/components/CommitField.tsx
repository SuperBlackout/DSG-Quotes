import { useEffect, useState } from "react";

/**
 * Text field that keeps the user's raw text while typing and reports a value upward only when it parses.
 * On blur an unparseable entry snaps back to the canonical value, so display and state never disagree.
 */
export function CommitField({
  label,
  value,
  onValid,
  isValid,
  error,
  details,
  disabled,
  tone,
}: {
  label: string;
  /** Canonical text from state (e.g. "749.00" or "2"). */
  value: string;
  onValid: (text: string) => void;
  isValid: (text: string) => boolean;
  error?: string;
  details?: string;
  disabled?: boolean;
  tone?: "critical";
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const valid = isValid(draft);
  return (
    <s-text-field
      label={label}
      labelAccessibilityVisibility="exclusive"
      value={draft}
      disabled={disabled}
      details={details}
      error={error ?? (!valid && draft.trim() !== "" ? "Invalid" : undefined)}
      onInput={(e) => {
        const text = e.currentTarget.value;
        setDraft(text);
        if (isValid(text)) onValid(text);
      }}
      onBlur={() => {
        if (!isValid(draft)) setDraft(value);
      }}
      data-tone={tone}
    />
  );
}
