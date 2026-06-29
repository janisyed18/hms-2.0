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
  { label: "All", value: "ALL" },
  { label: "Issued", value: "ISSUED" },
  { label: "Superseded", value: "SUPERSEDED" },
  { label: "Revoked", value: "REVOKED" }
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

export function CertificatesWorkspace() {
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
            <h2>Certificate Management</h2>
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
        <div className="inspection-filter-tabs" aria-label="Certificate status filters">
          {statusFilters.map((filter) => (
            <button
              className={workspace.statusFilter === filter.value ? "is-active" : ""}
              key={filter.value}
              onClick={() => workspace.setStatusFilter(filter.value)}
              type="button"
            >
              {filter.label}
            </button>
          ))}
        </div>
      </div>

      <div className="inspection-layout">
        <div className="inspection-table-wrap">
          <ModuleTable
            actionLabel="Issue Certificate"
            columns={columns}
            countLabel={`${workspace.visibleCertificates.length} certificates`}
            emptyLabel="No certificates match the current filters."
            getRowKey={(certificate) => certificate.id}
            items={workspace.visibleCertificates}
            onAction={workspace.openCreate}
            onQueryChange={workspace.setQuery}
            query={workspace.query}
            searchLabel="Search certificates"
            searchPlaceholder="Search certificates..."
            source={workspace.source}
            tableLabel="Certificate records"
          />
        </div>
        <CertificateDetail
          certificate={workspace.selectedCertificate}
          onClose={workspace.closeDetail}
        />
      </div>

      <CertificateForm
        inspectionOptions={workspace.eligibleInspections}
        open={workspace.isFormOpen}
        onClose={() => workspace.setFormOpen(false)}
        onSubmit={workspace.issueCertificate}
      />
    </section>
  );
}
