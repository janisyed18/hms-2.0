import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { StaggerGroup, StaggerItem } from "../motion/MotionPrimitives";

type MetricTone = "blue" | "green" | "amber" | "red" | "violet";

export function ManagementHeader({
  eyebrow,
  title,
  description,
  context
}: {
  eyebrow: string;
  title: string;
  description: string;
  context?: ReactNode;
}) {
  return (
    <header className="management-command-header">
      <div>
        <span className="management-command-eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {context ? <div className="management-command-context">{context}</div> : null}
    </header>
  );
}

export function ManagementMetricStrip({ children }: { children: ReactNode }) {
  return <StaggerGroup className="management-metric-strip">{children}</StaggerGroup>;
}

export function ManagementMetric({
  icon: Icon,
  label,
  value,
  detail,
  tone = "blue"
}: {
  icon: LucideIcon;
  label: string;
  value: string | number;
  detail: string;
  tone?: MetricTone;
}) {
  return (
    <StaggerItem className={`management-metric management-metric--${tone}`}>
      <span className="management-metric-icon"><Icon aria-hidden="true" size={19} /></span>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <small>{detail}</small>
      </div>
    </StaggerItem>
  );
}
