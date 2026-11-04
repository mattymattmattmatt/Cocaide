// A table cell you type in (Phase Q): reads as text, edits in place, commits
// on Enter or leaving it, Escape puts it back.

import { useEffect, useRef, useState } from "react";

export function EditCell({ value, placeholder, onCommit, testId, label }: { value: string; placeholder?: string; onCommit(v: string): void; testId?: string; label: string }) {
  const [draft, setDraft] = useState(value);
  const cancelled = useRef(false);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      className="cut-edit"
      value={draft}
      placeholder={placeholder}
      aria-label={label}
      title={draft || placeholder}
      data-testid={testId}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (cancelled.current) {
          cancelled.current = false;
          setDraft(value);
          return;
        }
        if (draft !== value) onCommit(draft);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        else if (e.key === "Escape") {
          cancelled.current = true;
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}
