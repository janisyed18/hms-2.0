import { ModuleTable, type ModuleColumn } from "./ModuleTable";
import { useReferenceWorkspace } from "../hooks/useReferenceWorkspace";
import type { ReferenceStandardRecord } from "../domain/types";

const standardColumns: ModuleColumn<ReferenceStandardRecord>[] = [
  {
    header: "Code",
    render: (standard) => <strong>{standard.code}</strong>
  },
  {
    header: "Standard Name",
    render: (standard) => standard.name
  }
];

export function ReferenceWorkspace() {
  const workspace = useReferenceWorkspace();

  return (
    <ModuleTable
      actionLabel="Add Standard"
      columns={standardColumns}
      countLabel={`${workspace.standards.length} standards`}
      emptyLabel="No standards match the current filters."
      getRowKey={(standard) => standard.id}
      items={workspace.visibleStandards}
      onQueryChange={workspace.setQuery}
      query={workspace.query}
      searchLabel="Search reference standards"
      searchPlaceholder="Search standards..."
      source={workspace.source}
      tableLabel="Reference standard records"
    />
  );
}
