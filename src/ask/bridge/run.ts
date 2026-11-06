// An ask answered by Claude Code through the local bridge (src/bridge): the
// whole agent loop runs in Claude Code with Cocaide's MCP tools, on a copy of
// the document. Every new version of that copy comes back while it works and
// is shown live; at the end the difference is a proposal like any other ask's
// (Accept keeps it as one undo step, Discard leaves the part as it was).

import type { RawDocument } from "../../doc/commands";
import { parseDocumentText, formatDocument } from "../../doc/format";
import { validateDocument } from "../../doc/validate";
import type { ServerMessage, BridgeAttachment, BridgeModel } from "../../bridge/protocol";
import { diffDocs, earlierText, type AskCall, type AskReach, type AskResult, type EarlierTurn, type Proposal } from "../agent";
import type { Attachment } from "../attachments";
import type { KernelPort } from "../kernel";
import { buildPacket, partOutline, scopeFor, type AskTarget, type Packet } from "../packet";
import { BridgeClient, BridgeError, bridgeFix } from "./client";

export interface LiveStep {
  id: string;
  /** The Cocaide tool ("addFeature"), or another tool's name. */
  name: string;
  args: string;
  status: "running" | "ok" | "error";
  error?: string;
}

/** What the AI panel shows while Claude Code works. */
export interface LiveState {
  phase: "connecting" | "running";
  steps: LiveStep[];
  /** What Claude Code is saying now (since its last tool call). */
  text: string;
  /** The working copy as it is now (null until the first change). */
  doc: RawDocument | null;
  /** How many versions of the part have come back. */
  updates: number;
  model?: string;
  notices: string[];
}

export interface BridgeSettings {
  url: string;
  token: string;
  model: BridgeModel;
}

export interface BridgeAskRequest {
  doc: RawDocument;
  target: AskTarget;
  text: string;
  reach?: AskReach;
  kernel: KernelPort;
  bridge: BridgeSettings;
  attachments?: Attachment[];
  /** The Claude Code session to continue (a follow-up). */
  resume?: string;
  /** A follow-up with no session to continue: the earlier turns go in as text. */
  earlier?: EarlierTurn[];
  signal?: AbortSignal;
  onLive?(s: LiveState): void;
  /** Tests: a client that is not a browser WebSocket. */
  client?: BridgeClient;
}

export interface BridgeAskResult extends AskResult {
  /** The Claude Code session, for a follow-up. */
  sessionId?: string;
  costUsd?: number;
}

/** The longest context packet sent (characters). Claude Code can read more with the tools. */
const CONTEXT_LIMIT = 60_000;

export function bridgeAttachments(atts: Attachment[]): BridgeAttachment[] {
  return atts.map((a) =>
    a.data && (a.kind === "image" || a.kind === "pdf")
      ? { name: a.name, mediaType: a.mediaType, data: a.data }
      : { name: a.name, mediaType: a.mediaType, text: a.text ?? "" },
  );
}

/** What the ask may change: everything for the part or a whole-part reach, else the target's scope. */
export function bridgeScope(doc: RawDocument, target: AskTarget, reach?: AskReach): string[] {
  return target.kind === "part" || reach === "part" ? ["*"] : scopeFor(doc, target);
}

export function contextText(packet: Packet | null, earlier?: EarlierTurn[]): string {
  const parts = [earlier?.length ? earlierText(earlier) : "", packet ? JSON.stringify(packet) : ""].filter(Boolean);
  const text = parts.join("\n\n");
  return text.length > CONTEXT_LIMIT ? `${text.slice(0, CONTEXT_LIMIT)}\n… (cut; use the tools to read the rest)` : text;
}

/** The proposal for what Claude Code did: the whole new document, with its changes listed. */
export function bridgeProposal(base: RawDocument, doc: RawDocument, volumes: { before: number | null; after: number | null } = { before: null, after: null }): Proposal {
  const changes = diffDocs(base, doc);
  return {
    replace: true,
    bridge: true,
    commands: [],
    scope: ["*"],
    base,
    doc,
    changes,
    touched: changes.map((c) => c.id),
    volumeBefore: volumes.before,
    volumeAfter: volumes.after,
  };
}

const failed = (text: string, model: string): BridgeAskResult => ({ outcome: "failed", text, mode: "edit", visual: false, packet: null, proposal: null, calls: [], model, turns: 0 });

