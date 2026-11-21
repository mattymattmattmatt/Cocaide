// The appearance picker: a popover to colour the part, a body, the faces a
// feature makes or an assembly component. Swatches (neutrals, metals, timber,
// colours, clear), the colours used lately, any colour by hex or the system
// picker, a finish and an opacity; and back to what it inherits.
//
// Each choice is one edit (one undo step). A drag (the opacity, the system
// colour picker) shows in the popover as it goes and is kept when it ends.

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { APPEARANCE_FINISHES, hexToRgb, inkOn, parseHex, rgbToHex, sameAppearance, SWATCH_GROUPS, swatchName, type Appearance, type AppearanceFinish, type ResolvedAppearance } from "../../appearance";
import { Icon } from "../icons";

// ------------------------------------------------------------------ the chip

const shade = (hex: string, k: number) => rgbToHex(hexToRgb(hex).map((c) => (k >= 0 ? c + (1 - c) * k : c * (1 + k))) as [number, number, number]);

/** The CSS that paints a look: flat for matte, a soft sheen for satin and gloss, a brushed gradient for metal, checks under clear. */
export function chipStyle(look: Appearance | null, fallback: string): CSSProperties {
  const color = look?.color ?? fallback;
  const finish = look?.finish ?? "satin";
  const layers: string[] = [];
  if (finish === "metallic") layers.push(`linear-gradient(135deg, ${shade(color, 0.45)} 0%, ${color} 42%, ${shade(color, -0.35)} 78%, ${shade(color, 0.15)} 100%)`);
  else if (finish === "gloss") layers.push(`radial-gradient(circle at 32% 28%, rgb(255 255 255 / 0.75) 0 12%, transparent 34%)`, `linear-gradient(160deg, ${shade(color, 0.12)}, ${shade(color, -0.18)})`);
  else if (finish === "satin") layers.push(`linear-gradient(160deg, ${shade(color, 0.1)}, ${shade(color, -0.1)})`);
  else layers.push(`linear-gradient(${color}, ${color})`);
  const opacity = look?.opacity ?? 1;
  if (opacity < 1) {
    // The colour over a checker board, as clear as it is.
    const [r, g, b] = hexToRgb(color).map((c) => Math.round(c * 255));
    layers.splice(0, layers.length, `linear-gradient(rgb(${r} ${g} ${b} / ${opacity}), rgb(${r} ${g} ${b} / ${opacity}))`, "repeating-conic-gradient(#d4d8de 0 25%, #ffffff 0 50%) 50% / 8px 8px");
  }
  return { background: layers.join(", ") };
}

/** A look as a small chip: its colour, finish and clearness at a glance. Dashed when it is inherited. */
export function AppearanceChip({ look, fallback, inherited = false, size = 14, title }: { look: Appearance | null; fallback: string; inherited?: boolean; size?: number; title?: string }) {
  return <span className={`look-chip${inherited ? " inherited" : ""}`} style={{ width: size, height: size, ...chipStyle(look, fallback) }} title={title} aria-hidden={title ? undefined : true} data-look={look?.color ?? fallback} />;
}

/** "Steel, metallic", "#3a7bd5, gloss, 60%": what a look is, in words. */
export function describeAppearance(a: Appearance | null): string {
  if (!a) return "Default";
  const parts = [swatchName(a) ?? a.color];
  if (a.finish && !swatchName(a)) parts.push(a.finish);
  if (a.opacity !== undefined && a.opacity < 1 && !swatchName(a)) parts.push(`${Math.round(a.opacity * 100)}% opaque`);
  return parts.join(", ");
}

/** Where an inherited look comes from, in words: "the part", "its material (steel)", "body lug". */
export function sourceWords(r: ResolvedAppearance | null): string {
  if (!r) return "the default colour";
  switch (r.source) {
    case "feature":
      return `feature ${r.from}`;
    case "body":
      return `body ${r.from}`;
    case "bodyMaterial":
      return `its material${r.from ? ` (${r.from})` : ""}`;
    case "part":
      return "the part";
    case "material":
      return `the part's material${r.from ? ` (${r.from})` : ""}`;
  }
}

