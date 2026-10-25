import { useEffect, useMemo, useState } from "react";

import { createHmsClient } from "../api/hmsClient";
import { useActionNotice } from "../components/interaction/ActionNotice";
import { friendlyApiError } from "../components/interaction/friendlyApiError";
import { useConfirmedAction } from "../components/interaction/useConfirmedAction";
import { assetLabel } from "../utils/identity";
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
  const { notice, notify, clear: dismissNotice } = useActionNotice();
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const client = createHmsClient();
    void Promise.all([client.listCertificates({ sort: "-issued_at" }), client.listInspections({ sort: "-approved_at" })])
      .then(([certificateResult, inspectionResult]) => {
        if (!active) return;
        setCertificates(certificateResult.items); setInspections(inspectionResult.items);
      })
      .catch((reason: unknown) => {
        if (active) setLoadError(friendlyApiError(reason, { fallback: "Certificates could not be loaded." }).message);
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
    notify({ kind: "success", title: "Certificate issued", message: `Certificate ${issued.number} for ${assetLabel(issued.asset)} issued successfully.` });
  }
  const lifecycle = useConfirmedAction<{ action: "revoke" | "supersede"; certificate: CertificateRecord }>(
    async ({ action, certificate }) => {
      const client = createHmsClient();
      const updated = action === "revoke" ? await client.revokeCertificate(certificate.id) : await client.supersedeCertificate(certificate.id);
      replaceCertificate(updated);
      notify({ kind: "success", title: action === "revoke" ? "Certificate revoked" : "Certificate superseded", message: `Certificate ${updated.number} for ${assetLabel(updated.asset)} was ${action === "revoke" ? "revoked" : "marked superseded"}.` });
    },
    ({ action, certificate }) => ({ fallback: `Certificate ${certificate.number} could not be ${action === "revoke" ? "revoked" : "marked superseded"}. Try again.` })
  );
  function requestLifecycle(action: "revoke" | "supersede") { if (selectedCertificate) lifecycle.request({ action, certificate: selectedCertificate }); }
  function clearCertificateFilters() { setValidFrom(""); setValidTo(""); }
  const activeFilterCount = [Boolean(validFrom), Boolean(validTo)].filter(Boolean).length;
  return { activeFilterCount, certificates, dismissNotice, lifecycle, loadError, notice, requestLifecycle, clearCertificateFilters, closeDetail, eligibleInspections, isFormOpen, issueCertificate, openCreate, openDetail, query, selectedCertificate, setFormOpen, setQuery, setStatusFilter, setValidFrom, setValidTo, statusFilter, validFrom, validTo, visibleCertificates };
}
