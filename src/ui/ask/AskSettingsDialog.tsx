// Settings: the units, the mouse, the keyboard shortcuts, and which model
// answers right-click asks. The mouse and keys apply as you change them and
// are kept in this browser; the assistant's settings apply on Save.

import { useEffect, useState } from "react";
import { MODELS, type Effort } from "../../ask/models";
import { Icon } from "../icons";
import { bindKey, COMMAND_GROUPS, COMMANDS, keyFor, keyOf, resetInputPrefs, setInputPrefs, useInputPrefs, type MouseScheme } from "../input";
import { logText, readLog } from "./log";
import { loadSpin, saveSpin } from "../sketcher/modify";
import { MAX_ROTATE_SPEED, MIN_ROTATE_SPEED, resetViewPrefs, setViewPrefs, useViewPrefs } from "../viewport/viewPrefs";
import { HAS_PROXY, type AskSettings } from "./settings";

export type SettingsTab = "units" | "mouse" | "keyboard" | "assistant";
const TABS: [SettingsTab, string][] = [
  ["units", "Units"],
  ["mouse", "Mouse"],
  ["keyboard", "Keyboard"],
  ["assistant", "Assistant"],
];

interface Props {
  settings: AskSettings;
  onSave(s: AskSettings): void;
  onClose(): void;
  tab?: SettingsTab;
}

export function AskSettingsDialog({ settings, onSave, onClose, tab: initial = "assistant" }: Props) {
  const [s, setS] = useState(settings);
  const [tab, setTab] = useState<SettingsTab>(initial);
  const effort = MODELS.find((m) => m.id === s.model)?.effort ?? false;
  const entries = readLog().length;
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="modal settings"
        role="dialog"
        aria-label="Settings"
        data-testid="ask-settings"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(s);
          onClose();
        }}
      >
        <h2>Settings</h2>
        <div className="tabs settings-tabs" role="tablist">
          {TABS.map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)} data-testid={`settings-tab-${id}`}>
              {label}
            </button>
          ))}
        </div>
        <div className="settings-body">
          {tab === "units" && <UnitsTab />}
          {tab === "mouse" && <MouseTab />}
          {tab === "keyboard" && <KeyboardTab />}
          {tab === "assistant" && (
            <>
              <p className="muted small">
                Right-click anything (a feature, face, edge, sketch entity, failed rebuild) and choose Ask AI… to ask about it or change it. The ask sends what
                you right-clicked to the model, with an outline of the part when it may change the whole part. Every change is a proposal you accept or
                discard. Modelling and STEP export work without any of this.
              </p>
              <label className="field">
                <span className="field-label">May change</span>
                <select value={s.reach} onChange={(e) => setS({ ...s, reach: e.target.value as AskSettings["reach"] })} data-testid="ask-reach-default">
                  <option value="part">The whole part (what you right-click is the focus)</option>
                  <option value="target">Only what you right-click</option>
                </select>
              </label>
              <label className="field">
                <span className="field-label">Model</span>
                <select value={s.model} onChange={(e) => setS({ ...s, model: e.target.value })} data-testid="ask-model">
                  {MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
              {effort && (
                <label className="field">
                  <span className="field-label">Effort</span>
                  <select value={s.effort} onChange={(e) => setS({ ...s, effort: e.target.value as Effort })}>
                    <option value="low">Low (fastest)</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </select>
                </label>
              )}
              <label className="field">
                <span className="field-label">API key</span>
                <input
                  type="password"
                  autoComplete="off"
                  placeholder={HAS_PROXY ? "Not needed: the dev server adds it" : "sk-ant-…"}
                  value={s.apiKey}
                  onChange={(e) => setS({ ...s, apiKey: e.target.value })}
                  data-testid="ask-api-key"
                />
              </label>
              <p className="muted small">
                {HAS_PROXY
                  ? "The dev server holds ANTHROPIC_API_KEY and forwards asks to the Anthropic API, so this page never sees a key. A key typed here is used instead."
                  : "The key is kept in this browser only and sent only to api.anthropic.com. To keep it out of the page, start the dev server with ANTHROPIC_API_KEY set instead."}
              </p>
            </>
          )}
        </div>
        <div className="modal-buttons">
          {tab === "assistant" && (
            <button
              type="button"
              disabled={entries === 0}
              onClick={() => {
                const url = URL.createObjectURL(new Blob([logText()], { type: "application/jsonl" }));
                const a = document.createElement("a");
                a.href = url;
                a.download = "cocaide-asks.jsonl";
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              }}
            >
              Download ask log ({entries})
            </button>
          )}
          {(tab === "mouse" || tab === "keyboard") && (
            <button
              type="button"
              onClick={() => {
                resetInputPrefs();
                resetViewPrefs();
              }}
              data-testid="settings-reset-input"
              title="The mouse, the view's rotation and every key back to their defaults"
            >
              Reset to defaults
            </button>
          )}
          <span className="sep" />
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" data-testid="ask-settings-save">
            Save
          </button>
        </div>
      </form>
    </div>
  );
}

