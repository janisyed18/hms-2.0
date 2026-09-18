import { AlertTriangle, CalendarDays, FileCheck2, KeyRound, ShieldCheck } from "lucide-react";

import { CertificateDetail } from "./CertificateDetail";
import { CertificateForm } from "./CertificateForm";
import { ModuleTable, type ModuleColumn } from "./ModuleTable";
import {
  type CertificateStatusFilter,
  useCertificatesWorkspace
} from "../hooks/useCertificatesWorkspace";
import type { CertificateRecord } from "../domain/types";
import { StaggerGroup, StaggerItem } from "../motion/MotionPrimitives";

const statusFilters: Array<{ label: string; value: CertificateStatusFilter }> = [
  { label: "All Certificates", value: "ALL" },
  { label: "Pending Issue", value: "DRAFT" },
  { label: "Superseded", value: "SUPERSEDED" },
  { label: "Revoked", value: "REVOKED" },
  { label: "Issued", value: "ISSUED" }
];

function statusClass(status: string) {
  if (status === "REVOKED") {
    return "mini-status overdue";
  }
  if (status === "SUPERSEDED" || status === "DRAFT") {
    return "mini-status due-soon";
  }
  return "mini-status current";
}

function countByStatus(certificates: CertificateRecord[], status: string) {
  return certificates.filter((certificate) => certificate.status === status).length;
}

function expiringSoonCount(certificates: CertificateRecord[]) {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const threshold = new Date(now);
  threshold.setDate(threshold.getDate() + 60);
  return certificates.filter((certificate) => {
    if (certificate.status !== "ISSUED" || !certificate.validUntil) {
      return false;
    }
    const validUntil = new Date(`${certificate.validUntil}T00:00:00`);
    return validUntil >= now && validUntil <= threshold;
  }).length;
}

