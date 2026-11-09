// The detailing plan as a card (Phase Q wave Q3B): what "Fully detail this
// drawing" will add, item by item with why, grouped; the user unticks what
// they do not want and changes the standard, the general tolerance, the
// position tolerance and the general surface texture, then details it with
// the AI (the model starts from the plan and refines it) or by rules only.

import { useMemo, useState } from "react";
import { PLAN_GROUP_LABELS, PLAN_GROUPS, toleranceChoices, type DetailOptions, type DetailPlan } from "../../ask/detail/plan";

export interface DetailPlanCardProps {
  plan: DetailPlan;
  /** Runs the plan as the user left it: by the model ("ai"), or by rules only. */
  onRun(plan: DetailPlan, how: "ai" | "rules"): void;
  /** No model is set up: the AI button says so. */
  aiReady?: boolean;
  /** What the AI button says ("Detail with AI", "Detail with Claude Code"). */
  aiLabel?: string;
  /** Hide the AI button (the session's Auto-detail). */
  rulesOnly?: boolean;
}

export function DetailPlanCard({ plan, onRun, aiReady = true, aiLabel = "Detail with AI", rulesOnly = false }: DetailPlanCardProps) {
  const [on, setOn] = useState<Record<string, boolean>>(() => Object.fromEntries(plan.items.map((i) => [i.id, i.on])));
  const [options, setOptions] = useState<DetailOptions>(plan.options);
  const choices = useMemo(() => {
    const list = toleranceChoices(plan.intent);
    return list.includes(options.generalTolerance) ? list : [options.generalTolerance, ...list];
  }, [plan.intent, options.generalTolerance]);
  const edited = (): DetailPlan => ({ ...plan, options, items: plan.items.map((i) => ({ ...i, on: on[i.id] ?? i.on })) });
  const count = Object.values(on).filter(Boolean).length;
  const set = (patch: Partial<DetailOptions>) => setOptions((o) => ({ ...o, ...patch }));
  return (
    <div className="intent-card detail-card" data-testid="detail-plan">
      <div className="detail-intent muted small">{plan.intent.summary}</div>
      <div className="detail-options">
        <label>
          Standard
          <select value={options.standard} onChange={(e) => set({ standard: e.target.value as DetailOptions["standard"] })} data-testid="detail-standard">
            <option value="ISO">ISO</option>
            <option value="ASME">ASME</option>
          </select>
        </label>
        <label>
          General tolerance
          <select value={options.generalTolerance} onChange={(e) => set({ generalTolerance: e.target.value })} data-testid="detail-tolerance">
            {choices.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        {plan.intent.kind !== "weldment" && (
          <>
            <label title="The position tolerance of hole patterns (a Ø zone, mm)">
              Position Ø
              <select value={String(options.position)} onChange={(e) => set({ position: Number(e.target.value) })} data-testid="detail-position">
                {[0.05, 0.1, 0.2, 0.3, 0.5].map((v) => (
                  <option key={v} value={String(v)}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label title="The general surface texture for every surface not marked">
              Surface
              <select value={options.roughness ?? ""} onChange={(e) => set({ roughness: e.target.value || null })} data-testid="detail-roughness">
                {["Ra 3.2", "Ra 6.3", "Ra 12.5"].map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
                <option value="">as made</option>
              </select>
            </label>
          </>
        )}
      </div>
      <div className="detail-items" data-testid="detail-items">
        {PLAN_GROUPS.map((g) => {
          const list = plan.items.filter((i) => i.group === g);
          if (!list.length) return null;
          return (
            <fieldset key={g} className="detail-group">
              <legend>{PLAN_GROUP_LABELS[g]}</legend>
              {list.map((i) => {
                const blocked = (i.needs ?? []).some((n) => on[n] === false);
                return (
                  <label key={i.id} className={`check detail-item${blocked ? " blocked" : ""}`} title={blocked ? `${i.why} (needs ${(i.needs ?? []).filter((n) => on[n] === false).join(", ")})` : i.why}>
                    <input type="checkbox" checked={!!on[i.id]} onChange={(e) => setOn((m) => ({ ...m, [i.id]: e.target.checked }))} data-testid={`detail-item-${i.id}`} />
                    <span>{i.label}</span>
                  </label>
                );
              })}
            </fieldset>
          );
        })}
      </div>
      <div className="ask-buttons">
        {!rulesOnly && (
          <button className="primary" disabled={!count || !aiReady} title={aiReady ? "The model starts from this plan, refines it and checks the result" : "Set up a model to detail with AI"} onClick={() => onRun(edited(), "ai")} data-testid="detail-run-ai">
            {aiLabel}
          </button>
        )}
        <button className={rulesOnly ? "primary" : ""} disabled={!count} title="Carry out the plan by rules only, no model" onClick={() => onRun(edited(), "rules")} data-testid="detail-run-rules">
          {rulesOnly ? "Apply the plan" : "Rules only"}
        </button>
        <span className="muted small">{count} of {plan.items.length}</span>
      </div>
    </div>
  );
}
