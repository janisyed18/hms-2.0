import {
  AlertTriangle,
  ArrowUpRight,
  BarChart3,
  BadgeCheck,
  CalendarClock,
  ClipboardCheck,
  FileCheck2,
  RefreshCcw,
  ShieldCheck,
  UsersRound
} from "lucide-react";
import { m, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

import { createHmsClient } from "../api/hmsClient";
import { CertificateCoverageChart } from "./charts/CertificateCoverageChart";
import { FleetStatusChart } from "./charts/FleetStatusChart";
import { InspectionOutcomesChart } from "./charts/InspectionOutcomesChart";
import type { AnalyticsOverview } from "../domain/types";
import { StaggerGroup, StaggerItem } from "../motion/MotionPrimitives";
import { motionTokens } from "../motion/motionTokens";
import { formatDateTime } from "../utils/dateTime";
import { formatCount as formatNumber } from "./charts/chartPrimitives";
import {
  REPORTING_PERIOD_SCOPE_NOTE,
  reportingPeriodForPreset,
  withReportingTimeZone
} from "../utils/reportingPeriod";
import type { ReportingPeriod } from "../utils/reportingPeriod";
import type { AppModule } from "./AppShell";
import { ReportingPeriodControl } from "./ReportingPeriodControl";
import { WorkspaceState } from "./WorkspaceState";

interface AnalyticsWorkspaceProps {
  onModuleChange: (module: AppModule) => void;
}

export function AnalyticsWorkspace({ onModuleChange }: AnalyticsWorkspaceProps) {
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null);
  // The period the figures on screen were loaded for: while a change is in flight, or a
  // refresh has failed, it is still the previous one and must be named as such.
  const [loadedPeriodLabel, setLoadedPeriodLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [reportingPeriod, setReportingPeriod] = useState<ReportingPeriod>(() => reportingPeriodForPreset("last_month"));
  const reducedMotion = useReducedMotion();
  const latestRequest = useRef(0);

  useEffect(() => {
    // Only the newest request may write state: a slow reply from a previous period
    // must not replace the figures for the one now selected.
    const token = ++latestRequest.current;
    setLoading(true);

    createHmsClient()
      .getAnalyticsOverview(reportingPeriod)
      .then((result) => {
        if (token !== latestRequest.current) return;
        setOverview(result);
        setLoadedPeriodLabel(reportingPeriod.label);
        setError(null);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (token !== latestRequest.current) return;
        setError(cause instanceof Error ? cause.message : "Analytics data could not be loaded.");
        setLoading(false);
      });

    return () => {
      // Nothing to abort: the token check above already ignores a superseded reply.
    };
  }, [refreshKey, reportingPeriod]);

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

  const onTrackRate = overview.fleetStatus.onTrackPercent;
  const isPeriodChanging = loading && loadedPeriodLabel !== null && loadedPeriodLabel !== reportingPeriod.label;
  const reviewRate = percentage(
    overview.inspectionOutcomes.reduce((total, outcome) => total + outcome.approved, 0),
    overview.inspectionOutcomes.reduce(
      (total, outcome) => total + outcome.approved + outcome.rejected,
      0
    )
  );
  const inspectionTotals = overview.inspectionOutcomes.reduce(
    (totals, outcome) => ({
      submitted: totals.submitted + outcome.submitted,
      approved: totals.approved + outcome.approved,
      rejected: totals.rejected + outcome.rejected
    }),
    { submitted: 0, approved: 0, rejected: 0 }
  );
  const inspectionRecordCount = inspectionTotals.submitted + inspectionTotals.approved + inspectionTotals.rejected;

  return (
    <section className="analytics-workspace analytics-command" aria-label="Operational analytics">
      <header className="analytics-header">
        <div>
          <span className="analytics-eyebrow">Operational intelligence</span>
          <h2>Fleet performance at a glance</h2>
          <p>
            Fleet status and certificate coverage are current as at {formatDateTime(overview.asOf)}. Inspection throughput is for {(loadedPeriodLabel ?? reportingPeriod.label).toLowerCase()}. {REPORTING_PERIOD_SCOPE_NOTE}
          </p>
          {isPeriodChanging ? (
            <span className="analytics-updated" role="status">
              Updating to {reportingPeriod.label.toLowerCase()}…
            </span>
          ) : null}
          <span className="analytics-updated">
            <CalendarClock aria-hidden="true" size={14} />
            Last updated {formatDateTime(overview.generatedAt)}
          </span>
        </div>
        <div className="analytics-header-actions">
              <ReportingPeriodControl
            onChange={(period) => setReportingPeriod(withReportingTimeZone(period, overview.timezone))}
            period={reportingPeriod}
            timeZone={overview.timezone}
          />
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
        </div>
      </header>

      {error ? (
        <p className="analytics-inline-error" role="status">
          These figures are from the last successful load. {error}{" "}
          <button className="analytics-inline-retry" onClick={() => setRefreshKey((value) => value + 1)} type="button">
            Retry
          </button>
        </p>
      ) : null}

      <div className="kpi-grid" aria-label="Live analytics highlights">
        <StaggerGroup className="kpi-grid-motion">
          <StaggerItem>
            <AnalyticsMetric
              helper={
                onTrackRate === null
                  ? "No eligible assets to measure"
                  : `${formatNumber(overview.fleetStatus.onTrack)} of ${formatNumber(overview.fleetStatus.total)} eligible assets on track`
              }
              icon={<ShieldCheck aria-hidden="true" size={18} />}
              label="Retest on-track rate"
              onClick={() => onModuleChange("retest")}
              tone={onTrackRate === null ? "blue" : "green"}
              value={onTrackRate === null ? "N/A" : `${onTrackRate}%`}
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
              helper={`${formatNumber(overview.certificateCoverage.missingAssets)} eligible assets without a certificate`}
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
          <FleetPosturePanel overview={overview} onNavigate={onModuleChange} />
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
              <UsersRound aria-hidden="true" size={19} />
            </div>
            {overview.customerRisk.length ? (
              <div className="analytics-risk-list">
                <div className="analytics-risk-labels" aria-hidden="true">
                  <span>Customer</span>
                  <span>Overdue</span>
                  <span>Due this week</span>
                  <span>Total</span>
                  <span>Risk</span>
                </div>
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
                    <span className="analytics-risk-customer">
                      <i
                        className={`analytics-risk-marker risk-${customer.risk.toLowerCase()}`}
                        aria-hidden="true"
                      />
                      <strong>{customer.customerName}</strong>
                    </span>
                    <strong className="analytics-risk-value is-overdue">{customer.overdue}</strong>
                    <strong className="analytics-risk-value">{customer.dueSoon}</strong>
                    <strong className="analytics-risk-value">{customer.overdue + customer.dueSoon}</strong>
                    <span className={`analytics-risk-badge risk-${customer.risk.toLowerCase()}`}>
                      {customer.risk}
                    </span>
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
                <p>
                {loadedPeriodLabel
                  ? `Submitted, approved and rejected inspections for ${loadedPeriodLabel.toLowerCase()}.`
                  : "Submitted, approved and rejected inspection records."}
              </p>
              </div>
              <BadgeCheck aria-hidden="true" size={19} />
            </div>
            {overview.inspectionOutcomes.length ? (
              <>
                <InspectionOutcomesChart
                  outcomes={overview.inspectionOutcomes}
                  periodLabel={loadedPeriodLabel}
                />
                <m.button
                  className="analytics-panel-link"
                  onClick={() => onModuleChange("inspections")}
                  transition={motionTokens.spring.gentle}
                  type="button"
                  whileHover={reducedMotion ? undefined : { y: -1 }}
                  whileTap={reducedMotion ? undefined : { scale: 0.995 }}
                >
                  <ClipboardCheck aria-hidden="true" size={16} />
                  {inspectionRecordCount} records in this view. Open inspection records
                  <ArrowUpRight aria-hidden="true" size={14} />
                </m.button>
              </>
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

function FleetPosturePanel({
  overview,
  onNavigate
}: {
  overview: AnalyticsOverview;
  onNavigate: (module: AppModule) => void;
}) {
  return (
    <section className="data-panel health-panel analytics-fleet-panel">
      <div className="panel-heading">
        <div>
          <h2>Fleet retest status</h2>
          <p>Every eligible asset in exactly one category. Condemned, retired and draft assets are excluded.</p>
        </div>
        <BarChart3 aria-hidden="true" size={19} />
      </div>
      {/* The same field the Dashboard shows, so the two pages cannot disagree about
          what is overdue or on track. */}
      <FleetStatusChart
        fleet={overview.fleetStatus}
        onSelect={(category) => onNavigate(category.id === "unscheduled" ? "assets" : "retest")}
        selectLabel={(category) =>
          category.id === "unscheduled" ? "Opens the asset register." : "Opens the retest schedule."
        }
      />
      {overview.fleetStatus.overdue > 0 ? (
        <div className="analytics-posture-alert">
          <AlertTriangle aria-hidden="true" size={18} />
          <span>
            <strong>
              {percentage(overview.fleetStatus.overdue, overview.fleetStatus.total)}% of eligible assets are overdue
            </strong>
            {overview.fleetStatus.overdue} asset{overview.fleetStatus.overdue === 1 ? "" : "s"} past a retest due date.
          </span>
        </div>
      ) : null}
    </section>
  );
}

function CertificateCoveragePanel({
  overview,
  onNavigate
}: {
  overview: AnalyticsOverview;
  onNavigate: () => void;
}) {
  const coverage = overview.certificateCoverage;
  return (
    <section className="data-panel analytics-coverage-panel">
      <div className="panel-heading">
        <div>
          <h2>Certificate coverage</h2>
          <p>Assets holding a certificate that is valid today, whenever it was issued.</p>
        </div>
        <FileCheck2 aria-hidden="true" size={19} />
      </div>
      <div className="analytics-coverage-score">
        <strong>{coverage.coveragePercent}%</strong>
        <span>{formatNumber(coverage.coveredAssets)} of {formatNumber(coverage.eligibleAssets)} eligible assets covered</span>
        <i style={{ "--coverage": `${coverage.coveragePercent}%` } as CSSProperties} />
      </div>
      <CertificateCoverageChart coverage={coverage} />
      <button className="analytics-panel-link" onClick={onNavigate} type="button">
        Open certificates <ArrowUpRight aria-hidden="true" size={14} />
      </button>
    </section>
  );
}

function EmptyPanel({ message }: { message: string }) {
  return <p className="analytics-empty">{message}</p>;
}

function percentage(value: number, total: number) {
  return total ? Math.round(value / total * 100) : 0;
}
