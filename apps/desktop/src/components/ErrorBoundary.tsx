import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { hasError: boolean; message: string };

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: "" };

  static getDerivedStateFromError(error: unknown): State {
    const message = error instanceof Error ? error.message : String(error);
    return { hasError: true, message };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <section className="page route-loading-page">
          <article className="card glass-panel route-loading-card">
            <p className="eyebrow" style={{ color: "var(--danger)" }}>页面出错了</p>
            <h2>出了点问题</h2>
            <p className="muted-text">{this.state.message || "未知错误"}</p>
            <button
              type="button"
              className="btn btn-secondary"
              style={{ marginTop: "var(--space-4)" }}
              onClick={() => window.location.reload()}
            >
              刷新重试
            </button>
          </article>
        </section>
      );
    }
    return this.props.children;
  }
}
