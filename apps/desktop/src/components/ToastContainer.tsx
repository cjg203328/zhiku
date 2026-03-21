import { useAppStore } from "../store/appStore";

const levelStyles: Record<string, { background: string; color: string; border: string }> = {
  info:    { background: "var(--bg-elevated, #1e2330)", color: "var(--text-primary)", border: "var(--border)" },
  success: { background: "rgba(34,197,94,0.12)",      color: "#22c55e",            border: "rgba(34,197,94,0.4)" },
  warning: { background: "rgba(245,158,11,0.12)",     color: "var(--warning, #f59e0b)", border: "rgba(245,158,11,0.4)" },
  error:   { background: "rgba(239,68,68,0.12)",      color: "var(--error, #ef4444)",   border: "rgba(239,68,68,0.4)" },
};

export default function ToastContainer() {
  const { toasts, dismissToast } = useAppStore();

  if (!toasts.length) return null;

  return (
    <div
      style={{
        position: "fixed",
        bottom: 24,
        right: 24,
        zIndex: 9999,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        maxWidth: 360,
        pointerEvents: "none",
      }}
    >
      {toasts.map((toast) => {
        const s = levelStyles[toast.level] ?? levelStyles.info;
        return (
          <div
            key={toast.id}
            style={{
              background: s.background,
              color: s.color,
              border: `1px solid ${s.border}`,
              borderRadius: 8,
              padding: "10px 14px",
              fontSize: "0.875rem",
              lineHeight: 1.5,
              boxShadow: "0 4px 16px rgba(0,0,0,0.18)",
              display: "flex",
              alignItems: "flex-start",
              gap: 10,
              pointerEvents: "auto",
              animation: "fadeSlideUp 0.22s cubic-bezier(0.22,1,0.36,1) both",
            }}
          >
            <span style={{ flex: 1 }}>{toast.message}</span>
            <button
              type="button"
              onClick={() => dismissToast(toast.id)}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                color: "inherit",
                opacity: 0.6,
                padding: 0,
                lineHeight: 1,
                fontSize: "1rem",
                flexShrink: 0,
              }}
              aria-label="关闭"
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
