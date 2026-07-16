export function formatDateTime(value: string): string {
  return value.replace("T", " ").replace(/Z$/, "");
}
