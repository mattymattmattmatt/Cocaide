// Live link: the app follows a .cocaide.json file on this computer through
// the bridge, read-only, and shows each new version as it is saved. Made for
// Claude Code in a terminal with the cocaide MCP server on that file: the
// browser shows the part change as Claude works. The user's own document is
// untouched while following; "Open a copy" makes the followed part theirs.

import { useCallback, useEffect, useRef, useState } from "react";
import { BridgeClient } from "../../ask/bridge/client";
import type { RawDocument } from "../../doc/commands";
import { parseDocumentText } from "../../doc/format";
import type { BridgeAskSettings } from "./settings";

export interface FollowState {
  path: string;
  status: "connecting" | "following" | "problem";
  /** The followed part as last read (null until the first read). */
  doc: RawDocument | null;
  text: string;
  updates: number;
  message?: string;
}

export function useFollow() {
  const [state, setState] = useState<FollowState | null>(null);
  const client = useRef<BridgeClient | null>(null);

  const stop = useCallback(() => {
    client.current?.send({ type: "unfollow" });
    client.current?.close();
    client.current = null;
    setState(null);
  }, []);

  const start = useCallback(async (path: string, bridge: BridgeAskSettings) => {
    client.current?.close();
    const c = new BridgeClient(bridge.url, bridge.token);
    client.current = c;
    setState({ path, status: "connecting", doc: null, text: "", updates: 0 });
    try {
      await c.connect();
    } catch (e) {
      if (client.current === c) setState({ path, status: "problem", doc: null, text: "", updates: 0, message: (e as Error).message });
      return;
    }
    if (client.current !== c) return c.close();
    c.on((m) => {
      if (client.current !== c) return;
      if (m.type === "follow") {
        const p = parseDocumentText(m.text);
        const doc = p.ok && p.value && typeof p.value === "object" && Array.isArray((p.value as RawDocument).features) ? (p.value as RawDocument) : null;
        setState((s) =>
          doc
            ? { path: m.path, status: "following", doc, text: m.text, updates: (s?.updates ?? 0) + 1 }
            : { ...(s ?? { path, doc: null, text: "", updates: 0 }), status: "problem", message: "The file is not a Cocaide part (no features list)." },
        );
      } else if (m.type === "followError") {
        setState((s) => ({ ...(s ?? { path, doc: null, text: "", updates: 0 }), status: s?.doc ? "following" : "problem", message: m.message }));
      }
    });
    c.onClose(() => {
      if (client.current === c) setState((s) => s && { ...s, status: "problem", message: "The bridge closed the connection. Start it again with `npm run bridge`, then follow the file again." });
    });
    c.send({ type: "follow", path });
  }, []);

  useEffect(() => () => client.current?.close(), []);

  return { state, start, stop, doc: state?.doc ?? null, active: !!state };
}