export async function runBridgeAsk(req: BridgeAskRequest): Promise<BridgeAskResult> {
  const model = `Claude Code${req.bridge.model === "default" ? "" : ` (${req.bridge.model})`}`;
  const live: LiveState = { phase: "connecting", steps: [], text: "", doc: null, updates: 0, notices: [] };
  const show = () => req.onLive?.({ ...live, steps: live.steps.map((s) => ({ ...s })), notices: [...live.notices] });
  show();

  let packet: Packet | null = null;
  try {
    packet = await buildPacket(req.doc, req.target, req.kernel);
    const scope = bridgeScope(req.doc, req.target, req.reach);
    packet.writeScope = scope;
    if (req.reach === "part" && req.target.kind !== "part") packet.part = partOutline(req.doc, await req.kernel.check(req.doc));
  } catch {
    packet = null; // the tools can read the part
  }
  const scope = bridgeScope(req.doc, req.target, req.reach);

  const client = req.client ?? new BridgeClient(req.bridge.url, req.bridge.token);
  try {
    const claude = await client.connect();
    if (!claude.installed) return failed(claude.problem ?? "Claude Code is not installed on this computer.", model);
    if (claude.loggedIn === false) return failed(claude.problem ?? "Claude Code is not logged in.", model);
  } catch (e) {
    client.close();
    return failed(e instanceof BridgeError ? e.message : `Could not reach the bridge: ${(e as Error).message}. ${bridgeFix("unreachable")}`, model);
  }
  if (req.signal?.aborted) {
    client.close();
    return failed("Cancelled.", model);
  }

  const id = `ask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const calls: AskCall[] = [];
  let latest: string | null = null;
  const done = await new Promise<Extract<ServerMessage, { type: "done" }> | null>((resolve) => {
    const off = client.on((m) => {
      if ("id" in m && m.id !== id) return;
      switch (m.type) {
        case "init":
          live.phase = "running";
          if (m.model) live.model = m.model;
          if (m.mcp && m.mcp !== "connected") live.notices.push(`Cocaide's tools: ${m.mcp}`);
          break;
        case "text":
          live.text += m.text;
          break;
        case "tool":
          live.text = "";
          live.steps.push({ id: m.callId, name: m.name, args: m.args, status: "running" });
          break;
        case "toolResult": {
          const s = live.steps.find((x) => x.id === m.callId);
          if (s) {
            s.status = m.ok ? "ok" : "error";
            if (m.error) s.error = m.error;
            calls.push({ tool: s.name, input: s.args, ok: m.ok, ...(m.error ? { error: m.error } : {}), revision: live.updates, hash: "" });
          }
          break;
        }
        case "doc": {
          const p = parseDocumentText(m.text);
          // Only a version the document checks accept is shown live: a half-written
          // or malformed one is skipped (the next one replaces it), never drawn.
          const value = p.ok ? p.value : null;
          let usable = !!value && typeof value === "object" && Array.isArray((value as RawDocument).features);
          if (usable) {
            try {
              usable = validateDocument(value).headerErrors.length === 0;
            } catch {
              usable = false;
            }
          }
          if (!usable) live.notices.push("Skipped a version of the part that did not pass the document checks.");
          if (usable && p.ok) {
            latest = m.text;
            live.doc = p.value as RawDocument;
            live.updates++;
          }
          break;
        }
        case "notice":
          live.notices.push(m.text);
          break;
        case "error":
          live.notices.push(m.message);
          if (m.code === "busy" || m.code === "bad-request") {
            off();
            resolve({ type: "done", id, ok: false, text: m.message, errorKind: "error" });
          }
          return;
        case "done":
          off();
          offClose();
          resolve(m);
          return;
        default:
          return;
      }
      if (!req.signal?.aborted) show();
    });
    const offClose = client.onClose(() => {
      off();
      resolve(null);
    });
    req.signal?.addEventListener("abort", () => {
      client.send({ type: "abort", id });
      // The bridge confirms with done; if it has gone, stop waiting.
      setTimeout(() => resolve(null), 5000);
    });
    client.send({
      type: "ask",
      id,
      prompt: req.text,
      doc: formatDocument(req.doc),
      scope,
      context: contextText(packet, req.resume ? undefined : req.earlier),
      ...(req.attachments?.length ? { attachments: bridgeAttachments(req.attachments) } : {}),
      ...(req.resume ? { resume: req.resume } : {}),
      model: req.bridge.model,
    });
  });
  client.close();

  if (req.signal?.aborted) return failed("Cancelled.", model);
  if (!done) return { ...failed("The bridge stopped answering (was its terminal closed?). Start it again with `npm run bridge`.", model), calls };
  const finalText = done.doc ?? latest;
  const result: BridgeAskResult = {
    outcome: done.ok ? "answer" : "failed",
    text: done.text,
    mode: "edit",
    visual: false,
    packet,
    proposal: null,
    calls,
    model: live.model ? `${model}: ${live.model}` : model,
    turns: done.turns ?? 0,
    ...(done.sessionId ? { sessionId: done.sessionId } : {}),
    ...(done.costUsd !== undefined ? { costUsd: done.costUsd } : {}),
  };
  // What changed: kept even when the run ended badly, so nothing done is lost unseen.
  if (finalText) {
    const p = parseDocumentText(finalText);
    const after = p.ok ? (p.value as RawDocument) : null;
    if (after && Array.isArray(after.features) && formatDocument(after) !== formatDocument(req.doc)) {
      const [b, a] = await Promise.all([req.kernel.check(req.doc).catch(() => null), req.kernel.check(after).catch(() => null)]);
      result.proposal = bridgeProposal(req.doc, after, { before: b?.measurements?.volume ?? null, after: a?.measurements?.volume ?? null });
      if (done.ok) result.outcome = "proposal";
      else result.text = `${done.text}\n\nWhat Claude Code changed before it stopped is shown as a proposal: accept it or discard it.`;
    }
  }
  return result;
}
