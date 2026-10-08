// Which model answers right-click asks, and how the page reaches it.

import { useState } from "react";
import { MODELS, type Effort } from "../../ask/models";
import { logText, readLog } from "./log";
import { HAS_PROXY, type AskSettings } from "./settings";

interface Props {
  settings: AskSettings;
  onSave(s: AskSettings): void;
  onClose(): void;
}

export function AskSettingsDialog({ settings, onSave, onClose }: Props) {
  const [s, setS] = useState(settings);
  const effort = MODELS.find((m) => m.id === s.model)?.effort ?? false;
  const entries = readLog().length;
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="modal"
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
        <h3 className="modal-section">Units</h3>
        <div className="field">
          <span className="field-label">Lengths</span>
          <span className="units-readout" data-testid="settings-units">
            Millimetres (mm), metric
          </span>
        </div>
        <p className="muted small">Every length is in millimetres, angles in degrees and mass in kilograms. Parts are saved in millimetres.</p>
        <h3 className="modal-section">Assistant</h3>
        <p className="muted small">
          Right-click a feature, face, edge, sketch entity or failed rebuild to ask about it. The ask sends that thing's context packet to the model,
          never the whole part. Modelling and STEP export work without any of this.
        </p>
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
        <div className="modal-buttons">
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
