import { QrCode } from "lucide-react";

interface ScanUnavailableProps {
  onBack: () => void;
}

export function ScanUnavailable({ onBack }: ScanUnavailableProps) {
  return (
    <section className="empty-state">
      <QrCode aria-hidden="true" size={30} />
      <h2>Scan capture is not available</h2>
      <p>
        Barcode and QR scanning will be added in a later native mobile phase.
      </p>
      <button className="primary-action" onClick={onBack} type="button">
        Back to Work Queue
      </button>
    </section>
  );
}
