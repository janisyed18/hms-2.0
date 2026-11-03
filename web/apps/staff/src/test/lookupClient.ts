/**
 * A stand-in for the server's searchable lists (customers, products, assets, inspections) and a customer's
 * locations, for tests of forms that search as the person types. Plain functions, not spies, so a test
 * runner's mock reset cannot blank them; `calls` records what was asked.
 */
interface Named { id: string; name: string; code?: string | null }

export const lookups = {
  customers: [] as Named[],
  products: [] as Array<Named & { category?: string }>,
  assets: [] as unknown[],
  inspections: [] as unknown[],
  standards: [] as Array<{ id: string; code: string; name: string; enabled: boolean }>,
  locations: {} as Record<string, Array<{ id: string; name: string }>>,
  calls: [] as Array<{ method: string; options: unknown }>
};

export function resetLookups() {
  lookups.customers = [];
  lookups.products = [];
  lookups.assets = [];
  lookups.inspections = [];
  lookups.standards = [];
  lookups.locations = {};
  lookups.calls = [];
}

function page<T extends Named>(method: string, items: T[], options: { search?: string; limit?: number } | undefined) {
  lookups.calls.push({ method, options });
  const needle = (options?.search ?? "").trim().toLowerCase();
  const matched = items.filter((item) => !needle || `${item.name} ${item.code ?? ""}`.toLowerCase().includes(needle));
  const shown = matched.slice(0, options?.limit ?? 50);
  return Promise.resolve({ total: matched.length, items: shown, etag: null });
}

export const lookupClient = {
  listCustomers: (options?: { search?: string; limit?: number }) => page("listCustomers", lookups.customers, options),
  listProducts: (options?: { search?: string; limit?: number }) => page("listProducts", lookups.products, options),
  listAssets: (options?: { search?: string; limit?: number }) => page("listAssets", lookups.assets as Named[], options),
  listInspections: (options?: { search?: string; limit?: number }) => page("listInspections", lookups.inspections as Named[], options),
  listReferenceCatalog: () => Promise.resolve({ total: lookups.standards.length, items: lookups.standards, etag: null }),
  getCustomer: (id: string) => {
    const customer = lookups.customers.find((item) => item.id === id);
    if (!customer) return Promise.reject(new Error("not found"));
    return Promise.resolve({ ...customer, notes: null, contacts: [], locations: lookups.locations[id] ?? [] });
  }
};
