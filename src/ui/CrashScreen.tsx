// The last line of defence: if anything in the app throws while drawing, the
// page shows what went wrong and how to get back, instead of going blank.
// The part itself is safe: it is kept in the browser (localStorage) as it was
// before the failing change, so reloading brings it back.

import { Component, type ReactNode } from "react";

interface State {
  error: Error | null;
  stack: string;
}

export class CrashScreen extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, stack: "" };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: { componentStack?: string | null }): void {
    console.error("Cocaide crashed while drawing the page:", error, info.componentStack);
    this.setState({ stack: info.componentStack ?? "" });
  }

  private report(): string {
    const e = this.state.error;
    return [`${e?.name ?? "Error"}: ${e?.message ?? ""}`, e?.stack ?? "", "Component stack:", this.state.stack].join("\n");
  }

  render(): ReactNode {
    const e = this.state.error;
    if (!e) return this.props.children;
    return (
      <div className="crash-screen" role="alert" data-testid="crash-screen">
        <h1>Something went wrong drawing the app</h1>
        <p>Your part is safe: it was saved in this browser before the failing change. Reload to get back to it.</p>
        <pre className="crash-message">{`${e.name}: ${e.message}`}</pre>
        <div className="crash-buttons">
          <button type="button" onClick={() => location.reload()} data-testid="crash-reload">
            Reload
          </button>
          <button type="button" onClick={() => this.setState({ error: null, stack: "" })}>
            Try to carry on
          </button>
          <button type="button" onClick={() => void navigator.clipboard?.writeText(this.report())} data-testid="crash-copy">
            Copy the error details
          </button>
        </div>
        <details>
          <summary>Details</summary>
          <pre className="crash-stack">{this.report()}</pre>
        </details>
      </div>
    );
  }
}
