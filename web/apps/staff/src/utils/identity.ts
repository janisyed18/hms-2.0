/**
 * Human-readable identity: the name people know first, the code or HMS number second.
 * Internal ids never appear here. Each helper falls back to the code alone when there is no
 * distinct name.
 */
function pair(name: string | null | undefined, code: string | null | undefined): string {
  const readable = name?.trim();
  const reference = code?.trim();
  if (readable && reference && readable !== reference) return `${readable} — ${reference}`;
  return readable || reference || "";
}

/** Any catalog record with a name and a code: "Hydraulic Hose — PROD-014". */
export function nameAndCode(record: { code?: string | null; name?: string | null }): string {
  return pair(record.name, record.code);
}

/** "Main Pump Hose — HMS-001842" */
export function assetLabel(asset: { assetNumber: string; assetName?: string | null }): string {
  return pair(asset.assetName, asset.assetNumber);
}

/** "Hydraulic Hose — PROD-014" */
export function productLabel(product: { code: string; name?: string | null }): string {
  return pair(product.name, product.code);
}

/** "Orica — ORIC" */
export function customerLabel(customer: { code?: string | null; name: string }): string {
  return pair(customer.name, customer.code);
}
