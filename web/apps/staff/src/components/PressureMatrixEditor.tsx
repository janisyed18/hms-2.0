import type { PressureRatingRecord } from "../domain/types";

interface PressureMatrixEditorProps {
  rows: PressureRatingRecord[];
  onAddRow: () => void;
}

export function PressureMatrixEditor({ rows, onAddRow }: PressureMatrixEditorProps) {
  return (
    <section className="drawer-section" aria-label="Pressure matrix">
      <div className="section-heading compact">
        <h3>Pressure Matrix</h3>
        <button type="button" onClick={onAddRow}>
          Add pressure rating
        </button>
      </div>
      <div className="pressure-list">
        {rows.map((row) => (
          <div key={row.id}>
            <strong>{row.label}</strong>
            <span>{row.pressureKpa} kPa</span>
          </div>
        ))}
        {rows.length === 0 ? <p>No pressure ratings configured.</p> : null}
      </div>
    </section>
  );
}
