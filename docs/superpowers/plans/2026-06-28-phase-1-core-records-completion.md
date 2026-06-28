# Phase 1 Core Records Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Phase 1 core HMS record management across backend contracts and the React staff app.

**Architecture:** Finish backend safety contracts first: soft delete, ETags, `If-Match`, and allow-listed sorting on customers/products/reference/assets. Then expand the existing React staff app into core-record modules using one premium shell, typed API client functions, package-backed icons, shared table/drawer primitives, and mock fallback only when backend requests fail.

**Tech Stack:** FastAPI, SQLAlchemy 2.0 async, Alembic, pytest, React, Vite, TypeScript, Vitest, Testing Library, lucide-react.

---

## File Structure

- `backend/src/hms_backend/app/api/records.py`: add sort helpers, ETag helpers, `If-Match` checks, and soft-delete endpoints.
- `backend/src/hms_backend/app/api/schemas.py`: add response fields only if needed by frontend; keep current Pydantic response models stable.
- `backend/tests/test_core_records_api.py`: add backend red-green coverage for Phase 1 contract completion.
- `web/apps/staff/src/api/hmsClient.ts`: expand typed API client beyond customers.
- `web/apps/staff/src/domain/types.ts`: add product, reference, asset, pressure-rating, and asset-end view types.
- `web/apps/staff/src/data/mockCustomers.ts`: split or supplement with `mockReferenceData.ts`, `mockProducts.ts`, and `mockAssets.ts`.
- `web/apps/staff/src/hooks/useCustomerWorkspace.ts`: keep customer state focused; add separate hooks for assets/products/reference.
- `web/apps/staff/src/components/*`: add shared module navigation, tables, forms, drawers, pressure matrix, and asset-end editor components.
- `web/apps/staff/src/__tests__/*`: add tests before each frontend feature implementation.

---

### Task 1: Backend Soft Delete Contract

**Files:**
- Modify: `backend/tests/test_core_records_api.py`
- Modify: `backend/src/hms_backend/app/api/records.py`

- [ ] **Step 1: Write failing backend tests**

Add tests that:

- `DELETE /api/v1/customers/{customer_id}` returns `204`.
- The deleted customer no longer appears in `GET /api/v1/customers`.
- The deleted row has `deleted_at` set in the database.
- A `SyncChange` tombstone is written with `op="delete"`.
- An `AuditEvent` is written with action `customer.deleted`.
- A `CUSTOMER_USER` cannot delete a customer.

Run:

```bash
cd backend
uv run pytest tests/test_core_records_api.py::test_soft_delete_customer_writes_tombstone_sync_and_audit -v
```

Expected: FAIL because the endpoint does not exist.

- [ ] **Step 2: Implement customer soft delete**

Add a `DELETE /customers/{customer_id}` route that uses the existing soft-delete repository/audit/sync pattern and never hard-deletes.

- [ ] **Step 3: Repeat soft-delete coverage for product/reference/asset**

Add and implement delete/archive routes for:

- `DELETE /api/v1/reference/standards/{standard_id}`
- `DELETE /api/v1/products/{product_id}`
- `DELETE /api/v1/assets/{asset_id}`

Each route must enforce existing write/admin permissions and write audit/sync rows.

- [ ] **Step 4: Verify**

Run:

```bash
cd backend
uv run pytest tests/test_core_records_api.py -v
```

Expected: PASS.

Commit:

```bash
git add backend/src/hms_backend/app/api/records.py backend/tests/test_core_records_api.py
git commit -m "feat: add audited soft delete endpoints"
```

### Task 2: Backend ETag And If-Match

**Files:**
- Modify: `backend/tests/test_core_records_api.py`
- Modify: `backend/src/hms_backend/app/api/records.py`

- [ ] **Step 1: Write failing ETag tests**

Add tests that:

- `GET /api/v1/customers/{customer_id}` includes an `ETag` matching the customer `version`.
- `PATCH /api/v1/customers/{customer_id}` with a stale `If-Match` returns `412`.
- `PATCH /api/v1/customers/{customer_id}` with the current `If-Match` succeeds and increments the version.

Run:

```bash
cd backend
uv run pytest tests/test_core_records_api.py::test_customer_detail_returns_etag_and_patch_enforces_if_match -v
```

Expected: FAIL because ETag headers are not implemented.

- [ ] **Step 2: Implement shared ETag helpers**

