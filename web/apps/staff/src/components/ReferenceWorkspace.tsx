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
import { ReferenceForm } from "./ReferenceForm";
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
          <button type="button" onClick={() => workspace.openEdit(record)}>Edit</button>
          <button type="button" onClick={() => void workspace.archiveRecord(record)}>Archive</button>
        </span>
      ) : "Read only"
    }
  ];

  return (
    <section className="reference-catalog-workspace" aria-label="Reference data workspace">
      <header className="reference-catalog-header">
        <div>
          <span>Controlled catalogue</span>
          <h2>Reference data</h2>
          <p>Changes are audited and immediately available to asset configuration.</p>
        </div>
      </header>
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
          <ProductsWorkspace canManage={canManage} />
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
