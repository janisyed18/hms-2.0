import {
  AlertTriangle,
  ArrowUpRight,
  BadgeCheck,
  CheckCircle2,
  CircleAlert,
  ClipboardCheck,
  FileCheck2,
  RefreshCcw,
  ShieldCheck
} from "lucide-react";
import { m, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

import { createHmsClient } from "../api/hmsClient";
import type { AnalyticsOverview } from "../domain/types";
import { StaggerGroup, StaggerItem } from "../motion/MotionPrimitives";
import { motionTokens } from "../motion/motionTokens";
import { formatDateTime } from "../utils/dateTime";
import type { AppModule } from "./AppShell";
import { WorkspaceState } from "./WorkspaceState";

interface AnalyticsWorkspaceProps {
  onModuleChange: (module: AppModule) => void;
}

type FleetPosture = "clear" | "dueSoon" | "overdue";

const fleetLabels: Record<FleetPosture, string> = {
  clear: "Clear for service",
  dueSoon: "Due this week",
  overdue: "Overdue"
};

export function AnalyticsWorkspace({ onModuleChange }: AnalyticsWorkspaceProps) {
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    createHmsClient()
      .getAnalyticsOverview()
      .then((result) => {
        if (!active) return;
        setOverview(result);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : "Analytics data could not be loaded.");
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [refreshKey]);

  if (loading && overview === null) {
    return (
      <WorkspaceState title="Loading analytics" tone="loading">
        Retrieving current operational records.
      </WorkspaceState>
    );
  }

  if (error && overview === null) {
    return (
      <WorkspaceState
        action={
          <button className="secondary-button" onClick={() => setRefreshKey((value) => value + 1)} type="button">
            <RefreshCcw aria-hidden="true" size={15} />
            Retry
          </button>
        }
        title="Analytics unavailable"
        tone="error"
      >
        {error}
      </WorkspaceState>
    );
  }

  if (overview === null) return null;

  const fleetHealth = percentage(overview.fleetPosture.clear, fleetPostureTotal(overview));
  const reviewRate = percentage(
    overview.inspectionOutcomes.reduce((total, outcome) => total + outcome.approved, 0),
    overview.inspectionOutcomes.reduce(
      (total, outcome) => total + outcome.approved + outcome.rejected,
      0
    )
  );

  return (
    <section className="analytics-workspace analytics-command" aria-label="Operational analytics">
      <header className="analytics-header">
        <div>
          <span className="analytics-eyebrow">Operational intelligence</span>
          <h2>Fleet performance at a glance</h2>
          <p>Updated {formatDateTime(overview.generatedAt)}</p>
        </div>
        <button
          aria-label="Refresh analytics"
          className="analytics-refresh"
          disabled={loading}
          onClick={() => setRefreshKey((value) => value + 1)}
          type="button"
        >
          <RefreshCcw aria-hidden="true" className={loading ? "is-spinning" : ""} size={16} />
          Refresh
        </button>
      </header>

      {error ? <p className="analytics-inline-error" role="status">Showing the most recently loaded results. {error}</p> : null}

      <div className="kpi-grid" aria-label="Live analytics highlights">
        <StaggerGroup className="kpi-grid-motion">
          <StaggerItem>
            <AnalyticsMetric
              helper={`${overview.fleetPosture.clear} clear for service`}
              icon={<ShieldCheck aria-hidden="true" size={18} />}
              label="Fleet health"
              onClick={() => onModuleChange("assets")}
              tone="green"
              value={`${fleetHealth}%`}
            />
          </StaggerItem>
          <StaggerItem>
            <AnalyticsMetric
              helper={overview.overdueAssets ? "Retests need attention" : "No overdue retests"}
              icon={<AlertTriangle aria-hidden="true" size={18} />}
              label="Retest exposure"
              onClick={() => onModuleChange("retest")}
              tone="red"
              value={String(overview.overdueAssets)}
            />
          </StaggerItem>
          <StaggerItem>
            <AnalyticsMetric
              helper={`${overview.awaitingReviewInspections} currently awaiting review`}
              icon={<ClipboardCheck aria-hidden="true" size={18} />}
              label="Review completion"
              onClick={() => onModuleChange("inspections")}
              tone="blue"
              value={`${reviewRate}%`}
            />
          </StaggerItem>
          <StaggerItem>
            <AnalyticsMetric
              helper={`${overview.certificateCoverage.missingAssets} service assets without coverage`}
              icon={<FileCheck2 aria-hidden="true" size={18} />}
              label="Certificate coverage"
              onClick={() => onModuleChange("certificates")}
              tone="amber"
              value={`${overview.certificateCoverage.coveragePercent}%`}
            />
          </StaggerItem>
        </StaggerGroup>
      </div>

      <div className="analytics-command-grid">
        <StaggerItem>
          <FleetPosturePanel overview={overview} onNavigate={() => onModuleChange("assets")} />
        </StaggerItem>
        <StaggerItem>
          <CertificateCoveragePanel overview={overview} onNavigate={() => onModuleChange("certificates")} />
        </StaggerItem>
      </div>

      <div className="analytics-insight-grid">
        <StaggerItem>
          <section className="data-panel analytics-risk-panel">
            <div className="panel-heading">
              <div>
                <h2>Retest attention by customer</h2>
                <p>Customers ranked by work that needs action in the next seven days.</p>
              </div>
              <CircleAlert aria-hidden="true" size={19} />
            </div>
            {overview.customerRisk.length ? (
              <div className="analytics-risk-list">
                {overview.customerRisk.map((customer) => (
                  <m.button
                    className="analytics-risk-row"
                    key={customer.customerId}
                    onClick={() => onModuleChange("customers")}
                    transition={motionTokens.spring.gentle}
                    type="button"
                    whileHover={reducedMotion ? undefined : { x: 3 }}
                    whileTap={reducedMotion ? undefined : { scale: 0.995 }}
                  >
                    <span className={`analytics-risk-marker risk-${customer.risk.toLowerCase()}`} aria-hidden="true" />
                    <span className="analytics-risk-customer">
                      <strong>{customer.customerName}</strong>
                      <small>{customer.overdue} overdue · {customer.dueSoon} due this week</small>
                    </span>
                    <span className={`analytics-risk-badge risk-${customer.risk.toLowerCase()}`}>{customer.risk}</span>
                    <ArrowUpRight aria-hidden="true" size={16} />
                  </m.button>
                ))}
              </div>
            ) : (
              <EmptyPanel message="No overdue or due-this-week retests are visible." />
            )}
          </section>
        </StaggerItem>

        <StaggerItem>
          <section className="data-panel analytics-outcomes-panel">
            <div className="panel-heading">
              <div>
                <h2>Inspection outcomes</h2>
                <p>Current submitted, approved, and rejected inspection records.</p>
              </div>
              <BadgeCheck aria-hidden="true" size={19} />
            </div>
            {overview.inspectionOutcomes.length ? (
              <div className="analytics-outcomes-list">
                {overview.inspectionOutcomes.map((outcome) => {
                  const total = outcome.submitted + outcome.approved + outcome.rejected;
                  return (
                    <m.button
                      className="analytics-outcome"
                      key={outcome.inspectionType}
                      onClick={() => onModuleChange("inspections")}
                      transition={motionTokens.spring.gentle}
                      type="button"
                      whileHover={reducedMotion ? undefined : { y: -2 }}
                      whileTap={reducedMotion ? undefined : { scale: 0.99 }}
                    >
                      <span>
                        <strong>{formatInspectionType(outcome.inspectionType)}</strong>
                        <small>{total} current records</small>
                      </span>
                      <span className="analytics-outcome-totals">
                        <b>{outcome.submitted}<small>Submitted</small></b>
                        <b>{outcome.approved}<small>Approved</small></b>
                        <b>{outcome.rejected}<small>Rejected</small></b>
                      </span>
                    </m.button>
                  );
                })}
              </div>
            ) : (
              <EmptyPanel message="No submitted, approved, or rejected inspections are visible." />
            )}
          </section>
        </StaggerItem>
      </div>
    </section>
  );
}

function AnalyticsMetric({
  helper,
  icon,
  label,
  onClick,
  tone,
  value
}: {
  helper: string;
  icon: ReactNode;
  label: string;
  onClick: () => void;
  tone: "blue" | "green" | "amber" | "red";
  value: string;
}) {
  const reducedMotion = useReducedMotion();
  return (
    <m.button
      className={`kpi-card tone-${tone}`}
      onClick={onClick}
      transition={motionTokens.spring.gentle}
      type="button"
      whileHover={reducedMotion ? undefined : { y: -3 }}
      whileTap={reducedMotion ? undefined : { scale: 0.985 }}
    >
      <span className="kpi-icon">{icon}</span>
      <span className="kpi-label">{label}</span>
      <strong>{value}</strong>
      <small>{helper}</small>
      <span className="kpi-action">Open records <ArrowUpRight aria-hidden="true" size={14} /></span>
    </m.button>
  );
}

function FleetPosturePanel({ overview, onNavigate }: { overview: AnalyticsOverview; onNavigate: () => void }) {
  const [selected, setSelected] = useState<FleetPosture>("clear");
  const posture = overview.fleetPosture;
  const total = fleetPostureTotal(overview);
  const segments: Array<{ key: FleetPosture; value: number; className: string }> = [
    { key: "clear", value: posture.clear, className: "fleet-segment-active" },
    { key: "dueSoon", value: posture.dueSoon, className: "fleet-segment-due-soon" },
    { key: "overdue", value: posture.overdue, className: "fleet-segment-overdue" }
  ];
  let offset = 0;

  return (
    <section className="data-panel health-panel analytics-fleet-panel">
      <div className="panel-heading">
        <div>
          <h2>Fleet posture</h2>
          <p>Serviceable assets classified by current retest position.</p>
        </div>
        <GaugeIcon />
      </div>
      <div className="fleet-ring">
        <svg className="fleet-ring-chart" viewBox="0 0 120 120" aria-label="Fleet posture breakdown" role="img">
          <circle className="fleet-ring-track" cx="60" cy="60" r="40" />
          {segments.map((segment) => {
            const length = total ? segment.value / total * 251.327 : 0;
            const dashOffset = -offset;
            offset += length;
            return (
              <circle
                aria-label={`${fleetLabels[segment.key]}: ${segment.value}`}
                className={`fleet-segment ${segment.className}${selected === segment.key ? " is-selected" : ""}`}
                cx="60"
                cy="60"
                key={segment.key}
                onBlur={() => setSelected("clear")}
                onClick={() => setSelected(segment.key)}
                onFocus={() => setSelected(segment.key)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setSelected(segment.key);
                  }
                }}
                onMouseEnter={() => setSelected(segment.key)}
                r="40"
                role="button"
                strokeDasharray={`${length} ${251.327 - length}`}
                strokeDashoffset={dashOffset}
                tabIndex={0}
                transform="rotate(-90 60 60)"
              />
            );
          })}
        </svg>
        <span className="fleet-ring-core">
          <span>{fleetLabels[selected]}</span>
          <strong>{posture[selected]}</strong>
          <small>assets</small>
        </span>
      </div>
      <div className="health-legend">
        {segments.map((segment) => (
          <button
            className={`fleet-legend-button${selected === segment.key ? " is-selected" : ""}`}
            key={segment.key}
            onClick={() => setSelected(segment.key)}
            onMouseEnter={() => setSelected(segment.key)}
            type="button"
          >
            <span><i className={segment.className} aria-hidden="true" />{fleetLabels[segment.key]}</span>
            <strong>{segment.value}</strong>
          </button>
        ))}
      </div>
      <button className="analytics-panel-link" onClick={onNavigate} type="button">
        Open asset register <ArrowUpRight aria-hidden="true" size={14} />
      </button>
    </section>
  );
}