Add private helpers in `records.py`:

- `_etag_for_version(version: int) -> str`
- `_set_etag(response: Response, version: int) -> None`
- `_enforce_if_match(if_match: str | None, version: int) -> None`

Use standard quoted ETag values like `"3"`.

- [ ] **Step 3: Apply ETag to mutable detail routes**

Apply to customer, product, reference standard, and asset detail/update/delete routes. Do not require `If-Match` yet when the header is absent; enforce only when supplied.

- [ ] **Step 4: Verify**

Run:

```bash
cd backend
uv run pytest tests/test_core_records_api.py -v
```

Expected: PASS.

Commit:

```bash
git add backend/src/hms_backend/app/api/records.py backend/tests/test_core_records_api.py
git commit -m "feat: add etag concurrency checks"
```

### Task 3: Backend Sort Parameters

**Files:**
- Modify: `backend/tests/test_core_records_api.py`
- Modify: `backend/src/hms_backend/app/api/records.py`

- [ ] **Step 1: Write failing sort tests**

Add tests that:

- `GET /api/v1/customers?sort=name` returns customers by name ascending.
- `GET /api/v1/customers?sort=-name` returns customers by name descending.
- `GET /api/v1/customers?sort=deleted_at` returns `400`.
- Equivalent allow-listed sort behavior exists for products and assets.

Run:

```bash
cd backend
uv run pytest tests/test_core_records_api.py::test_customers_endpoint_supports_allow_listed_sorting -v
```

Expected: FAIL because sort params are ignored.

- [ ] **Step 2: Implement shared sort helper**

Add `_apply_sort(statement, model, sort, allowed, default)` in `records.py`. It must reject unknown fields with `400`.

- [ ] **Step 3: Wire sort into lists**

Add `sort: str | None = None` to customer/product/asset list endpoints and apply allow-lists:

- customers: `code`, `name`, `created_at`, `updated_at`
- products: `code`, `name`, `category`, `created_at`, `updated_at`
- assets: `asset_number`, `lifecycle_status`, `next_retest_due_at`, `created_at`, `updated_at`

- [ ] **Step 4: Verify**

Run:

```bash
cd backend
uv run pytest tests/test_core_records_api.py -v
```

Expected: PASS.

Commit:

```bash
git add backend/src/hms_backend/app/api/records.py backend/tests/test_core_records_api.py
git commit -m "feat: add core record sorting"
```

### Task 4: Staff API Client Expansion

**Files:**
- Modify: `web/apps/staff/src/api/hmsClient.ts`
- Modify: `web/apps/staff/src/domain/types.ts`
- Create: `web/apps/staff/src/data/mockProducts.ts`
- Create: `web/apps/staff/src/data/mockReferenceData.ts`
- Create: `web/apps/staff/src/data/mockAssets.ts`
- Test: `web/apps/staff/src/__tests__/hmsClient.test.ts`

- [ ] **Step 1: Write failing frontend API tests**

Add tests that prove:

- products map from `/api/v1/products`.
- assets map from `/api/v1/assets`.
- reference standards map from `/api/v1/reference/standards`.
- archive calls use `DELETE`.
- ETag values are stored when available.
- mock fallback is used only when the backend request rejects or returns non-OK.

Run:

```bash
cd web/apps/staff
npm test -- --run src/__tests__/hmsClient.test.ts
```

Expected: FAIL because product/reference/asset client functions do not exist.

- [ ] **Step 2: Implement API mappings**

Add typed client functions:

- `listProducts`
- `listAssets`
- `listReferenceStandards`
- `archiveCustomer`
- `archiveProduct`
- `archiveAsset`
- `archiveReferenceStandard`

- [ ] **Step 3: Verify**

Run:

```bash
cd web/apps/staff
npm test -- --run src/__tests__/hmsClient.test.ts
```

Expected: PASS.

Commit:

```bash
git add web/apps/staff/src
git commit -m "feat: expand staff api client"
```

### Task 5: Staff Module Navigation And Data Workspaces

**Files:**
- Modify: `web/apps/staff/src/App.tsx`
- Modify: `web/apps/staff/src/components/AppShell.tsx`
- Create: `web/apps/staff/src/components/ModuleTable.tsx`
- Create: `web/apps/staff/src/components/ProductsWorkspace.tsx`
- Create: `web/apps/staff/src/components/AssetsWorkspace.tsx`
- Create: `web/apps/staff/src/components/ReferenceWorkspace.tsx`
- Create: `web/apps/staff/src/hooks/useProductsWorkspace.ts`
- Create: `web/apps/staff/src/hooks/useAssetsWorkspace.ts`
- Create: `web/apps/staff/src/hooks/useReferenceWorkspace.ts`
- Test: `web/apps/staff/src/__tests__/App.test.tsx`

