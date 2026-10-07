import { forwardRef, useImperativeHandle, useRef } from "react";

export interface EditorHandle {
  /** Select a feature's id in the text and scroll it into view. */
  reveal(featureId: string): void;
}

interface Props {
  text: string;
  onChange(text: string): void;
  parseError: string | null;
}

export const DocumentEditor = forwardRef<EditorHandle, Props>(function DocumentEditor({ text, onChange, parseError }, ref) {
  const area = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const lineCount = text.split("\n").length;

  useImperativeHandle(ref, () => ({
    reveal(featureId: string) {
      const el = area.current;
      if (!el) return;
      const needle = `"id": ${JSON.stringify(featureId)}`;
      const at = el.value.indexOf(needle);
      if (at < 0) return;
      el.focus();
      el.setSelectionRange(at, at + needle.length);
      const line = el.value.slice(0, at).split("\n").length - 1;
      const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 18;
      el.scrollTop = Math.max(0, line * lineHeight - el.clientHeight / 3);
    },
  }));

  return (
    <section className="panel editor" aria-label="Document">
      <h2>
        Document <span className="muted">.cocaide.json</span>
      </h2>
      <div className="editor-body">
        <div className="gutter" ref={gutter} aria-hidden>
          {Array.from({ length: lineCount }, (_, i) => (
            <div key={i}>{i + 1}</div>
          ))}
        </div>
        <textarea
          ref={area}
          value={text}
          spellCheck={false}
          wrap="off"
          aria-label="Document JSON"
          data-testid="doc-editor"
          onChange={(e) => onChange(e.target.value)}
          onScroll={(e) => {
            if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop;
          }}
          onKeyDown={(e) => {
            if (e.key === "Tab") {
              e.preventDefault();
              const el = e.currentTarget;
              const { selectionStart: s, selectionEnd: end } = el;
              const next = `${el.value.slice(0, s)}  ${el.value.slice(end)}`;
              onChange(next);
              requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
            }
          }}
        />
      </div>
      {parseError ? (
        <div className="editor-status bad" role="alert">
          {parseError}
        </div>
      ) : (
        <div className="editor-status muted">Edits rebuild automatically.</div>
      )}
    </section>
  );
});
