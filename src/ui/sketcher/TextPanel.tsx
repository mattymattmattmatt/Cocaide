// The text box: shown over the sketch while one text is selected (and opened
// with its words selected right after the Text tool places one, so typing
// replaces them). What it says, its height, bold and italic, alignment and
// angle; Enter (or leaving a field) takes a change, Esc closes the box.

import { useEffect, useRef, useState } from "react";
import type { SketchEntity } from "../../doc/types";
import { missingGlyphs, TEXT_ALIGNS } from "../../geom/text/text";

type Text = Extract<SketchEntity, { type: "text" }>;

export interface TextPanelProps {
  text: Text;
  /** Opened by the Text tool just now: the words are selected to type over. */
  fresh: boolean;
  /** The height is held by a dimension (change that instead). */
  heightFixed: boolean;
  onChange(next: Text): void;
  onClose(): void;
}

const ALIGN_LABEL = { left: "Left", center: "Centre", right: "Right" } as const;

export function TextPanel({ text, fresh, heightFixed, onChange, onClose }: TextPanelProps) {
  const [words, setWords] = useState(text.text);
  const [height, setHeight] = useState(String(text.height));
  const [angle, setAngle] = useState(String(text.angle ?? 0));
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setWords(text.text);
    setHeight(String(text.height));
    setAngle(String(text.angle ?? 0));
  }, [text]);
  useEffect(() => {
    if (fresh) {
      input.current?.focus();
      input.current?.select();
    }
  }, [fresh, text.id]);
  const missing = missingGlyphs(words, { bold: text.bold });
  const take = (patch: Partial<Text>) => {
    const next = { ...text, ...patch } as Text;
    if (patch.angle === 0) delete next.angle;
    if (patch.align === "left") delete next.align;
    if (patch.bold === false) delete next.bold;
    if (patch.italic === false) delete next.italic;
    onChange(next);
  };
  const takeWords = () => {
    if (words.trim() && words !== text.text && !missingGlyphs(words, { bold: text.bold }).length) take({ text: words });
  };
  const keys = (e: React.KeyboardEvent, commit: () => void) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      commit();
      (e.target as HTMLInputElement).blur();
    } else if (e.key === "Escape") onClose();
  };
  return (
    <div className="sketch-tool-strip text-strip" data-testid="text-panel" onPointerDown={(e) => e.stopPropagation()}>
      <span className="strip-name">Text</span>
      <input
        ref={input}
        className="text-words"
        value={words}
        onChange={(e) => setWords(e.target.value)}
        onBlur={takeWords}
        onKeyDown={(e) => keys(e, takeWords)}
        aria-label="What the text says"
        data-testid="text-words"
        spellCheck={false}
      />
      <label className="strip-option" title={heightFixed ? "Its height is set by a dimension: change that" : "The capital letters' height"}>
        Height
        <input
          className="text-number"
          value={height}
          disabled={heightFixed}
          onChange={(e) => setHeight(e.target.value)}
          onBlur={() => {
            const h = Number(height);
            if (h > 0 && h !== text.height) take({ height: h });
          }}
          onKeyDown={(e) =>
            keys(e, () => {
              const h = Number(height);
              if (h > 0 && h !== text.height) take({ height: h });
            })
          }
          data-testid="text-height"
        />
        mm
      </label>
      <label className="strip-option" title="Turned about its anchor, counter-clockwise">
        Angle
        <input
          className="text-number"
          value={angle}
          onChange={(e) => setAngle(e.target.value)}
          onBlur={() => Number.isFinite(Number(angle)) && Number(angle) !== (text.angle ?? 0) && take({ angle: Number(angle) })}
          onKeyDown={(e) => keys(e, () => Number.isFinite(Number(angle)) && Number(angle) !== (text.angle ?? 0) && take({ angle: Number(angle) }))}
          data-testid="text-angle"
        />
        °
      </label>
      <span className="strip-option">
        {TEXT_ALIGNS.map((a) => (
          <button key={a} type="button" aria-pressed={(text.align ?? "left") === a} onClick={() => take({ align: a })} data-testid={`text-align-${a}`} title={`${ALIGN_LABEL[a]}: the anchor is the baseline's ${a === "left" ? "start" : a === "center" ? "middle" : "end"}`}>
            {ALIGN_LABEL[a]}
          </button>
        ))}
      </span>
      <span className="strip-option">
        <button type="button" aria-pressed={!!text.bold} onClick={() => take({ bold: !text.bold })} data-testid="text-bold" title="Bold">
          <b>B</b>
        </button>
        <button type="button" aria-pressed={!!text.italic} onClick={() => take({ italic: !text.italic })} data-testid="text-italic" title="Italic">
          <i>I</i>
        </button>
      </span>
      {missing.length > 0 && (
        <span className="strip-problem" data-testid="text-missing">
          The font has no {missing.join(" ")}
        </span>
      )}
    </div>
  );
}
