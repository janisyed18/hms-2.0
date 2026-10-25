import {
  BookOpenCheck,
  Cable,
  CircleGauge,
  Cuboid,
  Layers3,
  PackagePlus
} from "lucide-react";
import { useState } from "react";

import { ModuleTable, type ModuleColumn } from "./ModuleTable";
import { ProductsWorkspace } from "./ProductsWorkspace";
import { ManagementHeader } from "./ManagementPrimitives";
import { ActionButton } from "./interaction/ActionButton";
import { ActionNotice } from "./interaction/ActionNotice";
import { ConfirmDialog } from "./interaction/ConfirmDialog";
import { ReferenceForm } from "./ReferenceForm";
import { nameAndCode } from "../utils/identity";
import { useReferenceWorkspace } from "../hooks/useReferenceWorkspace";
import { PresencePanel } from "../motion/MotionPrimitives";
import type { ReferenceCatalogKey, ReferenceCatalogRecord } from "../domain/types";

interface ReferenceWorkspaceProps {
  canManage: boolean;
}

const catalogTabs: Array<{
  icon: typeof BookOpenCheck;
  key: ReferenceCatalogKey | "products";
  label: string;
}> = [
  { key: "products", label: "Products", icon: PackagePlus },
  { key: "standards", label: "Standards", icon: BookOpenCheck },
  { key: "materials", label: "Materials", icon: Layers3 },
  { key: "couplings", label: "Couplings", icon: Cable },
  { key: "coupling-add-ons", label: "Add-ons", icon: Cuboid },
  { key: "attach-methods", label: "Attachment Methods", icon: Cable },
  { key: "nominal-bores", label: "Nominal Bores", icon: CircleGauge }
];

export function ReferenceWorkspace({ canManage }: ReferenceWorkspaceProps) {
  const workspace = useReferenceWorkspace();
  const [activeTab, setActiveTab] = useState<ReferenceCatalogKey | "products">("standards");
  const columns: ModuleColumn<ReferenceCatalogRecord>[] = [
    { header: "Code", render: (record) => <strong>{record.code}</strong> },
    { header: "Name", render: (record) => record.name },
    {
      header: "Actions",
      render: (record) => canManage ? (
        <span className="row-actions">
          <ActionButton onClick={() => workspace.openEdit(record)} variant="secondary">Edit</ActionButton>
          <ActionButton onClick={() => workspace.archive.request(record)} variant="ghost">Archive</ActionButton>
        </span>
      ) : "Read only"
    }
  ];

  return (
    <section className="reference-catalog-workspace" aria-label="Reference data workspace">
      <ManagementHeader
        eyebrow="Reference data"
        title="Reference data"
        description="Manage controlled catalogue data used throughout the HMS workspace."
        context={<><BookOpenCheck aria-hidden="true" size={20} /><span><strong>Controlled access</strong><small>Changes are audit logged</small></span></>}
      />
      <div className="reference-catalog-tabs" role="tablist" aria-label="Reference data categories">
        {catalogTabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = tab.key === activeTab;
          return (
            <button
              aria-selected={isActive}
              className={isActive ? "is-active" : ""}
              key={tab.key}
              onClick={() => {
                setActiveTab(tab.key);
                if (tab.key !== "products") workspace.selectCategory(tab.key);
              }}
              role="tab"
              type="button"
            >
              <Icon aria-hidden="true" size={16} />
              {tab.label}
            </button>
          );
        })}
      </div>
      {activeTab === "products" ? (
        <PresencePanel presenceKey="products" className="reference-catalog-panel">
          <div className="reference-catalog-context">
            <div>
              <span className="reference-catalog-eyebrow">Products</span>
              <p>Hose product definitions, categories, standards, and pressure ratings.</p>
            </div>
            <span className={canManage ? "reference-access" : "reference-access is-read-only"}>
              {canManage ? "Managed access" : "Read only"}
            </span>
          </div>
          <ProductsWorkspace canManage={canManage} embedded />
        </PresencePanel>
      ) : (
        <PresencePanel presenceKey={workspace.activeCategory} className="reference-catalog-panel">
          <div className="reference-catalog-context">
            <div>
              <span className="reference-catalog-eyebrow">{workspace.activeMeta.plural}</span>
              <p>{workspace.activeMeta.description}</p>
            </div>
            <span className={canManage ? "reference-access" : "reference-access is-read-only"}>
              {canManage ? "Managed access" : "Read only"}
            </span>
          </div>
          {workspace.notice ? (
            <ActionNotice kind={workspace.notice.kind} onDismiss={workspace.dismissNotice} title={workspace.notice.title}>
              {workspace.notice.message}
            </ActionNotice>
          ) : null}
          <ModuleTable
            actionLabel={canManage ? `Add ${workspace.activeMeta.singular}` : undefined}
            columns={columns}
            countLabel={`${workspace.visibleRecords.length} ${workspace.activeMeta.plural.toLowerCase()}`}
            emptyLabel={`No ${workspace.activeMeta.plural.toLowerCase()} match the current search.`}
            error={workspace.error}
            exportRows={(record) => [record.code, record.name, ""]}
            getRowKey={(record) => record.id}
            items={workspace.visibleRecords}
            loading={workspace.isLoading}
            onAction={canManage ? workspace.openCreate : undefined}
            onQueryChange={workspace.setQuery}
            query={workspace.query}
            searchLabel={`Search ${workspace.activeMeta.plural.toLowerCase()}`}
            searchPlaceholder={`Search ${workspace.activeMeta.plural.toLowerCase()}...`}
            tableLabel={`${workspace.activeMeta.plural} catalog`}
          />
          <ConfirmDialog
            confirmLabel={`Archive ${workspace.activeMeta.singular.toLowerCase()}`}
            error={workspace.archive.error}
            message="It will no longer be offered when configuring assets and products. Records already using it are not changed."
            onCancel={workspace.archive.cancel}
            onConfirm={() => void workspace.archive.confirm()}
            open={workspace.archive.target !== null}
            pending={workspace.archive.pending}
            pendingLabel="Archiving…"
            title={workspace.archive.target ? `Archive ${nameAndCode(workspace.archive.target)}?` : `Archive ${workspace.activeMeta.singular.toLowerCase()}?`}
          />
          <ReferenceForm
            entityLabel={workspace.activeMeta.singular}
            open={workspace.isFormOpen}
            standard={workspace.editingRecord}
            onClose={() => workspace.setFormOpen(false)}
            onSubmit={workspace.saveRecord}
          />
        </PresencePanel>
      )}
    </section>
  );
}
