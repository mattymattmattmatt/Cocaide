// Share project: hand the open project to another device by a 6-digit code
// (src/share/share). One side shares (gets a code, keeps the dialog open), the
// other types the code and the project opens there.

import { useEffect, useRef, useState } from "react";
import { pack, readCode, receive, SHARE_MINUTES, showCode, startSharing, type Sharing } from "../share/share";
import { Icon } from "./icons";

interface Props {
  /** The project to share, as saved (null: nothing to share: it has a problem). */
  project(): { name: string; text: string } | null;
  /** A project received: open it. */
  onReceived(name: string, text: string): void;
  onClose(): void;
}

type SendState = { phase: "idle" } | { phase: "opening" } | { phase: "open"; code: string; sent: number; sending?: { fraction: number; bytes: number } } | { phase: "failed"; why: string } | { phase: "expired" };
type GetState = { phase: "idle" } | { phase: "getting"; fraction?: number; bytes?: number } | { phase: "failed"; why: string };

/** "3.4 MB", "820 kB". */
const sizeText = (b: number) => (b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} kB`);

export function ShareDialog({ project, onReceived, onClose }: Props) {
  const [send, setSend] = useState<SendState>({ phase: "idle" });
  const [get, setGet] = useState<GetState>({ phase: "idle" });
  const [typed, setTyped] = useState("");
  const sharing = useRef<Sharing | null>(null);
  const projectRef = useRef(project);
  projectRef.current = project;
  // Closing the dialog closes the share.
  useEffect(() => () => sharing.current?.stop(), []);

  const share = () => {
    const now = projectRef.current();
    if (!now) return setSend({ phase: "failed", why: "the project has a problem, so it can't be shared until it is fixed" });
    setSend({ phase: "opening" });
    sharing.current?.stop();
    sharing.current = startSharing(
      async () => {
        const p = projectRef.current() ?? now;
        return pack(p.name, p.text);
      },
      {
        ready: (code) => setSend({ phase: "open", code, sent: 0 }),
        sent: (count) => setSend((s) => (s.phase === "open" ? { ...s, sent: count, sending: undefined } : s)),
        progress: (fraction, bytes) => setSend((s) => (s.phase === "open" ? { ...s, sending: { fraction, bytes } } : s)),
        failed: (why) => setSend({ phase: "failed", why }),
        expired: () => setSend({ phase: "expired" }),
      },
    );
  };
  const stop = () => {
    sharing.current?.stop();
    sharing.current = null;
    setSend({ phase: "idle" });
  };
  const code = readCode(typed);
  const take = () => {
    if (!code) return;
    setGet({ phase: "getting" });
    receive(code, { progress: (fraction, bytes) => setGet({ phase: "getting", fraction, bytes }) })
      .then(({ name, text }) => {
        onReceived(name, text);
        onClose();
      })
      .catch((e: Error) => setGet({ phase: "failed", why: e.message }));
  };

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal share" role="dialog" aria-label="Share project" data-testid="share-dialog">
        <h2>Share project</h2>
        <p className="muted small">Send the open project to another device (a VR headset, another computer) with a 6-digit code: no files, nothing uploaded. Both devices need to be online with Cocaide open.</p>
        <div className="share-cols">
          <section className="share-col">
            <h3>Share this project</h3>
            {send.phase === "idle" && (
              <>
                <p className="small">Get a code, then type it on the other device (Share → Get a project).</p>
                <button type="button" className="primary" onClick={share} data-testid="share-start">
                  <Icon name="share" size={14} /> Get a code
                </button>
              </>
            )}
            {send.phase === "opening" && <p className="small">Getting a code…</p>}
            {send.phase === "open" && (
              <>
                <div className="share-code" data-testid="share-code" aria-label={`Code ${send.code.split("").join(" ")}`}>
                  {showCode(send.code)}
                </div>
                <p className="small" data-testid="share-status">
                  {send.sending && send.sending.fraction < 1
                    ? `Sending… ${Math.floor(send.sending.fraction * 100)}% of ${sizeText(send.sending.bytes)}. `
                    : send.sent
                      ? `Sent ✓${send.sent > 1 ? ` (to ${send.sent} devices)` : ""}. `
                      : send.sending
                        ? "Sent, opening on the other device… "
                        : "Waiting for the other device… "}
                  Keep this open while it connects; the code works for {SHARE_MINUTES} minutes.
                </p>
                <button type="button" onClick={stop} data-testid="share-stop">
                  Stop sharing
                </button>
              </>
            )}
            {send.phase === "failed" && (
              <>
                <p className="small error-text" data-testid="share-status">Couldn&apos;t share: {send.why}.</p>
                <button type="button" onClick={share}>Try again</button>
              </>
            )}
            {send.phase === "expired" && (
              <>
                <p className="small" data-testid="share-status">The code has expired.</p>
                <button type="button" onClick={share}>New code</button>
              </>
            )}
          </section>
          <section className="share-col">
            <h3>Get a project</h3>
            <p className="small">Type the code the other device shows. The project opens here in place of this one (Ctrl+Z brings this one back).</p>
            <form
              className="share-get"
              onSubmit={(e) => {
                e.preventDefault();
                take();
              }}
            >
              <input
                type="text"
                inputMode="numeric"
                autoComplete="off"
                placeholder="123 456"
                maxLength={7}
                value={typed}
                onChange={(e) => {
                  setTyped(e.target.value);
                  if (get.phase === "failed") setGet({ phase: "idle" });
                }}
                aria-label="Code"
                data-testid="share-code-input"
              />
              <button type="submit" className="primary" disabled={!code || get.phase === "getting"} data-testid="share-get">
                {get.phase === "getting" ? "Getting…" : "Get it"}
              </button>
            </form>
            {get.phase === "getting" && get.bytes !== undefined && (
              <div className="share-progress" data-testid="share-get-progress">
                <div className="share-progress-bar">
                  <div style={{ width: `${Math.round((get.fraction ?? 0) * 100)}%` }} />
                </div>
                <span className="small">
                  {Math.floor((get.fraction ?? 0) * 100)}% of {sizeText(get.bytes)}
                  {(get.fraction ?? 0) >= 1 ? " · opening…" : ""}
                </span>
              </div>
            )}
            {get.phase === "failed" && (
              <p className="small error-text" data-testid="share-get-status">
                Couldn&apos;t get it: {get.why}.
              </p>
            )}
          </section>
        </div>
        <div className="modal-buttons">
          <span className="sep" />
          <button type="button" onClick={onClose} data-testid="share-close">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
