import { AlertTriangle, FileCheck2, KeyRound, ShieldCheck } from "lucide-react";

import { CertificateDetail } from "./CertificateDetail";
import { CertificateForm } from "./CertificateForm";
import { ModuleTable, type ModuleColumn } from "./ModuleTable";
import {
  type CertificateStatusFilter,
  useCertificatesWorkspace
} from "../hooks/useCertificatesWorkspace";
import type { CertificateRecord } from "../domain/types";

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
  if (status === "SUPERSEDED") {
    return "mini-status due-soon";
  }
  return "mini-status current";
}

function countByStatus(certificates: CertificateRecord[], status: string) {
  return certificates.filter((certificate) => certificate.status === status).length;
}

function expiringSoonCount(certificates: CertificateRecord[]) {
  const now = new Date();
  const threshold = new Date();
  threshold.setDate(threshold.getDate() + 60);
  return certificates.filter((certificate) => {
    if (!certificate.validUntil) {
      return false;
    }
    const validUntil = new Date(certificate.validUntil);
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
      render: (certificate) => <strong>{certificate.number}</strong>
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
      header: "Valid Until",
      render: (certificate) => certificate.validUntil ?? "Not set"
    },
    {
      header: "Verification",
      render: (certificate) => certificate.publicToken
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
    <section className="inspection-workspace" aria-label="Certificate workspace">
      <div className="inspection-dashboard">
        <div className="inspection-dashboard-heading">
          <div>
            <h2>Certificate Queue</h2>
            <p>Issue and review versioned certificates for approved inspections.</p>
          </div>
        </div>
        <div className="inspection-metrics" aria-label="Certificate metrics">
          <div>
            <FileCheck2 aria-hidden="true" size={18} />
            <span>Issued</span>
            <strong>{issuedCount}</strong>
          </div>
          <div>
            <AlertTriangle aria-hidden="true" size={18} />
            <span>Expiring</span>
            <strong>{soonCount}</strong>
          </div>
          <div>
            <ShieldCheck aria-hidden="true" size={18} />
            <span>Revoked</span>
            <strong>{revokedCount}</strong>
          </div>
          <div>
            <KeyRound aria-hidden="true" size={18} />
            <span>Tokens</span>
            <strong>{tokenCount}</strong>
          </div>
        </div>
        <div className="inspection-filter-tabs" role="tablist" aria-label="Certificate status filters">
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
      </div>

      <div className={`inspection-layout${workspace.selectedCertificate ? "" : " detail-closed"}`}>
        <div className="inspection-table-wrap">
          <ModuleTable
            actionLabel={canManage ? "Issue Certificate" : undefined}
            columns={columns}
            countLabel={`${workspace.visibleCertificates.length} certificates`}
            emptyLabel="No certificates match the current filters."
            exportRows={(certificate) => [
              certificate.status,
              certificate.number,
              certificate.asset.assetNumber,
              certificate.customer.name,
              certificate.validUntil ?? "",
              certificate.publicToken,
              ""
            ]}
            activeFilterCount={workspace.activeFilterCount}
            filterControls={
              <>
                <label className="filter-field">
                  <span>Valid from</span>
                  <input
                    aria-label="Certificate valid from"
                    type="date"
                    value={workspace.validFrom}
                    onChange={(event) => workspace.setValidFrom(event.target.value)}
                  />
                </label>
                <label className="filter-field">
                  <span>Valid to</span>
                  <input
                    aria-label="Certificate valid to"
                    type="date"
                    value={workspace.validTo}
                    onChange={(event) => workspace.setValidTo(event.target.value)}
                  />
                </label>
                <button className="secondary-button filter-clear" type="button" onClick={workspace.clearCertificateFilters}>
                  Clear certificate filters
                </button>
              </>
            }
            getRowKey={(certificate) => certificate.id}
            items={workspace.visibleCertificates}
            onAction={canManage ? workspace.openCreate : undefined}
            onQueryChange={workspace.setQuery}
            onRowSelect={workspace.openDetail}
            query={workspace.query}
            searchLabel="Search certificates"
            searchPlaceholder="Search certificates..."
            selectedRowKey={workspace.selectedCertificate?.id ?? null}
            source={workspace.source}
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
