import { scaleLinear } from "d3-scale";
import { useId } from "react";

import type { AnalyticsCertificateCoverage } from "../../domain/types";
import { formatCount } from "./chartPrimitives";

const VIEW_WIDTH = 760;
const BAR_HEIGHT = 30;

/**
 * Asset-level coverage as one bar over the eligible fleet. The four states are mutually
 * exclusive and add up to the eligible fleet, so a progress bar reads honestly where a
 * ring would invite reading parts of different wholes as one.
 *
 * "Unverified" is an asset whose only usable certificates carry no expiry date: their
 * validity is unknown, so they are neither covered nor expired.
 */
export function CertificateCoverageChart({
  coverage
}: {
  coverage: AnalyticsCertificateCoverage;
}) {
  const titleId = useId();
  const eligible = coverage.eligibleAssets;
  const states = [
    { id: "covered", label: "Covered by a valid certificate", value: coverage.coveredAssets, token: "var(--chart-2)" },
    { id: "unverified", label: "Validity unverified (no expiry recorded)", value: coverage.unverifiedAssets, token: "var(--chart-4)" },
    { id: "expired", label: "Certificate expired", value: coverage.expiredAssets, token: "var(--chart-6)" },
    { id: "missing", label: "No certificate", value: coverage.missingAssets, token: "var(--chart-grid)" }
  ];
  const scale = scaleLinear().domain([0, Math.max(1, eligible)]).range([0, VIEW_WIDTH]);
  const share = (value: number) => (eligible ? Math.round((value / eligible) * 100) : 0);

  if (eligible === 0) {
    return <p className="chart-empty">No assets are eligible for certificate coverage.</p>;
  }

  const segments = states.map((state, index) => ({
    ...state,
    x: states.slice(0, index).reduce((sum, earlier) => sum + scale(earlier.value), 0),
    width: scale(state.value)
  }));

  return (
    <div className="coverage-chart">
      <svg
        aria-labelledby={titleId}
        className="coverage-chart-svg"
        preserveAspectRatio="none"
        role="img"
        viewBox={`0 0 ${VIEW_WIDTH} ${BAR_HEIGHT}`}
      >
        <title id={titleId}>
          {`Certificate coverage of ${formatCount(eligible)} eligible assets: ${states
            .map((state) => `${state.label} ${state.value}, ${share(state.value)} per cent`)
            .join("; ")}.`}
        </title>
        {segments.map((segment) =>
          segment.width > 0 ? (
            <rect
              className={`coverage-segment coverage-${segment.id}`}
              fill={segment.token}
              height={BAR_HEIGHT}
              key={segment.id}
              width={segment.width}
              x={segment.x}
              y="0"
            />
          ) : null
        )}
      </svg>
      <ul className="coverage-chart-legend">
        {states.map((state) => (
          <li key={state.id}>
            <i aria-hidden="true" style={{ background: state.token }} />
            <span>{state.label}</span>
            <strong>{formatCount(state.value)}</strong>
            <small>{share(state.value)}%</small>
          </li>
        ))}
      </ul>
      {/* Certificate records, kept apart from the asset counts above: one asset can hold
          several certificates, so these numbers are not interchangeable. */}
      <dl className="coverage-chart-records">
        <div>
          <dt>Assets with a certificate expiring within 60 days</dt>
          <dd>{formatCount(coverage.expiringAssets)}</dd>
        </div>
        <div>
          <dt>Issued certificate records</dt>
          <dd>{formatCount(coverage.issued)}</dd>
        </div>
        <div>
          <dt>Certificate records expiring within 60 days</dt>
          <dd>{formatCount(coverage.expiringSoon)}</dd>
        </div>
        <div>
          <dt>Expired certificate records</dt>
          <dd>{formatCount(coverage.expired)}</dd>
        </div>
        <div>
          <dt>Issued in this period</dt>
          <dd>{coverage.issuedInPeriod === null ? "—" : formatCount(coverage.issuedInPeriod)}</dd>
        </div>
      </dl>
    </div>
  );
}