- [ ] **Step 1: Write failing navigation tests**

Add tests that:

- clicking `Assets` shows the asset list.
- clicking `Products` or a reference-data nav item shows the relevant list.
- each module preserves the premium shell.
- each module shows backend-backed rows when fetch succeeds and mock rows when it fails.

Run:

```bash
cd web/apps/staff
npm test -- --run src/__tests__/App.test.tsx
```

Expected: FAIL because modules do not exist.

- [ ] **Step 2: Implement module navigation**

Convert sidebar buttons into module state. Add `Products` and `Reference Data` nav entries. Keep existing customer workspace intact.

- [ ] **Step 3: Implement list workspaces**

Build table-first workspaces for reference data, products, and assets using shared styling and `lucide-react` icons.

- [ ] **Step 4: Verify**

Run:

```bash
cd web/apps/staff
npm test -- --run src/__tests__/App.test.tsx
```

Expected: PASS.

Commit:

```bash
git add web/apps/staff/src
git commit -m "feat: add staff core record modules"
```

### Task 6: Editors For Reference, Products, Pressure Matrix, And Assets

**Files:**
- Create: `web/apps/staff/src/components/ReferenceForm.tsx`
- Create: `web/apps/staff/src/components/ProductForm.tsx`
- Create: `web/apps/staff/src/components/PressureMatrixEditor.tsx`
- Create: `web/apps/staff/src/components/AssetForm.tsx`
- Create: `web/apps/staff/src/components/AssetEndEditor.tsx`
- Modify: relevant workspace hooks/components.
- Test: `web/apps/staff/src/__tests__/App.test.tsx`

- [ ] **Step 1: Write failing editor tests**

Add tests that:

- reference standard drawer opens and saves a standard.
- product drawer opens and saves a product.
- pressure matrix editor adds/updates a rating row.
- asset drawer opens and saves an asset.
- asset A/B end editor updates controlled end configuration values.
- archive actions ask for confirmation and call soft-delete client functions.

Run:

```bash
cd web/apps/staff
npm test -- --run src/__tests__/App.test.tsx
```

Expected: FAIL because editors do not exist.

- [ ] **Step 2: Implement editor components**

Use compact drawers and controlled form fields. Do not add destructive language; use `Archive`/`Restore later` semantics for soft-delete actions.

- [ ] **Step 3: Wire API calls and mock fallback state**

Use backend client functions when available. When backend calls fail, keep local mock-state behavior for development demos.

- [ ] **Step 4: Verify**

Run:

```bash
cd web/apps/staff
npm test -- --run src/__tests__/App.test.tsx
npm run build
```

Expected: PASS.

Commit:

```bash
git add web/apps/staff/src
git commit -m "feat: add core record editors"
```

### Task 7: Server-Backed Local Verification

**Files:**
- Modify: `backend/README.md`
- Modify: `web/apps/staff/package.json` if a combined command is useful.

- [ ] **Step 1: Seed or document local backend data path**

Use existing synthetic data tooling or add a documented local seed path so the staff UI can show backend records without production data.

- [ ] **Step 2: Run backend and frontend together**

Run:

```bash
cd backend
uv run alembic upgrade head
uv run uvicorn hms_backend.app.main:app --reload
```

In another terminal:

```bash
cd web/apps/staff
npm run dev -- --host 127.0.0.1
```

- [ ] **Step 3: Browser verification**

Use the in-app browser to verify:

- Customers load from backend when backend is running.
- Assets/products/reference modules load.
- Create/update/archive actions hit the backend.
- Mock fallback appears only after backend is stopped.
- Desktop and mobile layouts have no horizontal overflow.

- [ ] **Step 4: Full verification**

Run:

```bash
cd backend
uv run ruff check . ../tooling
uv run mypy src tests ../tooling
uv run pytest
cd ../web/apps/staff
npm test -- --run
npm run build
```

Expected: all pass.

Commit:

```bash
git add backend web/apps/staff docs
git commit -m "docs: document server backed staff workflow"
```