// ------------------------------------------------------------------ recent colours

const RECENT_KEY = "cocaide.recentAppearances";
const RECENT_MAX = 8;

function readRecent(): Appearance[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => x && typeof x.color === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function remember(a: Appearance): void {
  try {
    const next = [a, ...readRecent().filter((x) => !sameAppearance(x, a))].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // No storage (a private window): nothing is remembered.
  }
}

// ------------------------------------------------------------------ copy and paste

const COPIED_KEY = "cocaide.copiedAppearance";

/** The appearance copied last (kept in this browser, across parts). */
export function readCopied(): Appearance | null {
  try {
    const v = JSON.parse(localStorage.getItem(COPIED_KEY) ?? "null");
    return v && typeof v.color === "string" ? (v as Appearance) : null;
  } catch {
    return null;
  }
}

/** Copies an appearance to paste elsewhere; returns it. */
export function copyAppearance(a: Appearance): Appearance {
  try {
    localStorage.setItem(COPIED_KEY, JSON.stringify(a));
  } catch {
    // No storage: the copy lasts as long as the picker that holds it.
  }
  return a;
}

// ------------------------------------------------------------------ the picker

const FINISH_LABEL: Record<AppearanceFinish, string> = { matte: "Matte", satin: "Satin", gloss: "Gloss", metallic: "Metallic" };

export interface AppearancePickerProps {
  /** Where it opens (client pixels): beside what was clicked. */
  x: number;
  y: number;
  /** "Body lug", "Feature hole_1", "Part bracket", "Component bolt-2". */
  title: string;
  /** Its own look (null: it inherits). */
  own: Appearance | null;
  /** What it shows without its own, and where that comes from. */
  inherited: ResolvedAppearance | null;
  /** The colour it shows with nothing said at all (the viewport's default for it). */
  fallback: string;
  /** A choice made (null: back to what it inherits). */
  onChange(a: Appearance | null): void;
  /** A look tried without keeping it (a swatch under the pointer, a drag in progress): the view shows it; undefined stops. */
  onPreview?(a: Appearance | null | undefined): void;
  onClose(): void;
  testId?: string;
}

export function AppearancePicker({ x, y, title, own, inherited, fallback, onChange, onPreview, onClose, testId = "appearance-picker" }: AppearancePickerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  // What the popover shows: the stored look, or a drag in progress (opacity, the system picker) not yet kept.
  const [draft, setDraft] = useState<Appearance | null>(null);
  const shown = draft ?? own;
  const base: Appearance = shown ?? inherited?.appearance ?? { color: fallback };
  const [hex, setHex] = useState(base.color);
  const [recent] = useState(readRecent);
  useEffect(() => setHex((shown ?? inherited?.appearance)?.color ?? fallback), [shown, inherited, fallback]);

  // Beside the click, inside the window, before the first paint.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const left = Math.max(8, Math.min(x + 8, window.innerWidth - el.offsetWidth - 8));
    const top = Math.max(8, Math.min(y - 12, window.innerHeight - el.offsetHeight - 8));
    setAt({ left, top });
    el.querySelector<HTMLElement>('[aria-checked="true"], .look-swatch')?.focus({ preventScroll: true });
  }, [x, y]);
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [onClose]);

  // A try in the view ends when the picker closes.
  const previewRef = useRef(onPreview);
  previewRef.current = onPreview;
  useEffect(() => () => previewRef.current?.(undefined), []);
  /** A drag in progress: shown in the popover and in the view, not yet kept. */
  const tryOut = (a: Appearance) => {
    setDraft(a);
    onPreview?.(a);
  };
  const [copied, setCopied] = useState(readCopied);
  const eyedropper = typeof window !== "undefined" && "EyeDropper" in window;
  const commit = (a: Appearance | null) => {
    setDraft(null);
    onPreview?.(undefined);
    if (sameAppearance(a, own)) return;
    if (a) remember(a);
    onChange(a);
  };
  /** The current look with a change to it (a finish, an opacity, a new colour keeping the finish). */
  const withChange = (patch: Partial<Appearance>): Appearance => {
    const next: Appearance = { ...base, ...patch };
    if (next.finish === "satin") delete next.finish;
    if (next.opacity !== undefined && next.opacity >= 1) delete next.opacity;
    return next;
  };
  const finish = base.finish ?? "satin";
  const opacity = Math.round((base.opacity ?? 1) * 100);

  const swatch = (a: Appearance, name: string, key: string) => {
    const on = !!shown && sameAppearance(a, shown);
    return (
      <button
        key={key}
        type="button"
        role="radio"
        aria-checked={on}
        aria-label={name}
        title={name}
        className="look-swatch"
        style={chipStyle(a, a.color)}
        onClick={() => commit(a)}
        onPointerEnter={() => onPreview?.(a)}
        onFocus={() => onPreview?.(a)}
        data-testid={`look-swatch-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
      >
        {on && <span className="look-tick" style={{ color: inkOn(a.color) }}><Icon name="check" size={12} /></span>}
      </button>
    );
  };

  return (
    <div
      ref={ref}
      className="look-picker popup"
      role="dialog"
      aria-label={`Appearance: ${title}`}
      data-testid={testId}
      style={{ left: at?.left ?? x, top: at?.top ?? y, opacity: at ? 1 : 0 }}
      onKeyDown={(e) => {
        // Arrow keys move between swatches in a row.
        if (!(e.target instanceof HTMLElement) || !e.target.classList.contains("look-swatch")) return;
        const all = [...(ref.current?.querySelectorAll<HTMLElement>(".look-swatch") ?? [])];
        const i = all.indexOf(e.target);
        const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : e.key === "ArrowDown" ? 5 : e.key === "ArrowUp" ? -5 : 0;
        if (!step) return;
        e.preventDefault();
        all[Math.max(0, Math.min(all.length - 1, i + step))]?.focus();
      }}
    >
      <header className="look-head">
        <span className="look-preview" style={chipStyle(shown ?? inherited?.appearance ?? null, fallback)} />
        <div className="look-title">
          <strong>{title}</strong>
          <span className="muted" data-testid="look-status">
            {shown ? describeAppearance(shown) : `From ${sourceWords(inherited)}`}
          </span>
        </div>
        <button
          type="button"
          className="icon look-close"
          aria-label="Copy this appearance"
          title="Copy this appearance (to paste on another body, feature or part)"
          disabled={!(shown ?? inherited?.appearance)}
          onClick={() => {
            const a = shown ?? inherited?.appearance;
            if (a) setCopied(copyAppearance(a));
          }}
          data-testid="look-copy"
        >
          <Icon name="copy" size={14} />
        </button>
        <button
          type="button"
          className="icon look-close"
          aria-label="Paste appearance"
          title={copied ? `Paste ${describeAppearance(copied)}` : "Copy an appearance first"}
          disabled={!copied || sameAppearance(copied, own)}
          onClick={() => copied && commit(copied)}
          data-testid="look-paste"
        >
          <Icon name="paste" size={14} />
        </button>
        <button type="button" className="icon look-close" aria-label="Close" onClick={onClose}>
          <Icon name="x" size={14} />
        </button>
      </header>

      <div className="look-body" onPointerLeave={() => !draft && onPreview?.(undefined)}>
        {recent.length > 0 && (
          <section className="look-group">
            <h3>Recent</h3>
            <div className="look-grid" role="radiogroup" aria-label="Recent">
              {recent.map((a, i) => swatch(a, swatchName(a) ?? describeAppearance(a), `r${i}`))}
            </div>
          </section>
        )}
        {SWATCH_GROUPS.map((g) => (
          <section className="look-group" key={g.name}>
            <h3>{g.name}</h3>
            <div className="look-grid" role="radiogroup" aria-label={g.name}>
              {g.swatches.map((s) => swatch(s.appearance, s.name, s.name))}
            </div>
          </section>
        ))}

        <section className="look-group look-custom">
          <h3>Custom</h3>
          <div className="look-row">
            <label className="look-system" title="Any colour (the system picker)" style={chipStyle(withChange({ color: hex.length === 7 ? hex : base.color }), base.color)}>
              <input
                type="color"
                value={parseHex(hex) ?? base.color}
                onInput={(e) => tryOut(withChange({ color: (e.target as HTMLInputElement).value }))}
                onChange={(e) => commit(withChange({ color: e.target.value }))}
                aria-label="Pick any colour"
                data-testid="look-system"
              />
            </label>
            <input
              className="look-hex"
              value={hex}
              spellCheck={false}
              aria-label="Hex colour"
              aria-invalid={!parseHex(hex)}
              onChange={(e) => setHex(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                const c = parseHex(hex);
                if (c) commit(withChange({ color: c }));
              }}
              onBlur={() => {
                const c = parseHex(hex);
                if (c && c !== base.color) commit(withChange({ color: c }));
                else if (!c) setHex(base.color);
              }}
              data-testid="look-hex"
            />
            {eyedropper && (
              <button
                type="button"
                className="look-dropper"
                title="Pick a colour from anywhere on the screen"
                aria-label="Pick a colour from the screen"
                onClick={async () => {
                  try {
                    const r = await new (window as unknown as { EyeDropper: new () => { open(): Promise<{ sRGBHex: string }> } }).EyeDropper().open();
                    const c = parseHex(r.sRGBHex);
                    if (c) commit(withChange({ color: c }));
                  } catch {
                    // Cancelled (Escape): nothing changes.
                  }
                }}
                data-testid="look-dropper"
              >
                <Icon name="eyedropper" size={15} />
              </button>
            )}
          </div>
        </section>

        <section className="look-group">
          <h3>Finish</h3>
          <div className="look-seg" role="radiogroup" aria-label="Finish">
            {APPEARANCE_FINISHES.map((f) => (
              <button key={f} type="button" role="radio" aria-checked={finish === f} onClick={() => commit(withChange({ finish: f }))} data-testid={`look-finish-${f}`}>
                {FINISH_LABEL[f]}
              </button>
            ))}
          </div>
        </section>

        <section className="look-group">
          <h3>
            Opacity <span className="look-value">{opacity}%</span>
          </h3>
          <input
            type="range"
            className="look-range"
            min={10}
            max={100}
            step={5}
            value={opacity}
            aria-label="Opacity, percent"
            style={{ "--look-fill": `${((opacity - 10) / 90) * 100}%` } as CSSProperties}
            onChange={(e) => tryOut(withChange({ opacity: Number(e.target.value) / 100 }))}
            onPointerUp={(e) => commit(withChange({ opacity: Number((e.target as HTMLInputElement).value) / 100 }))}
            onKeyUp={(e) => commit(withChange({ opacity: Number((e.target as HTMLInputElement).value) / 100 }))}
            data-testid="look-opacity"
          />
        </section>
      </div>

      <footer className="look-foot">
        <button type="button" className="link" disabled={!own} onClick={() => commit(null)} title={own ? `Show ${sourceWords(inherited)}'s look again` : "It already shows what it inherits"} data-testid="look-reset">
          <Icon name="undo" size={13} /> {inherited ? `Use ${sourceWords(inherited)}` : "Use the default"}
        </button>
        <button type="button" className="primary small" onClick={onClose} data-testid="look-done">
          Done
        </button>
      </footer>
    </div>
  );
}
