// The model toolbar as SOLIDWORKS's CommandManager: Undo, Redo and Sketch
// always at hand on the left, then tabs of tools (Features, Reference,
// Bodies, Weldments, Evaluate), each tab's tools in groups. Everything comes
// from the tool registry; the tab last shown is remembered in this browser.

import { Fragment, useState } from "react";
import { keyFor, keyHint, type InputPrefs } from "../input";
import { MenuItem, ToolButton, ToolMenu } from "../tools";
import { toolbarGroups, visibleTabs, type ToolbarEntry } from "./registry";
import type { TabDef } from "./tabs";
import type { ToolCtx, ToolDef, ToolItem, ToolTab } from "./ToolContext";

const TAB_KEY = "cocaide.toolTab.v1";

function storedTab(): string | null {
  try {
    return localStorage.getItem(TAB_KEY);
  } catch {
    return null;
  }
}

/** The tab shown: the one chosen last if it is still there, else the first. */
function useToolTab(tabs: TabDef[]): [ToolTab, (t: ToolTab) => void] {
  const [chosen, setChosen] = useState<string | null>(storedTab);
  const tab = tabs.find((t) => t.id === chosen)?.id ?? tabs[0]?.id ?? "features";
  const choose = (t: ToolTab) => {
    setChosen(t);
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {
      // Private windows may refuse: the tab still holds for this visit.
    }
  };
  return [tab, choose];
}

interface Props {
  ctx: ToolCtx;
  prefs: InputPrefs;
  /** Runs a tool by id (or says why it can't run), as a key or the shortcut bar would. */
  runTool(id: string): void;
  /** Runs one choice of a tool's own dropdown. */
  runItem(tool: ToolDef, item: ToolItem): void;
  undo(): void;
  redo(): void;
  canUndo: boolean;
  canRedo: boolean;
}

export function CommandManager({ ctx, prefs, runTool, runItem, undo, redo, canUndo, canRedo }: Props) {
  const tabs = visibleTabs();
  const [tab, setTab] = useToolTab(tabs);

  const button = (t: ToolDef) => {
    const why = t.disabled?.(ctx);
    const title = why ?? `${t.title}${keyHint(t.id, prefs)}`;
    // With what to work on selected, a tool's dropdown gives way to running it (Sketch on the selected plane).
    const direct = !why && t.items ? t.direct?.(ctx) : undefined;
    if (direct) return <ToolButton key={t.id} icon={t.icon} label={t.label} onClick={() => runTool(t.id)} title={`${direct}${keyHint(t.id, prefs)}`} testId={t.testId} />;
    if (!t.items) return <ToolButton key={t.id} icon={t.icon} label={t.label} onClick={() => runTool(t.id)} disabled={!!why} title={title} testId={t.testId} />;
    return (
      <ToolMenu key={t.id} icon={t.icon} label={t.label} title={title} testId={t.testId} disabled={!!why}>
        {(close) =>
          t.items!(ctx).map((item) => (
            <MenuItem
              key={item.label}
              icon={item.icon}
              label={item.label}
              hint={item.hint}
              disabled={item.disabled}
              onClick={() => {
                close();
                runItem(t, item);
              }}
              testId={item.testId}
            />
          ))
        }
      </ToolMenu>
    );
  };

  const entry = (e: ToolbarEntry) => {
    if (e.kind === "tool") return button(e.tool);
    return (
      <ToolMenu key={e.menu.id} icon={e.menu.icon} label={e.menu.label} title={e.menu.title} testId={e.menu.testId}>
        {(close) =>
          e.tools.map((t) => {
            const why = t.disabled?.(ctx);
            return (
              <MenuItem
                key={t.id}
                icon={t.icon}
                label={t.label}
                hint={why ?? t.hint}
                shortcut={keyFor(t.id, prefs) ?? undefined}
                disabled={!!why}
                onClick={() => {
                  close();
                  runTool(t.id);
                }}
                testId={t.testId}
              />
            );
          })
        }
      </ToolMenu>
    );
  };

  const groups = (g: ToolbarEntry[][]) => g.map((entries, i) => <Fragment key={i}>{i > 0 && <span className="sep" />}{entries.map(entry)}</Fragment>);

  return (
    <div className="toolbar command-manager" role="toolbar" aria-label="Modelling">
      <div className="cm-pinned">
        <ToolButton icon="undo" label="Undo" onClick={undo} disabled={!canUndo} title={`Undo${keyHint("undo", prefs)}`} testId="undo" />
        <ToolButton icon="redo" label="Redo" onClick={redo} disabled={!canRedo} title={`Redo${keyHint("redo", prefs)}`} testId="redo" />
        <span className="sep" />
        {groups(toolbarGroups("pinned"))}
      </div>
      <span className="sep cm-sep" />
      <div className="cm-body">
        <div className="cm-tools" role="tabpanel" id="cm-panel" aria-labelledby={`cm-tab-${tab}`}>
          {groups(toolbarGroups(tab))}
        </div>
        <div className="cm-tabs" role="tablist" aria-label="Tool tabs">
          {tabs.map((t) => (
            <button
              key={t.id}
              role="tab"
              id={`cm-tab-${t.id}`}
              className="cm-tab"
              aria-selected={t.id === tab}
              aria-controls="cm-panel"
              // A click doesn't take the keyboard: Space and Enter stay the view menu and Repeat.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setTab(t.id)}
              data-testid={`tab-${t.id}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
