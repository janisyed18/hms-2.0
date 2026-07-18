import type { AssetEndValues, RecordSummary } from "../domain/types";

interface AssetEndEditorProps {
  label: "A" | "B";
  attachMethods: RecordSummary[];
  couplingAddOns: RecordSummary[];
  couplings: RecordSummary[];
  values: AssetEndValues;
  onChange: (values: AssetEndValues) => void;
}

function updateSelection(
  options: RecordSummary[],
  id: string,
): RecordSummary | null {
  return options.find((option) => option.id === id) ?? null;
}

export function AssetEndEditor({
  label,
  attachMethods,
  couplingAddOns,
  couplings,
  values,
  onChange
}: AssetEndEditorProps) {
  return (
    <>
      <label>
        <span>Coupling ({label})</span>
        <select
          aria-label={`Coupling (${label})`}
          value={values.coupling?.id ?? ""}
          onChange={(event) => onChange({
            ...values,
            coupling: updateSelection(couplings, event.target.value)
          })}
        >
          <option value="">Select coupling</option>
          {couplings.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
        </select>
      </label>
      <label>
        <span>Add-ons ({label})</span>
        <select
          aria-label={`Add-ons (${label})`}
          value={values.couplingAddOn?.id ?? ""}
          onChange={(event) => onChange({
            ...values,
            couplingAddOn: updateSelection(couplingAddOns, event.target.value)
          })}
        >
          <option value="">Select add-on</option>
          {couplingAddOns.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
        </select>
      </label>
      <label>
        <span>Attach Methods ({label})</span>
        <select
          aria-label={`Attach Methods (${label})`}
          value={values.attachMethod?.id ?? ""}
          onChange={(event) => onChange({
            ...values,
            attachMethod: updateSelection(attachMethods, event.target.value)
          })}
        >
          <option value="">Select attach method</option>
          {attachMethods.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
        </select>
      </label>
    </>
  );
}
