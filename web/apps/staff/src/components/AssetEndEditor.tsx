import type { AssetEndValues, RecordSummary } from "../domain/types";

interface AssetEndEditorProps {
  label: "A" | "B";
  attachMethods: RecordSummary[];
  materials: RecordSummary[];
  nominalBores: RecordSummary[];
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
  materials,
  nominalBores,
  couplingAddOns,
  couplings,
  values,
  onChange
}: AssetEndEditorProps) {
  return (
    <fieldset className="asset-end">
      <legend>End {label}</legend>
      <label>
        <span>Material ({label})</span>
        <select aria-label={`Material (${label})`} value={values.material?.id ?? ""} onChange={(event) => onChange({ ...values, material: updateSelection(materials, event.target.value) })}>
          <option value="">Not specified</option>
          {materials.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
        </select>
      </label>
      <label>
        <span>Nominal Bore ({label})</span>
        <select aria-label={`Nominal Bore (${label})`} value={values.nominalBore?.id ?? ""} onChange={(event) => onChange({ ...values, nominalBore: updateSelection(nominalBores, event.target.value) })}>
          <option value="">Not specified</option>
          {nominalBores.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
        </select>
      </label>
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
    </fieldset>
  );
}
