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

/** "Jane Smith (jane@example.com)": the person first, the sign-in email second. */
export function userLabel(user: { displayName?: string | null; email: string }): string {
  const name = user.displayName?.trim();
  return name && name.toLowerCase() !== user.email.toLowerCase() ? `${name} (${user.email})` : user.email;
}

/** "Field tablet 01 — dev-0123": the device's name, then its id. */
export function deviceLabel(device: { displayName?: string | null; deviceId: string }): string {
  return pair(device.displayName, device.deviceId);
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

/**
 * The name to greet someone by, or null when all we know is their email: a greeting must never
 * read out a sign-in address. `session.displayName` falls back to the email when no name is set.
 */
export function greetingName(session: { displayName: string; email?: string }): string | null {
  const name = session.displayName.trim();
  if (!name || name.includes("@") || name.toLowerCase() === session.email?.trim().toLowerCase()) return null;
  return name;
}

/** The person's name as stored, or null for a legacy account that never had one. */
export function personName(user: { firstName?: string | null; lastName?: string | null }): string | null {
  return [user.firstName, user.lastName].map((part) => part?.trim()).filter(Boolean).join(" ") || null;
}
