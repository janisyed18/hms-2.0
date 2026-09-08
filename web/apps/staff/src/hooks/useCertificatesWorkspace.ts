import { useEffect, useMemo, useState } from "react";

import { createHmsClient } from "../api/hmsClient";
import type { CertificateIssueValues, CertificateRecord, CertificateStatus, InspectionRecord } from "../domain/types";

export type CertificateStatusFilter = "ALL" | CertificateStatus;

export function useCertificatesWorkspace() {
  const [certificates, setCertificates] = useState<CertificateRecord[]>([]);
  const [inspections, setInspections] = useState<InspectionRecord[]>([]);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<CertificateStatusFilter>("ALL");
  const [validFrom, setValidFrom] = useState("");
  const [validTo, setValidTo] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isFormOpen, setFormOpen] = useState(false);

  useEffect(() => {
    let active = true;
    const client = createHmsClient();
    void Promise.all([client.listCertificates({ sort: "-issued_at" }), client.listInspections({ sort: "-approved_at" })])
      .then(([certificateResult, inspectionResult]) => {
        if (!active) return;
        setCertificates(certificateResult.items); setInspections(inspectionResult.items);
      });
    return () => { active = false; };
  }, []);

  const eligibleInspections = useMemo(() => {
    const issuedInspectionIds = new Set(certificates.map((certificate) => certificate.inspectionId));
    return inspections.filter((inspection) => inspection.status === "APPROVED" && !issuedInspectionIds.has(inspection.id));
  }, [certificates, inspections]);
  const visibleCertificates = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return certificates.filter((certificate) => {
      const validUntil = certificate.validUntil ?? "";
      return (
        (statusFilter === "ALL" || certificate.status === statusFilter) &&
        (!validFrom || (validUntil && validUntil >= validFrom)) &&
        (!validTo || (validUntil && validUntil <= validTo)) &&
        (!normalized || [certificate.number, certificate.asset.assetNumber, certificate.asset.tag, certificate.customer.code, certificate.customer.name, certificate.product.code, certificate.product.name, certificate.publicToken, certificate.status, certificate.issuedByUserId].filter(Boolean).some((value) => value?.toLowerCase().includes(normalized)))
      );
    });
  }, [certificates, query, statusFilter, validFrom, validTo]);
  const selectedCertificate = useMemo(() => certificates.find((certificate) => certificate.id === selectedId) ?? null, [certificates, selectedId]);
  function openCreate() { setFormOpen(true); }
  function openDetail(certificate: CertificateRecord) { setSelectedId(certificate.id); }
  function closeDetail() { setSelectedId(null); }
  function replaceCertificate(updated: CertificateRecord) { setCertificates((current) => current.map((certificate) => certificate.id === updated.id ? updated : certificate)); setSelectedId(updated.id); }
  async function issueCertificate(values: CertificateIssueValues) {
    const issued = await createHmsClient().issueCertificate(values);
    setCertificates((current) => [issued, ...current]); setSelectedId(issued.id); setFormOpen(false); setQuery(""); setStatusFilter("ALL"); setValidFrom(""); setValidTo("");
  }
  async function revokeCertificate() { if (selectedCertificate) replaceCertificate(await createHmsClient().revokeCertificate(selectedCertificate.id)); }
  async function supersedeCertificate() { if (selectedCertificate) replaceCertificate(await createHmsClient().supersedeCertificate(selectedCertificate.id)); }
  function clearCertificateFilters() { setValidFrom(""); setValidTo(""); }
  const activeFilterCount = [Boolean(validFrom), Boolean(validTo)].filter(Boolean).length;
  return { activeFilterCount, certificates, clearCertificateFilters, closeDetail, eligibleInspections, isFormOpen, issueCertificate, openCreate, openDetail, query, selectedCertificate, setFormOpen, setQuery, setStatusFilter, setValidFrom, setValidTo, statusFilter, validFrom, validTo, revokeCertificate, supersedeCertificate, visibleCertificates };
}
