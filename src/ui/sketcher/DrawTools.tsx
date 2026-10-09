// The sketch toolbar's pieces for the drawing tools: SOLIDWORKS-style flyout
// buttons (the button runs the variant used last; its arrow lists them all),
// small icon toggles, and the strip that says what to click next and holds
// the active tool's options (a polygon's sides) while it is in use.

import { useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "../icons";
import { keyFor, keyHint, useInputPrefs } from "../input";
import type { FlyoutDef, SketchToolDef, ToolOptions } from "./tools/types";

const keepFocus = (e: React.MouseEvent) => e.preventDefault();

/**
 * One flyout: the button shows the tool picked from it last (and runs it); its
 * arrow opens the list. Pressed while any of its tools is the active one.
 */
export function Flyout({ flyout, tools, shown, active, onPick }: { flyout: FlyoutDef; tools: SketchToolDef[]; shown: SketchToolDef; active: string; onPick(t: SketchToolDef): void }) {
  const prefs = useInputPrefs();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    // Esc closes the list only: the tool stays.
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", key, true);
    };
  }, [open]);
  return (
    <div className="menu flyout" ref={ref}>
      <button
        className="tool"
        onMouseDown={keepFocus}
        onClick={() => onPick(shown)}
        aria-pressed={tools.some((t) => t.name === active)}
        title={`${shown.title}${keyHint(shown.id, prefs)}`}
        data-testid={`tool-${shown.name}`}
      >
        <Icon name={shown.icon} size={18} />
        <span className="tool-label">{flyout.label}</span>
      </button>
      <button
        className="flyout-arrow"
        onMouseDown={keepFocus}
        onClick={() => setOpen((o) => !o)}
        aria-label={`${flyout.label} tools`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${flyout.label} tools: ${tools.map((t) => t.label).join(", ")}`}
        data-testid={`tool-${flyout.id}-flyout`}
      >
        <Icon name="down" size={10} />
      </button>
      {open && (
        <div className="menu-items" role="menu" aria-label={`${flyout.label} tools`}>
          {tools.map((t) => (
            <button
              key={t.name}
              role="menuitemradio"
              aria-checked={t.name === active}
              title={t.title}
              data-testid={`flyout-${t.name}`}
              onClick={() => {
                setOpen(false);
                onPick(t);
              }}
            >
              <Icon name={t.icon} />
              <span>{t.label}</span>
              {keyFor(t.id, prefs) && <kbd className="menu-key">{keyFor(t.id, prefs)}</kbd>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** A toolbar toggle or action shown as its icon alone; its name is its label for screen readers and its tooltip. */
export function IconTool({ icon, label, title, pressed, disabled, onClick, testId }: { icon: IconName; label: string; title: string; pressed?: boolean; disabled?: boolean; onClick(): void; testId?: string }) {
  return (
    <button className="tool compact" onMouseDown={keepFocus} onClick={onClick} disabled={disabled} aria-label={label} title={title} aria-pressed={pressed} data-testid={testId}>
      <Icon name={icon} size={18} />
    </button>
  );
}

/**
 * While a drawing tool is in use: its name, what the next click places, and
 * its options, changed on the spot (the preview follows at once).
 */
export function ToolStrip({
  tool,
  placed,
  arcNext,
  options,
  onOption,
}: {
  tool: SketchToolDef;
  placed: number;
  /** A line chain's next piece is a tangent arc. */
  arcNext: boolean;
  options: ToolOptions;
  onOption(key: string, value: number | string): void;
}) {
  const prefs = useInputPrefs();
  const arcKey = keyFor("sketch.arc", prefs);
  let prompt = tool.prompts[Math.min(placed, tool.prompts.length - 1)];
  if (arcNext) prompt = `Tangent arc: click where it ends${arcKey ? ` (${arcKey}: back to lines)` : ""}`;
  else if (tool.chain && tool.name !== "tangent-arc" && placed === 1 && arcKey) prompt = `${prompt} (${arcKey}: a tangent arc)`;
  return (
    <div className="sketch-tool-strip" data-testid="tool-strip">
      <span className="strip-name">
        <Icon name={tool.icon} size={14} />
        {tool.label}
      </span>
      <span className="strip-prompt" title={prompt} data-testid="tool-prompt">
        {prompt}
      </span>
      {(tool.options ?? []).map((o) =>
        o.kind === "number" ? (
          <label key={o.key} className="strip-option" title={o.title}>
            {o.label}
            <NumberStepper
              value={Number(options[o.key] ?? o.default)}
              min={o.min}
              max={o.max}
              testId={`tool-option-${o.key}`}
              onChange={(v) => onOption(o.key, o.integer ? Math.round(v) : v)}
            />
          </label>
        ) : (
          <span key={o.key} className="strip-option" title={o.title} role="radiogroup" aria-label={o.label}>
            {o.choices.map((c) => (
              <button
                key={c.value}
                type="button"
                role="radio"
                aria-checked={(options[o.key] ?? o.default) === c.value}
                title={c.title}
                data-testid={`tool-option-${o.key}-${c.value}`}
                onMouseDown={keepFocus}
                onClick={() => onOption(o.key, c.value)}
              >
                {c.label}
              </button>
            ))}
          </span>
        ),
      )}
    </div>
  );
}

/** A whole number with − and + beside it; typed values outside min..max are pulled back in. */
function NumberStepper({ value, min, max, onChange, testId }: { value: number; min: number; max: number; onChange(v: number): void; testId: string }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = (raw: string) => {
    const v = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(v)) return setText(String(value));
    const clamped = Math.min(max, Math.max(min, v));
    setText(String(clamped));
    onChange(clamped);
  };
  return (
    <span className="stepper">
      <button type="button" onMouseDown={keepFocus} onClick={() => onChange(Math.max(min, value - 1))} disabled={value <= min} aria-label="Fewer" data-testid={`${testId}-down`}>
        −
      </button>
      <input
        type="text"
        inputMode="numeric"
        value={text}
        aria-label="Value"
        data-testid={testId}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit((e.target as HTMLInputElement).value);
            (e.target as HTMLInputElement).blur();
          } else if (e.key === "Escape") {
            setText(String(value));
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      <button type="button" onMouseDown={keepFocus} onClick={() => onChange(Math.min(max, value + 1))} disabled={value >= max} aria-label="More" data-testid={`${testId}-up`}>
        +
      </button>
    </span>
  );
}