export function CertificatesWorkspace({ canManage }: { canManage: boolean }) {
  const workspace = useCertificatesWorkspace();
  const issuedCount = countByStatus(workspace.certificates, "ISSUED");
  const revokedCount = countByStatus(workspace.certificates, "REVOKED");
  const soonCount = expiringSoonCount(workspace.certificates);
  const tokenCount = workspace.certificates.filter(
    (certificate) => certificate.publicToken
  ).length;

  const columns: ModuleColumn<CertificateRecord>[] = [
    {
      header: "Status",
      render: (certificate) => (
        <span className={statusClass(certificate.status)}>
          {certificate.status}
        </span>
      )
    },
    {
      header: "Certificate",
      render: (certificate) => (
        <span className="certificate-number-cell">
          <strong>{certificate.number}</strong>
          <small>Version {certificate.certificateVersion}</small>
        </span>
      )
    },
    {
      header: "Asset",
      render: (certificate) => certificate.asset.assetNumber
    },
    {
      header: "Customer",
      render: (certificate) => certificate.customer.name
    },
    {
      header: "Source inspection",
      render: (certificate) => (
        <span className="certificate-inspection-cell">
          <strong>{certificate.inspection.inspectionType.replace("_", " ")}</strong>
          <small>{certificate.inspection.result ?? "Pending"}</small>
        </span>
      )
    },
    {
      header: "Issued",
      render: (certificate) => certificate.issuedAt.slice(0, 10)
    },
    {
      header: "Valid until",
      render: (certificate) => (
        <span className="certificate-validity-cell">
          <strong>{certificate.validUntil ?? "Not set"}</strong>
          <small>{validityLabel(certificate.validUntil)}</small>
        </span>
      )
    },
    {
      header: "Verification",
      render: (certificate) => (
        <span className="certificate-token-cell">
          <KeyRound aria-hidden="true" size={14} />
          {certificate.publicToken ? "Token active" : "No public token"}
        </span>
      )
    },
    {
      header: "Actions",
      render: (certificate) => (
        <span className="row-actions">
          <button
            aria-label={`Open certificate ${certificate.number}`}
            onClick={() => workspace.openDetail(certificate)}
            type="button"
          >
            Open
          </button>
        </span>
      )
    }
  ];

  return (
    <section className="asset-register-workspace certificate-workspace" aria-labelledby="certificate-workspace-heading">
      <header className="asset-register-header certificate-command-header">
        <div>
          <span className="asset-register-eyebrow certificate-command-eyebrow">Certificate management</span>
          <h2 id="certificate-workspace-heading">Certificates</h2>
          <p>Issue and review versioned certificates for approved inspections.</p>
        </div>
        <div className="asset-register-context certificate-command-context" aria-label="Current certificate scope">
          <FileCheck2 aria-hidden="true" size={23} />
          <span>
            <strong>{workspace.certificates.length} certificate{workspace.certificates.length === 1 ? "" : "s"}</strong>
            <small>{workspace.visibleCertificates.length} matching the current view</small>
          </span>
        </div>
      </header>

      <section aria-label="Certificate overview">
        <StaggerGroup className="asset-register-metrics certificate-command-metrics">
          <CertificateMetric icon={FileCheck2} label="Issued" value={issuedCount} detail="Active certificate records" tone="green" />
          <CertificateMetric icon={AlertTriangle} label="Expiring" value={soonCount} detail="Within the next 60 days" tone="amber" />
          <CertificateMetric icon={ShieldCheck} label="Revoked" value={revokedCount} detail="No longer valid for use" tone="red" />
          <CertificateMetric icon={KeyRound} label="Verification tokens" value={tokenCount} detail="Public record verification" tone="blue" />
        </StaggerGroup>
      </section>

      <div className="inspection-filter-tabs certificate-filter-tabs" role="tablist" aria-label="Certificate status filters">
        {statusFilters.map((filter) => (
          <button
            aria-selected={workspace.statusFilter === filter.value}
            className={workspace.statusFilter === filter.value ? "is-active" : ""}
            key={filter.value}
            onClick={() => workspace.setStatusFilter(filter.value)}
            role="tab"
            type="button"
          >
            {filter.label}
          </button>
        ))}
      </div>

      <div className={`inspection-layout certificate-layout${workspace.selectedCertificate ? "" : " detail-closed"}`}>
        <div className="inspection-table-wrap certificate-table-wrap">
          <ModuleTable
            actionLabel={canManage ? "Issue Certificate" : undefined}
            actionsInToolbar
            className="asset-register-table certificate-register-table"
            columns={columns}
            countLabel={`${workspace.visibleCertificates.length} certificates`}
            emptyLabel="No certificates match the current filters."
            exportRows={(certificate) => [
              certificate.status,
              certificate.number,
              certificate.asset.assetNumber,
              certificate.customer.name,
              certificate.inspection.inspectionType,
              certificate.issuedAt,
              certificate.validUntil ?? "",
              certificate.publicToken,
              ""
            ]}
            activeFilterCount={workspace.activeFilterCount}
            filterControls={
              <>
                <label className="filter-field">
                  <span>Valid from</span>
                  <span className="date-input-shell">
                    <input
                      aria-label="Certificate valid from"
                      type="date"
                      value={workspace.validFrom}
                      onChange={(event) => workspace.setValidFrom(event.target.value)}
                    />
                    {!workspace.validFrom ? <span aria-hidden="true" className="date-input-placeholder">Select date</span> : null}
                    <CalendarDays aria-hidden="true" size={17} />
                  </span>
                </label>
                <label className="filter-field">
                  <span>Valid to</span>
                  <span className="date-input-shell">
                    <input
                      aria-label="Certificate valid to"
                      type="date"
                      value={workspace.validTo}
                      onChange={(event) => workspace.setValidTo(event.target.value)}
                    />
                    {!workspace.validTo ? <span aria-hidden="true" className="date-input-placeholder">Select date</span> : null}
                    <CalendarDays aria-hidden="true" size={17} />
                  </span>
                </label>
                <button className="secondary-button filter-clear" type="button" onClick={workspace.clearCertificateFilters}>
                  Clear certificate filters
                </button>
              </>
            }
            filtersInitiallyOpen
            getRowKey={(certificate) => certificate.id}
            items={workspace.visibleCertificates}
            onAction={canManage ? workspace.openCreate : undefined}
            onQueryChange={workspace.setQuery}
            onRowSelect={workspace.openDetail}
            query={workspace.query}
            searchLabel="Search certificates"
            searchPlaceholder="Search certificates, assets, customers..."
            selectedRowKey={workspace.selectedCertificate?.id ?? null}
            tableLabel="Certificate records"
          />
        </div>
        {workspace.selectedCertificate ? (
          <CertificateDetail
            canManage={canManage}
            certificate={workspace.selectedCertificate}
            onClose={workspace.closeDetail}
            onRevoke={workspace.revokeCertificate}
            onSupersede={workspace.supersedeCertificate}
          />
        ) : null}
      </div>

      <section className="certificate-verification-panel" aria-label="Certificate verification">
        <span className="certificate-verification-icon"><KeyRound aria-hidden="true" size={20} /></span>
        <div>
          <h3>Certificate verification</h3>
          <p>
            {tokenCount
              ? `${tokenCount} certificate${tokenCount === 1 ? " has" : "s have"} a public verification token.`
              : "No certificates currently have a public verification token."}
          </p>
        </div>
      </section>

      {canManage ? (
        <CertificateForm
          inspectionOptions={workspace.eligibleInspections}
          open={workspace.isFormOpen}
          onClose={() => workspace.setFormOpen(false)}
          onSubmit={workspace.issueCertificate}
        />
      ) : null}
    </section>
  );
}

function validityLabel(validUntil: string | null) {
  if (!validUntil) {
    return "No expiry recorded";
  }
  const days = Math.ceil((new Date(`${validUntil}T00:00:00`).getTime() - Date.now()) / 86_400_000);
  if (days < 0) {
    return `${Math.abs(days)} days expired`;
  }
  if (days === 0) {
    return "Expires today";
  }
  return `${days} days remaining`;
}

function CertificateMetric({
  detail,
  icon: Icon,
  label,
  tone,
  value
}: {
  detail: string;
  icon: typeof FileCheck2;
  label: string;
  tone: "amber" | "blue" | "green" | "red";
  value: number;
}) {
  return (
    <StaggerItem className={`asset-register-metric certificate-command-metric tone-${tone}`}>
      <Icon aria-hidden="true" size={21} />
      <span>
        <small>{label}</small>
        <strong>{value}</strong>
        <em>{detail}</em>
      </span>
    </StaggerItem>
  );
}
