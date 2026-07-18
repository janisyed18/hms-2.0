import { ModuleTable, type ModuleColumn } from "./ModuleTable";
import { ReferenceForm } from "./ReferenceForm";
import { useReferenceWorkspace } from "../hooks/useReferenceWorkspace";
import type { ReferenceStandardRecord } from "../domain/types";

export function ReferenceWorkspace() {
  const workspace = useReferenceWorkspace();
  const standardColumns: ModuleColumn<ReferenceStandardRecord>[] = [
    {
      header: "Code",
      render: (standard) => <strong>{standard.code}</strong>
    },
    {
      header: "Standard Name",
      render: (standard) => standard.name
    },
    {
      header: "Actions",
      render: (standard) => (
        <span className="row-actions">
          <button type="button" onClick={() => workspace.openEdit(standard)}>
            Edit
          </button>
          <button type="button" onClick={() => workspace.archiveStandard(standard)}>
            Archive
          </button>
        </span>
      )
    }
  ];

  return (
    <>
      <ModuleTable
        actionLabel="Add Standard"
        columns={standardColumns}
        countLabel={`${workspace.standards.length} standards`}
        emptyLabel="No standards match the current filters."
        exportRows={(standard) => [standard.code, standard.name, ""]}
        getRowKey={(standard) => standard.id}
        items={workspace.visibleStandards}
        onAction={workspace.openCreate}
        onQueryChange={workspace.setQuery}
        query={workspace.query}
        searchLabel="Search reference standards"
        searchPlaceholder="Search standards..."
        tableLabel="Reference standard records"
      />
      <ReferenceForm
        open={workspace.isFormOpen}
        standard={workspace.editingStandard}
        onClose={() => workspace.setFormOpen(false)}
        onSubmit={workspace.saveStandard}
      />
    </>
  );
}
