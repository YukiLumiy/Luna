import type { ReactNode } from "react";

export function StatusPill({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "live" }) {
  return (
    <span className={`status-pill status-pill--${tone}`}>
      {tone === "live" && <span className="status-pill-dot" />}
      {children}
    </span>
  );
}