function UnitsTab() {
  return (
    <>
      <div className="field">
        <span className="field-label">Lengths</span>
        <span className="units-readout" data-testid="settings-units">
          Millimetres (mm), metric
        </span>
      </div>
      <p className="muted small">Every length is in millimetres, angles in degrees and mass in kilograms. Parts are saved in millimetres.</p>
      <SpinSteps />
    </>
  );
}

/** The Modify box's spin buttons (and ↑/↓): how far one step goes, kept in this browser. */
function SpinSteps() {
  const [text, setText] = useState(() => {
    const s = loadSpin();
    return { length: String(s.length), angle: String(s.angle) };
  });
  const field = (key: keyof typeof text, label: string, unit: string) => (
    <label className="field">
      <span className="field-label">{label}</span>
      <span className="row">
        <input
          type="number"
          min={0}
          step="any"
          value={text[key]}
          aria-invalid={!(Number(text[key]) > 0) || undefined}
          onChange={(e) => {
            const next = { ...text, [key]: e.target.value };
            setText(next);
            // Saved once both are steps above zero; a field being retyped waits.
            const length = Number(next.length);
            const angle = Number(next.angle);
            if (length > 0 && angle > 0 && Number.isFinite(length + angle)) saveSpin({ length, angle });
          }}
          data-testid={`settings-spin-${key}`}
        />
        <span className="unit">{unit}</span>
      </span>
    </label>
  );
  return (
    <fieldset className="spin-steps">
      <legend>Spin box increments (the Modify box's ▲▼ and arrow keys)</legend>
      {field("length", "Length", "mm")}
      {field("angle", "Angle", "°")}
    </fieldset>
  );
}

/** What each mouse action does, by scheme: the reference beside the choice. */
const MOUSE_ROWS: Record<MouseScheme, [string, string][]> = {
  standard: [
    ["Middle-drag", "Rotate: the part spins in place, about its middle (zoomed in, about the part in the middle of the view)"],
    ["Ctrl + middle-drag", "Pan"],
    ["Shift + middle-drag", "Zoom"],
    ["Alt + middle-drag", "Roll in the screen"],
    ["Middle-click the part", "Pin the rotation centre there (a marker shows it); middle-click empty space or Esc to clear it"],
    ["Middle double-click", "Zoom to fit"],
    ["Drag the view cube", "Turn the view, as a middle-drag does; click a face, an edge or a corner to look from there"],
    ["Wheel", "Zoom at the pointer: toward you zooms in"],
    ["Left-click", "Select; Ctrl- or Shift-click adds"],
    ["Alt + left-click", "Select the face behind the one under the pointer (again: the next one behind)"],
    ["Left-drag", "Box select: left to right takes what is inside, right to left what it touches"],
    ["Right-click", "The menu for what is under the pointer: Select other…, Ask AI…"],
    ["Right-drag", "Pan"],
  ],
  trackpad: [
    ["Drag", "Rotate the part in place (in a sketch: dragging empty space; pan in a drawing)"],
    ["Shift + drag", "Pan"],
    ["Two-finger scroll or pinch", "Zoom at the pointer"],
    ["Click", "Select; Ctrl- or Shift-click adds"],
    ["Alt + click", "Select the face behind the one under the pointer"],
    ["Right-click (two-finger click)", "The menu for what is under the pointer: Select other…, Ask AI…"],
    ["Right-drag", "Pan"],
    ["Middle button", "As in the standard scheme, if there is one: middle-click the part pins the rotation centre"],
  ],
};

function MouseTab() {
  const prefs = useInputPrefs();
  const view = useViewPrefs();
  const speed = Math.round(view.rotateSpeed * 100);
  return (
    <>
      <div className="field">
        <span className="field-label">Mouse</span>
        <select value={prefs.mouse} onChange={(e) => setInputPrefs({ ...prefs, mouse: e.target.value as MouseScheme })} data-testid="settings-mouse">
          <option value="standard">Standard (middle button rotates)</option>
          <option value="trackpad">Trackpad (left-drag rotates)</option>
        </select>
      </div>
      <label className="check settings-check">
        <input type="checkbox" checked={prefs.reverseWheel} onChange={(e) => setInputPrefs({ ...prefs, reverseWheel: e.target.checked })} data-testid="settings-reverse-wheel" />
        Reverse the wheel's zoom direction
      </label>
      <div className="field">
        <span className="field-label">Rotation speed</span>
        <span className="row settings-speed">
          <input
            type="range"
            min={MIN_ROTATE_SPEED * 100}
            max={MAX_ROTATE_SPEED * 100}
            step={10}
            value={speed}
            onChange={(e) => setViewPrefs({ ...view, rotateSpeed: Number(e.target.value) / 100 })}
            aria-label="Rotation speed, per cent"
            aria-valuetext={`${speed} %`}
            title="At 100 %, dragging across the view's height turns the part half a turn"
            data-testid="settings-rotate-speed"
          />
          <output data-testid="settings-rotate-speed-value">{speed} %</output>
        </span>
      </div>
      <label className="check settings-check" title="Rotating turns about the vertical (Z) and tips up and down, never rolling the part over: like a turntable">
        <input type="checkbox" checked={view.turntable} onChange={(e) => setViewPrefs({ ...view, turntable: e.target.checked })} data-testid="settings-turntable" />
        Keep Z up while rotating
      </label>
      <label className="check settings-check" title="Standard views, Fit, the view cube, named views and Previous view glide over a quarter of a second (never with the system's reduce motion)">
        <input type="checkbox" checked={view.animate} onChange={(e) => setViewPrefs({ ...view, animate: e.target.checked })} data-testid="settings-animate" />
        Animate view changes
      </label>
      <label className="check settings-check" title="Opening a sketch (a new one, or one you edit) turns the view square onto its plane, its x to the right">
        <input type="checkbox" checked={view.sketchFace} onChange={(e) => setViewPrefs({ ...view, sketchFace: e.target.checked })} data-testid="settings-sketch-face" />
        Turn to face the sketch when it opens
      </label>
      <label className="check settings-check" title="Finishing or cancelling a sketch turns the view back to where it was before the sketch opened">
        <input type="checkbox" checked={view.sketchReturn} onChange={(e) => setViewPrefs({ ...view, sketchReturn: e.target.checked })} data-testid="settings-sketch-return" />
        Return to the previous view after a sketch
      </label>
      <table className="settings-table" data-testid="mouse-table">
        <tbody>
          {MOUSE_ROWS[prefs.mouse].map(([how, what]) => (
            <tr key={how}>
              <th>{how}</th>
              <td>{how === "Wheel" && prefs.reverseWheel ? "Zoom at the pointer: away from you zooms in" : what}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">Changes apply at once and are kept in this browser.</p>
    </>
  );
}

function KeyboardTab() {
  const prefs = useInputPrefs();
  const [recording, setRecording] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // While recording, the next key press is the new key: Escape keeps the old one, Backspace clears it.
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") return setRecording(null);
      const key = e.key === "Backspace" ? null : keyOf(e);
      // A modifier on its own: wait for the key it goes with.
      if (key === null && e.key !== "Backspace") return;
      const label = COMMANDS.find((c) => c.id === recording)?.label ?? recording;
      if (key && /^Ctrl\+(N|T|W)$/.test(key)) {
        setNote(`${key} belongs to the browser and can't be used. Pick another.`);
        return;
      }
      const lost = bindKey(recording, key);
      setNote(key ? `${label}: ${key}${lost ? `, taken from ${lost}` : ""}.` : `${label}: no key.`);
      setRecording(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording]);
  return (
    <>
      <p className="muted small">
        Click a key to change it, then press the new one. Backspace clears it, Escape keeps it. The defaults are the standard CAD ones; Ctrl+N, Ctrl+T and Ctrl+W belong
        to the browser.
      </p>
      {note && (
        <p className="small settings-note" role="status" data-testid="keys-note">
          {note}
        </p>
      )}
      <div className="keys-scroll">
        <table className="settings-table keys" data-testid="keys-table">
          {COMMAND_GROUPS.map((g) => (
            <tbody key={g}>
              <tr>
                <th colSpan={2} className="keys-group">
                  {g}
                </th>
              </tr>
              {COMMANDS.filter((c) => c.group === g && !c.planned).map((c) => {
                const k = keyFor(c.id, prefs);
                const changed = c.id in prefs.keys;
                return (
                  <tr key={c.id}>
                    <td>{c.label}</td>
                    <td className="key-cell">
                      <button
                        type="button"
                        className={`key-chip${recording === c.id ? " recording" : ""}${k ? "" : " none"}${changed ? " changed" : ""}`}
                        onClick={() => {
                          setNote(null);
                          setRecording(recording === c.id ? null : c.id);
                        }}
                        title={changed ? `Changed from ${c.key ?? "none"}` : "Click, then press a key"}
                        data-testid={`key-${c.id}`}
                      >
                        {recording === c.id ? (
                          "Press a key…"
                        ) : k ? (
                          <kbd>{k}</kbd>
                        ) : (
                          <>
                            <Icon name="plus" size={12} />
                            add
                          </>
                        )}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          ))}
        </table>
      </div>
    </>
  );
}
