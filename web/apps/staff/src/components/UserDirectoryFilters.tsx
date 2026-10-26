import { Search } from "lucide-react";

import { ActionButton } from "./interaction/ActionButton";
import { hasActiveFilters, type UserFilters } from "../hooks/useUserDirectory";
import type { CustomerOption } from "./UserAdminDialog";

const ROLE_OPTIONS = [
  ["SUPER_ADMIN", "Super Admin"],
  ["HMS_ADMIN", "HMS Admin"],
  ["REVIEWER", "Reviewer"],
  ["INSPECTOR", "Inspector"],
  ["ASSEMBLY", "Assembly"],
  ["CUSTOMER_USER", "Customer User"]
] as const;

export function UserDirectoryFilters({
  customers,
  filters,
  onChange,
  onClear
}: {
  customers: CustomerOption[];
  filters: UserFilters;
  onChange: (next: Partial<UserFilters>) => void;
  onClear: () => void;
}) {
  return (
    <form className="user-filters" onSubmit={(event) => event.preventDefault()} role="search" aria-label="Filter users">
      <div className="filter-grid">
        <label className="filter-field user-filter-search">
          <span>Search users</span>
          <span className="user-filter-input">
            <Search aria-hidden="true" size={15} />
            <input
              autoComplete="off"
              onChange={(event) => onChange({ search: event.target.value })}
              placeholder="Name, email or user ID"
              type="search"
              value={filters.search}
            />
          </span>
        </label>
        <label className="filter-field">
          <span>Role</span>
          <select onChange={(event) => onChange({ role: event.target.value })} value={filters.role}>
            <option value="">All roles</option>
            {ROLE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="filter-field">
          <span>Account status</span>
          <select onChange={(event) => onChange({ accountStatus: event.target.value as UserFilters["accountStatus"] })} value={filters.accountStatus}>
            <option value="">Any status</option>
            <option value="ACTIVE">Active</option>
            <option value="LOCKED">Locked</option>
            <option value="DISABLED">Disabled</option>
          </select>
        </label>
        <label className="filter-field">
          <span>MFA</span>
          <select onChange={(event) => onChange({ mfa: event.target.value as UserFilters["mfa"] })} value={filters.mfa}>
            <option value="">Any MFA state</option>
            <option value="enabled">Enabled</option>
            <option value="setup_required">Setup required</option>
          </select>
        </label>
        {customers.length > 0 ? (
          <label className="filter-field">
            <span>Customer</span>
            <select onChange={(event) => onChange({ customerId: event.target.value })} value={filters.customerId}>
              <option value="">All customers</option>
              {customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}
            </select>
          </label>
        ) : null}
        <label className="filter-field">
          <span>Sort by</span>
          <select onChange={(event) => onChange({ sort: event.target.value as UserFilters["sort"] })} value={filters.sort}>
            <option value="name">Name</option>
            <option value="email">Email</option>
            <option value="role">Role</option>
            <option value="-last_login_at">Last login (newest)</option>
          </select>
        </label>
        {hasActiveFilters(filters) ? (
          <ActionButton className="filter-clear" onClick={onClear} variant="secondary">Clear filters</ActionButton>
        ) : null}
      </div>
    </form>
  );
}
