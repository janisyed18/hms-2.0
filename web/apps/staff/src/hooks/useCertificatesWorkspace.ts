import { useEffect, useMemo, useState } from "react";

import {
  createHmsClient,
  loadCertificatesWithFallback,
  loadInspectionsWithFallback
} from "../api/hmsClient";
import type {
  CertificateIssueValues,
  CertificateRecord,
  CertificateStatus,
  DataSource,
  InspectionRecord
} from "../domain/types";

export type CertificateStatusFilter = "ALL" | CertificateStatus;

function certificateSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function localCertificate(
  values: CertificateIssueValues,
  inspections: InspectionRecord[]
): CertificateRecord {
  const inspection = inspections.find((item) => item.id === values.inspectionId);
  if (!inspection) {
    throw new Error("Certificate requires an approved inspection");
  }
  const slug = certificateSlug(values.number);
  return {
    id: `certificate-${Date.now()}`,
    inspectionId: inspection.id,
    assetId: inspection.assetId,
    number: values.number,
    certificateVersion: 1,
    issuedAt: new Date().toISOString(),
    validUntil: values.validUntil,
    pdfObjectKey: `certificates/${values.number}.pdf`,
    verificationHash: `dev-hash-${slug}-${inspection.id}`,
    publicToken: `verify-${slug}-${inspection.id.slice(0, 8)}`,
    issuedByUserId: "staff-ui-dev",
    status: "ISSUED",
    asset: inspection.asset,
    customer: inspection.customer,
    product: inspection.product,
    inspection: {
      id: inspection.id,
      inspectionType: inspection.inspectionType,
      status: inspection.status,
      result: inspection.result,
      approvedAt: inspection.approvedAt
    }
  };
}

function localCertificateStatusUpdate(
  certificate: CertificateRecord,
  status: CertificateStatus
): CertificateRecord {
  return {
    ...certificate,
    status
  };
}

export function useCertificatesWorkspace() {
  const [certificates, setCertificates] = useState<CertificateRecord[]>([]);
  const [inspections, setInspections] = useState<InspectionRecord[]>([]);
  const [source, setSource] = useState<DataSource>("mock");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] =
    useState<CertificateStatusFilter>("ALL");
  const [validFrom, setValidFrom] = useState("");
  const [validTo, setValidTo] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isFormOpen, setFormOpen] = useState(false);

  useEffect(() => {
    let active = true;
    Promise.all([
      loadCertificatesWithFallback({ sort: "-issued_at" }),
      loadInspectionsWithFallback({ sort: "-approved_at" })
    ]).then(([certificateResult, inspectionResult]) => {
      if (!active) {
        return;
      }
      setCertificates(certificateResult.items);
      setInspections(inspectionResult.items);
      setSource(certificateResult.source);
    });
    return () => {
      active = false;
    };
  }, []);

  const eligibleInspections = useMemo(() => {
    const issuedInspectionIds = new Set(
      certificates.map((certificate) => certificate.inspectionId)
    );
    return inspections.filter(
      (inspection) =>
        inspection.status === "APPROVED" && !issuedInspectionIds.has(inspection.id)
    );
  }, [certificates, inspections]);

  const visibleCertificates = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return certificates.filter((certificate) => {
      const matchesStatus =
        statusFilter === "ALL" || certificate.status === statusFilter;
      const validUntil = certificate.validUntil ?? "";
      const matchesValidFrom = !validFrom || (validUntil && validUntil >= validFrom);
      const matchesValidTo = !validTo || (validUntil && validUntil <= validTo);
      const matchesSearch =
        !normalized ||
        [
          certificate.number,
          certificate.asset.assetNumber,
          certificate.asset.tag,
          certificate.customer.code,
          certificate.customer.name,
          certificate.product.code,
          certificate.product.name,
          certificate.publicToken,
          certificate.status,
          certificate.issuedByUserId
        ]
          .filter(Boolean)
          .some((value) => value?.toLowerCase().includes(normalized));
      return matchesStatus && matchesValidFrom && matchesValidTo && matchesSearch;
    });
  }, [certificates, query, statusFilter, validFrom, validTo]);

  const selectedCertificate = useMemo(
    () =>
      certificates.find((certificate) => certificate.id === selectedId) ?? null,
    [certificates, selectedId]
  );

  function openCreate() {
    setFormOpen(true);
  }

  function openDetail(certificate: CertificateRecord) {
    setSelectedId(certificate.id);
  }

  function closeDetail() {
    setSelectedId(null);
  }

  async function issueCertificate(values: CertificateIssueValues) {
    let issued = localCertificate(values, inspections);
    if (source === "api") {
      try {
        issued = await createHmsClient().issueCertificate(values);
      } catch {
        issued = localCertificate(values, inspections);
      }
    }
    setCertificates((current) => [issued, ...current]);
    setSelectedId(issued.id);
    setFormOpen(false);
    setQuery("");
    setStatusFilter("ALL");
    setValidFrom("");
    setValidTo("");
  }

  function replaceCertificate(updated: CertificateRecord) {
    setCertificates((current) =>
      current.map((certificate) =>
        certificate.id === updated.id ? updated : certificate
      )
    );
    setSelectedId(updated.id);
  }

  async function revokeCertificate() {
    if (!selectedCertificate) {
      return;
    }
    let updated = localCertificateStatusUpdate(selectedCertificate, "REVOKED");
    if (source === "api") {
      try {
        updated = await createHmsClient().revokeCertificate(selectedCertificate.id);
      } catch {
        updated = localCertificateStatusUpdate(selectedCertificate, "REVOKED");
      }
    }
    replaceCertificate(updated);
  }

  async function supersedeCertificate() {
    if (!selectedCertificate) {
      return;
    }
    let updated = localCertificateStatusUpdate(selectedCertificate, "SUPERSEDED");
    if (source === "api") {
      try {
        updated = await createHmsClient().supersedeCertificate(
          selectedCertificate.id
        );
      } catch {
        updated = localCertificateStatusUpdate(selectedCertificate, "SUPERSEDED");
      }
    }
    replaceCertificate(updated);
  }

  function clearCertificateFilters() {
    setValidFrom("");
    setValidTo("");
  }

  const activeFilterCount = [Boolean(validFrom), Boolean(validTo)].filter(Boolean).length;

  return {
    activeFilterCount,
    certificates,
    clearCertificateFilters,
    closeDetail,
    eligibleInspections,
    isFormOpen,
    issueCertificate,
    openCreate,
    openDetail,
    query,
    selectedCertificate,
    setFormOpen,
    setQuery,
    setStatusFilter,
    setValidFrom,
    setValidTo,
    source,
    statusFilter,
    validFrom,
    validTo,
    revokeCertificate,
    supersedeCertificate,
    visibleCertificates
  };
}
