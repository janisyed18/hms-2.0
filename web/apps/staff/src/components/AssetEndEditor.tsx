import type { AssetEndValues } from "../domain/types";

interface AssetEndEditorProps {
  label: "A" | "B";
  values: AssetEndValues;
  onChange: (values: AssetEndValues) => void;
}

export function AssetEndEditor({ label, values, onChange }: AssetEndEditorProps) {
  return (
    <section className="drawer-section" aria-label={`${label} end configuration`}>
      <h3>{label} End</h3>
      <label>
        <span>{label} end fitting</span>
        <input
          aria-label={`${label} end fitting`}
          value={values.fitting}
          onChange={(event) => onChange({ ...values, fitting: event.target.value })}
        />
      </label>
      <label>
        <span>{label} end size</span>
        <input
          aria-label={`${label} end size`}
          value={values.size}
          onChange={(event) => onChange({ ...values, size: event.target.value })}
        />
      </label>
    </section>
  );
}
