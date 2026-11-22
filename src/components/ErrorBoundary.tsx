import { Component, ReactNode } from "react";
import { t } from "../i18n";

interface State { error: Error | null }

/** If a screen throws, show a recoverable message instead of a broken window. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ padding: 28, textAlign: "center", color: "var(--ink)", background: "var(--bg-canvas)", height: "100%", fontSize: 13 }}>
        <h3>{t("error.title")}</h3>
        <p style={{ color: "var(--danger)", userSelect: "text", wordBreak: "break-all" }}>{this.state.error.message}</p>
        <button
          style={{ padding: "8px 16px", borderRadius: 11, border: "1px solid var(--line-strong)", background: "transparent", color: "var(--ink)" }}
          onClick={() => this.setState({ error: null })}
        >
          {t("error.retry")}
        </button>
      </div>
    );
  }
}