function CertificateCoveragePanel({ overview, onNavigate }: { overview: AnalyticsOverview; onNavigate: () => void }) {
  const coverage = overview.certificateCoverage;
  const rows = [
    { label: "Covered service assets", value: coverage.coveredAssets, max: overview.inServiceAssets, tone: "coverage-valid" },
    { label: "Expiring within 60 days", value: coverage.expiringSoon, max: Math.max(coverage.issued, 1), tone: "coverage-expiring" },
    { label: "Expired certificates", value: coverage.expired, max: Math.max(coverage.issued, 1), tone: "coverage-expired" }
  ];

  return (
    <section className="data-panel analytics-coverage-panel">
      <div className="panel-heading">
        <div>
          <h2>Certificate coverage</h2>
          <p>Current issued-certificate status across the in-service fleet.</p>
        </div>
        <FileCheck2 aria-hidden="true" size={19} />
      </div>
      <div className="analytics-coverage-score">
        <strong>{coverage.coveragePercent}%</strong>
        <span>{coverage.coveredAssets} of {overview.inServiceAssets} in-service assets covered</span>
      </div>
      <div className="analytics-coverage-bars">
        {rows.map((row) => (
          <div key={row.label}>
            <span>{row.label}</span>
            <strong>{row.value}</strong>
            <i className={row.tone} style={{ "--coverage": `${percentage(row.value, row.max)}%` } as CSSProperties} />
          </div>
        ))}
      </div>
      <button className="analytics-panel-link" onClick={onNavigate} type="button">
        Open certificates <ArrowUpRight aria-hidden="true" size={14} />
      </button>
    </section>
  );
}

function EmptyPanel({ message }: { message: string }) {
  return <p className="analytics-empty">{message}</p>;
}

function GaugeIcon() {
  return <CheckCircle2 aria-hidden="true" size={19} />;
}

function fleetPostureTotal(overview: AnalyticsOverview) {
  const posture = overview.fleetPosture;
  return posture.clear + posture.dueSoon + posture.overdue;
}

function percentage(value: number, total: number) {
  return total ? Math.round(value / total * 100) : 0;
}

function formatInspectionType(value: string) {
  return value.toLowerCase().replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
