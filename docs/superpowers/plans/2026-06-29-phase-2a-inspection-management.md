# Phase 2A Inspection Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the staff inspection workflow: list/dashboard, create from asset, draft pressure-test edits, detail view, submit, and approve using the current dev admin role.

**Architecture:** Extend the existing FastAPI `records.py` router with inspection list/detail/update contracts before expanding the React staff app. Reuse Phase 1 API-client/mock-fallback patterns and the existing premium shell/table/drawer styling. Keep certificates/PDFs, notification delivery, and mobile/offline capture out of scope.

**Tech Stack:** FastAPI, SQLAlchemy 2.0 async, Alembic models already present, pytest, React, Vite, TypeScript, Vitest, Testing Library, lucide-react.

---

## File Structure

- `backend/src/hms_backend/app/api/schemas.py`: add inspection summary/list/update schemas with asset/customer/product context.
- `backend/src/hms_backend/app/api/records.py`: add inspection statement helpers, list/detail endpoints, draft update endpoint, pressure-test upsert helper, and filters/sorting.
- `backend/tests/test_core_records_api.py`: add backend red-green tests for list/detail/filter/update/conflict behavior.
- `backend/src/hms_backend/app/tooling/local_seed.py`: seed a small set of local inspection records so server-backed UI verification has data.
- `backend/tests/test_local_seed.py`: extend idempotency test for seeded inspections and pressure tests.
- `web/apps/staff/src/domain/types.ts`: add inspection domain types and form values.
- `web/apps/staff/src/data/mockInspections.ts`: add inspection mock rows and helper data.
- `web/apps/staff/src/api/hmsClient.ts`: add inspection API mappings, fallback loader, create/update/submit/approve functions.
- `web/apps/staff/src/hooks/useInspectionsWorkspace.ts`: manage list data, filters, selection, drawer state, and mutation actions.
- `web/apps/staff/src/components/InspectionsWorkspace.tsx`: dashboard/list module.
- `web/apps/staff/src/components/InspectionForm.tsx`: create/edit drawer including pressure-test fields.
- `web/apps/staff/src/components/InspectionDetail.tsx`: detail drawer actions for draft submit and submitted approve.
- `web/apps/staff/src/App.tsx`: render the inspections module.
- `web/apps/staff/src/components/AppShell.tsx`: add `inspections` to `AppModule` and wire nav.
- `web/apps/staff/src/__tests__/hmsClient.test.ts`: add inspection client tests.
- `web/apps/staff/src/__tests__/App.test.tsx`: add inspection UI workflow tests.
- `web/apps/staff/src/styles.css`: add focused inspection dashboard/detail styles only where existing classes are insufficient.

---

### Task 1: Backend Inspection List And Detail Contracts

**Files:**
- Modify: `backend/tests/test_core_records_api.py`
- Modify: `backend/src/hms_backend/app/api/schemas.py`
- Modify: `backend/src/hms_backend/app/api/records.py`

- [ ] **Step 1: Write failing backend list/detail tests**

Add tests to `backend/tests/test_core_records_api.py` after the existing inspection create/transition tests:

```python
@pytest.mark.asyncio
async def test_inspections_endpoint_lists_with_asset_customer_product_context(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_session: dict[str, str],
) -> None:
    async with session_factory() as session:
        draft = Inspection(
            asset_id=seeded_session["vopak_asset_id"],
            inspection_type=InspectionType.SERVICE.value,
            status=InspectionStatus.DRAFT.value,
            result="PASS",
            inspector_user_id="inspector-1",
        )
        submitted = Inspection(
            asset_id=seeded_session["orica_asset_id"],
            inspection_type=InspectionType.NEW_ASSET.value,
            status=InspectionStatus.SUBMITTED.value,
            result="REVIEW",
            inspector_user_id="inspector-2",
        )
        session.add_all([draft, submitted])
        await session.commit()

    principal = Principal(
        user_id="admin-1",
        roles=frozenset({Role.HMS_ADMIN}),
        customer_ids=frozenset(),
    )

    async with api_client(session_factory, principal) as client:
        response = await client.get(
            "/api/v1/inspections",
            params={"sort": "created_at"},
        )

    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 2
    assert body["items"][0]["asset"]["asset_number"] == "997950"
    assert body["items"][0]["customer"]["code"] == "VOPA"
    assert body["items"][0]["product"]["code"] == "1000GY"
    assert body["items"][1]["asset"]["asset_number"] == "ORIC-100"
    assert body["items"][1]["status"] == InspectionStatus.SUBMITTED.value


@pytest.mark.asyncio
async def test_inspections_endpoint_filters_and_returns_detail(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_session: dict[str, str],
) -> None:
    async with session_factory() as session:
        inspection = Inspection(
            asset_id=seeded_session["vopak_asset_id"],
            inspection_type=InspectionType.SERVICE.value,
            status=InspectionStatus.SUBMITTED.value,
            result="PASS",
            inspector_user_id="inspector-1",
        )
        session.add(inspection)
        await session.flush()
        pressure_test = PressureTestResult(
            inspection=inspection,
            applied_pressure_kpa=1500,
            hold_time_seconds=300,
            passed=True,
            measurements={"leak": "none"},
        )
        session.add(pressure_test)
        await session.commit()
        inspection_id = inspection.id

    principal = Principal(
        user_id="admin-1",
        roles=frozenset({Role.HMS_ADMIN}),
        customer_ids=frozenset(),
    )

    async with api_client(session_factory, principal) as client:
        list_response = await client.get(
            "/api/v1/inspections",
            params={
                "status": "SUBMITTED",
                "inspection_type": "SERVICE",
                "customer_id": seeded_session["vopak_id"],
                "search": "997",
            },
        )
        detail_response = await client.get(f"/api/v1/inspections/{inspection_id}")

    assert list_response.status_code == 200
    assert list_response.json()["total"] == 1
    assert list_response.json()["items"][0]["id"] == inspection_id
    assert detail_response.status_code == 200
    detail = detail_response.json()
    assert detail["id"] == inspection_id
    assert detail["asset"]["asset_number"] == "997950"
    assert detail["pressure_test"]["applied_pressure_kpa"] == 1500
    assert detail["pressure_test"]["measurements"] == {"leak": "none"}
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd backend
uv run pytest tests/test_core_records_api.py::test_inspections_endpoint_lists_with_asset_customer_product_context tests/test_core_records_api.py::test_inspections_endpoint_filters_and_returns_detail -v
```

Expected: FAIL with `404 Not Found` because `GET /api/v1/inspections` and `GET /api/v1/inspections/{id}` do not exist.

- [ ] **Step 3: Add schemas**

In `backend/src/hms_backend/app/api/schemas.py`, add these classes near the existing inspection schemas:

```python
class InspectionAssetSummary(BaseModel):
    id: str
    asset_number: str
    tag: str | None
    lifecycle_status: str


class InspectionRead(BaseModel):
    id: str
    asset_id: str
    inspection_type: str
    status: str
    result: str | None
    inspector_user_id: str
    reviewer_user_id: str | None
    submitted_at: datetime | None
    approved_at: datetime | None
    rejected_at: datetime | None
    asset: InspectionAssetSummary
    customer: CustomerSummary
    product: ProductSummary
    pressure_test: PressureTestRead | None


class InspectionListResponse(BaseModel):
    total: int
    limit: int
    offset: int
    items: list[InspectionRead]
```

Replace the existing `InspectionRead` definition rather than creating a second class with the same name.

- [ ] **Step 4: Add query helpers and endpoints**

In `backend/src/hms_backend/app/api/records.py`:

1. Import `InspectionAssetSummary` and `InspectionListResponse`.
2. Add helper:

```python
def _inspection_statement() -> Select[tuple[Inspection]]:
    return (
        select(Inspection)
        .join(Inspection.asset)
        .join(Asset.customer)
        .options(
            selectinload(Inspection.asset).selectinload(Asset.customer),
            selectinload(Inspection.asset).selectinload(Asset.product),
            selectinload(Inspection.pressure_test),
            selectinload(Inspection.certificate),
        )
        .where(
            Inspection.deleted_at.is_(None),
            Asset.deleted_at.is_(None),
        )
    )
```

3. Replace `_get_inspection_or_404` to use `_inspection_statement()`.
4. Add endpoints before `create_inspection`:

```python
@router.get("/inspections", response_model=InspectionListResponse)
async def list_inspections(
    session: SessionDep,
    principal: PrincipalDep,
    status_filter: Annotated[str | None, Query(alias="status")] = None,
    inspection_type: str | None = None,
    asset_id: str | None = None,
    customer_id: str | None = None,
    search: str | None = None,
    sort: str | None = None,
    limit: LimitParam = 50,
    offset: OffsetParam = 0,
) -> InspectionListResponse:
    _require_asset_read(principal)
    statement = _inspection_statement()
    statement = _apply_asset_scope(statement, principal)
    if status_filter:
        statement = statement.where(Inspection.status == status_filter)
    if inspection_type:
        statement = statement.where(Inspection.inspection_type == inspection_type)
    if asset_id:
        statement = statement.where(Inspection.asset_id == asset_id)
    if customer_id:
        statement = statement.where(Asset.customer_id == customer_id)
    if search:
        search_pattern = f"%{search.lower()}%"
        statement = statement.where(
            or_(
                func.lower(Asset.asset_number).like(search_pattern),
                func.lower(Asset.tag).like(search_pattern),
                func.lower(Customer.code).like(search_pattern),
                func.lower(Customer.name).like(search_pattern),
                func.lower(Inspection.inspector_user_id).like(search_pattern),
                func.lower(Inspection.reviewer_user_id).like(search_pattern),
            )
        )

    total = await _count(session, statement)
    statement = _apply_sort(
        statement,
        Inspection,
        sort,
        frozenset(
            {
                "status",
                "inspection_type",
                "submitted_at",
                "approved_at",
                "created_at",
                "updated_at",
            }
        ),
        default="-created_at",
    )
    inspections = (
        await session.scalars(statement.offset(offset).limit(limit))
    ).all()
    return InspectionListResponse(
        total=total,
        limit=limit,
        offset=offset,
        items=[_inspection_read(inspection) for inspection in inspections],
    )


@router.get("/inspections/{inspection_id}", response_model=InspectionRead)
async def get_inspection(
    inspection_id: str,
    session: SessionDep,
    principal: PrincipalDep,
) -> InspectionRead:
    _require_asset_read(principal)
    inspection = await _get_inspection_or_404(session, inspection_id, principal)
    return _inspection_read(inspection)
```

5. Update `_inspection_read` to include `asset`, `customer`, and `product`.

- [ ] **Step 5: Verify**

Run:

```bash
cd backend
uv run pytest tests/test_core_records_api.py::test_inspections_endpoint_lists_with_asset_customer_product_context tests/test_core_records_api.py::test_inspections_endpoint_filters_and_returns_detail -v
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/hms_backend/app/api/schemas.py backend/src/hms_backend/app/api/records.py backend/tests/test_core_records_api.py
git commit -m "feat: add inspection list and detail endpoints"
```

### Task 2: Backend Draft Update And Pressure Test Upsert

**Files:**
- Modify: `backend/tests/test_core_records_api.py`
- Modify: `backend/src/hms_backend/app/api/schemas.py`
- Modify: `backend/src/hms_backend/app/api/records.py`

- [ ] **Step 1: Write failing draft update tests**

Add tests:

```python
@pytest.mark.asyncio
async def test_patch_draft_inspection_updates_result_and_pressure_test_with_audit(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_session: dict[str, str],
) -> None:
    async with session_factory() as session:
        inspection = Inspection(
            asset_id=seeded_session["vopak_asset_id"],
            inspection_type=InspectionType.SERVICE.value,
            status=InspectionStatus.DRAFT.value,
            result="REVIEW",
            inspector_user_id="inspector-1",
        )
        session.add(inspection)
        await session.commit()
        inspection_id = inspection.id

    principal = Principal(
        user_id="inspector-1",
        roles=frozenset({Role.INSPECTOR}),
        customer_ids=frozenset(),
    )

    async with api_client(session_factory, principal) as client:
        response = await client.patch(
            f"/api/v1/inspections/{inspection_id}",
            json={
                "result": "PASS",
                "pressure_test": {
                    "applied_pressure_kpa": 1750,
                    "hold_time_seconds": 360,
                    "passed": True,
                    "measurements": {"leak": "none", "visual": "ok"},
                },
            },
        )

    assert response.status_code == 200
    body = response.json()
    assert body["result"] == "PASS"
    assert body["pressure_test"]["applied_pressure_kpa"] == 1750
    assert body["pressure_test"]["measurements"]["visual"] == "ok"

    async with session_factory() as session:
        loaded = await session.get(Inspection, inspection_id)
        pressure_test = (
            await session.scalars(
                select(PressureTestResult).where(
                    PressureTestResult.inspection_id == inspection_id
                )
            )
        ).one()
        sync_changes = (
            await session.scalars(select(SyncChange).order_by(SyncChange.seq))
        ).all()
        audit_events = (
            await session.scalars(select(AuditEvent).order_by(AuditEvent.sequence))
        ).all()

        assert loaded is not None
        assert loaded.version == 2
        assert pressure_test.version == 1
        assert [change.entity for change in sync_changes] == [
            "Inspection",
            "PressureTestResult",
        ]
        assert [event.action for event in audit_events] == [
            "inspection.updated",
            "pressure_test_result.created",
        ]
        assert await verify_audit_chain(session)


@pytest.mark.asyncio
async def test_patch_inspection_rejects_non_draft_status(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_session: dict[str, str],
) -> None:
    async with session_factory() as session:
        inspection = Inspection(
            asset_id=seeded_session["vopak_asset_id"],
            inspection_type=InspectionType.SERVICE.value,
            status=InspectionStatus.SUBMITTED.value,
            result="PASS",
            inspector_user_id="inspector-1",
        )
        session.add(inspection)
        await session.commit()
        inspection_id = inspection.id

    principal = Principal(
        user_id="inspector-1",
        roles=frozenset({Role.INSPECTOR}),
        customer_ids=frozenset(),
    )

    async with api_client(session_factory, principal) as client:
        response = await client.patch(
            f"/api/v1/inspections/{inspection_id}",
            json={"result": "FAIL"},
        )

    assert response.status_code == 409
    assert response.json()["detail"] == "Only draft inspections can be edited"
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd backend
uv run pytest tests/test_core_records_api.py::test_patch_draft_inspection_updates_result_and_pressure_test_with_audit tests/test_core_records_api.py::test_patch_inspection_rejects_non_draft_status -v
```

Expected: FAIL with `405 Method Not Allowed` or `404 Not Found` because `PATCH /inspections/{id}` does not exist.

- [ ] **Step 3: Add update schema**

In `backend/src/hms_backend/app/api/schemas.py`, add:

```python
class InspectionUpdate(BaseModel):
    result: str | None = None
    pressure_test: PressureTestWrite | None = None
```

- [ ] **Step 4: Implement pressure-test upsert and PATCH endpoint**

In `records.py`:

1. Import `InspectionUpdate`.
2. Add helper:

```python
async def _upsert_pressure_test(
    session: AsyncSession,
    payload: PressureTestWrite,
    *,
    inspection: Inspection,
    actor_id: str,
) -> None:
    pressure_test = inspection.pressure_test
    if pressure_test is None:
        pressure_test = PressureTestResult(
            inspection=inspection,
            applied_pressure_kpa=payload.applied_pressure_kpa,
            hold_time_seconds=payload.hold_time_seconds,
            passed=payload.passed,
            measurements=payload.measurements,
        )
        session.add(pressure_test)
        await record_create(
            session,
            pressure_test,
            actor_id=actor_id,
            action="pressure_test_result.created",
        )
        return

    before = pressure_test.to_audit_dict()
    pressure_test.applied_pressure_kpa = payload.applied_pressure_kpa
    pressure_test.hold_time_seconds = payload.hold_time_seconds
    pressure_test.passed = payload.passed
    pressure_test.measurements = payload.measurements
    await record_update(
        session,
        pressure_test,
        actor_id=actor_id,
        action="pressure_test_result.updated",
        before=before,
    )
```

3. Add endpoint before submit:

```python
@router.patch("/inspections/{inspection_id}", response_model=InspectionRead)
async def update_inspection(
    inspection_id: str,
    payload: InspectionUpdate,
    session: SessionDep,
    principal: PrincipalDep,
) -> InspectionRead:
    _require_inspection_write(principal)
    inspection = await _get_inspection_or_404(session, inspection_id, principal)
    if inspection.status != InspectionStatus.DRAFT.value:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Only draft inspections can be edited",
        )

    updates = payload.model_dump(exclude_unset=True)
    if "result" in updates:
        before = inspection.to_audit_dict()
        inspection.result = _clean_optional(payload.result)
        await record_update(
            session,
            inspection,
            actor_id=principal.user_id,
            action="inspection.updated",
            before=before,
        )
    if payload.pressure_test is not None:
        await _upsert_pressure_test(
            session,
            payload.pressure_test,
            inspection=inspection,
            actor_id=principal.user_id,
        )

    await session.commit()
    loaded = await _get_inspection_or_404(session, inspection.id, principal)
    return _inspection_read(loaded)
```

- [ ] **Step 5: Verify**

```bash
cd backend
uv run pytest tests/test_core_records_api.py::test_patch_draft_inspection_updates_result_and_pressure_test_with_audit tests/test_core_records_api.py::test_patch_inspection_rejects_non_draft_status -v
uv run pytest tests/test_core_records_api.py -v
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/hms_backend/app/api/schemas.py backend/src/hms_backend/app/api/records.py backend/tests/test_core_records_api.py
git commit -m "feat: add draft inspection updates"
```

### Task 3: Local Seed Data For Inspection Verification

**Files:**
- Modify: `backend/src/hms_backend/app/tooling/local_seed.py`
- Modify: `backend/tests/test_local_seed.py`
- Modify: `backend/README.md`

- [ ] **Step 1: Write failing seed test**

Extend `backend/tests/test_local_seed.py`:

```python
from hms_backend.app.modules.inspections.models import Inspection, PressureTestResult
```

Add count assertions:

```python
        assert first_summary["inspections"] == 3
        assert first_summary["pressure_test_results"] == 2
        assert await _count(session, Inspection) == 3
        assert await _count(session, PressureTestResult) == 2
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend
uv run pytest tests/test_local_seed.py -v
```

Expected: FAIL with `KeyError: 'inspections'` or count mismatch.

- [ ] **Step 3: Implement idempotent seeded inspections**

In `backend/src/hms_backend/app/tooling/local_seed.py`:

1. Import `Inspection`, `InspectionStatus`, `InspectionType`, and `PressureTestResult`.
2. After `_seed_retest_schedules(...)`, call:

```python
    await _seed_inspections(session, assets_by_number)
```

3. Include counts in both summaries:

```python
"inspections": await _count(session, Inspection),
"pressure_test_results": await _count(session, PressureTestResult),
```

4. Add helper:

```python
async def _seed_inspections(
    session: AsyncSession,
    assets_by_number: dict[str, Asset],
) -> None:
    rows = [
        {
            "asset_number": "997950",
            "inspection_type": InspectionType.SERVICE.value,
            "status": InspectionStatus.DRAFT.value,
            "result": "REVIEW",
            "inspector_user_id": "inspector-1",
            "pressure_test": {
                "applied_pressure_kpa": 1500,
                "hold_time_seconds": 300,
                "passed": True,
                "measurements": {"leak": "none"},
            },
        },
        {
            "asset_number": "980636",
            "inspection_type": InspectionType.SERVICE.value,
            "status": InspectionStatus.SUBMITTED.value,
            "result": "PASS",
            "inspector_user_id": "inspector-2",
            "pressure_test": {
                "applied_pressure_kpa": 1200,
                "hold_time_seconds": 240,
                "passed": True,
                "measurements": {"visual": "ok"},
            },
        },
        {
            "asset_number": "997950",
            "inspection_type": InspectionType.NEW_ASSET.value,
            "status": InspectionStatus.APPROVED.value,
            "result": "PASS",
            "inspector_user_id": "inspector-1",
            "reviewer_user_id": "staff-ui-dev",
            "pressure_test": None,
        },
    ]
    for index, row in enumerate(rows, start=1):
        asset = assets_by_number[row["asset_number"]]
        inspection = await _scalar_one_or_none(
            session,
            select(Inspection).where(
                Inspection.asset_id == asset.id,
                Inspection.inspection_type == row["inspection_type"],
                Inspection.status == row["status"],
                Inspection.inspector_user_id == row["inspector_user_id"],
            ),
        )
        if inspection is None:
            inspection = Inspection(
                asset=asset,
                inspection_type=row["inspection_type"],
                status=row["status"],
                result=row["result"],
                inspector_user_id=row["inspector_user_id"],
                reviewer_user_id=row.get("reviewer_user_id"),
                legacy_system="synthetic",
                legacy_table="inspections",
                legacy_id=f"inspection-{index}",
            )
            session.add(inspection)
            await record_create(
                session,
                inspection,
                actor_id=SEED_ACTOR_ID,
                action="inspection.seeded",
            )
        pressure_payload = row["pressure_test"]
        if pressure_payload is not None and inspection.pressure_test is None:
            pressure_test = PressureTestResult(
                inspection=inspection,
                **pressure_payload,
            )
            session.add(pressure_test)
            await record_create(
                session,
                pressure_test,
                actor_id=SEED_ACTOR_ID,
                action="pressure_test_result.seeded",
            )
```

- [ ] **Step 4: Update README seed summary note**

In `backend/README.md`, add one sentence after the seed command note:

```markdown
The seed includes customers, assets, products, retest schedules, inspections, and pressure-test examples for local UI verification.
```

- [ ] **Step 5: Verify**

```bash
cd backend
uv run pytest tests/test_local_seed.py -v
uv run pytest tests/test_core_records_api.py -v
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/hms_backend/app/tooling/local_seed.py backend/tests/test_local_seed.py backend/README.md
git commit -m "feat: seed local inspection demo data"
```

### Task 4: Staff Inspection API Client And Mock Data

**Files:**
- Modify: `web/apps/staff/src/domain/types.ts`
- Create: `web/apps/staff/src/data/mockInspections.ts`
- Modify: `web/apps/staff/src/api/hmsClient.ts`
- Modify: `web/apps/staff/src/__tests__/hmsClient.test.ts`

- [ ] **Step 1: Write failing API client tests**

In `web/apps/staff/src/__tests__/hmsClient.test.ts`, add tests that assert:

```ts
it("maps inspection list rows from the backend", async () => {
  const fetcher = vi.fn().mockResolvedValue(
    okJson({
      total: 1,
      limit: 50,
      offset: 0,
      items: [
        {
          id: "inspection-api-1",
          asset_id: "asset-api-1",
          inspection_type: "SERVICE",
          status: "DRAFT",
          result: "REVIEW",
          inspector_user_id: "inspector-1",
          reviewer_user_id: null,
          submitted_at: null,
          approved_at: null,
          rejected_at: null,
          asset: {
            id: "asset-api-1",
            asset_number: "997950",
            tag: "HMS-997950",
            lifecycle_status: "OVERDUE"
          },
          customer: { id: "customer-api-1", code: "VOPA", name: "Vopak" },
          product: {
            id: "product-api-1",
            code: "1000GY",
            name: "FUELFLEX GREEN",
            category: "Composite"
          },
          pressure_test: {
            id: "pressure-api-1",
            applied_pressure_kpa: 1500,
            hold_time_seconds: 300,
            passed: true,
            measurements: { leak: "none" }
          }
        }
      ]
    })
  );

  const client = createHmsClient({ fetcher });
  const response = await client.listInspections({ status: "DRAFT" });

  expect(fetcher).toHaveBeenCalledWith(
    "/api/v1/inspections?limit=50&offset=0&status=DRAFT&sort=-created_at",
    expect.any(Object)
  );
  expect(response.items[0].asset.assetNumber).toBe("997950");
  expect(response.items[0].pressureTest?.appliedPressureKpa).toBe(1500);
});
```

Add a second test for `createInspection`, `updateInspection`, `submitInspection`, and `approveInspection` using expected URLs and HTTP methods.

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd web/apps/staff
npm test -- --run src/__tests__/hmsClient.test.ts
```

Expected: FAIL because inspection client functions and types do not exist.

- [ ] **Step 3: Add domain types**

In `domain/types.ts`, add:

```ts
export type InspectionStatus = "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED";
export type InspectionTypeCode = "NEW_ASSET" | "SERVICE";

export interface PressureTestRecord {
  id: string;
  appliedPressureKpa: number;
  holdTimeSeconds: number;
  passed: boolean;
  measurements: Record<string, unknown> | null;
}

export interface InspectionAssetSummary {
  id: string;
  assetNumber: string;
  tag: string | null;
  lifecycleStatus: string;
}

export interface InspectionRecord {
  id: string;
  assetId: string;
  inspectionType: InspectionTypeCode;
  status: InspectionStatus;
  result: string | null;
  inspectorUserId: string;
  reviewerUserId: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  asset: InspectionAssetSummary;
  customer: RecordSummary;
  product: AssetProductSummary;
  pressureTest: PressureTestRecord | null;
  etag?: string | null;
}

export interface InspectionListResult {
  source: DataSource;
  total: number;
  etag?: string | null;
  items: InspectionRecord[];
}

export interface PressureTestFormValues {
  appliedPressureKpa: number;
  holdTimeSeconds: number;
  passed: boolean;
  measurements: Record<string, unknown> | null;
}

export interface InspectionFormValues {
  assetId: string;
  inspectionType: InspectionTypeCode;
  result: string | null;
  pressureTest: PressureTestFormValues | null;
}

export interface InspectionUpdateValues {
  result: string | null;
  pressureTest: PressureTestFormValues | null;
}
```

- [ ] **Step 4: Add mock data**

Create `web/apps/staff/src/data/mockInspections.ts` with three records: one draft, one submitted, one approved, using existing mock asset/customer/product values.

- [ ] **Step 5: Implement client mappings and fallback**

In `hmsClient.ts`:

1. Import mock inspections and new types.
2. Add API interfaces mirroring backend response.
3. Add `toInspection`.
4. Add client methods:
   - `listInspections(options)`
   - `createInspection(values)`
   - `updateInspection(id, values)`
   - `submitInspection(id)`
   - `approveInspection(id)`
5. Add `filterMockInspections`.
6. Add `loadInspectionsWithFallback`.

- [ ] **Step 6: Verify**

```bash
cd web/apps/staff
npm test -- --run src/__tests__/hmsClient.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add web/apps/staff/src/domain/types.ts web/apps/staff/src/data/mockInspections.ts web/apps/staff/src/api/hmsClient.ts web/apps/staff/src/__tests__/hmsClient.test.ts
git commit -m "feat: add staff inspection api client"
```

### Task 5: Staff Inspection Module UI

**Files:**
- Modify: `web/apps/staff/src/App.tsx`
- Modify: `web/apps/staff/src/components/AppShell.tsx`
- Create: `web/apps/staff/src/hooks/useInspectionsWorkspace.ts`
- Create: `web/apps/staff/src/components/InspectionsWorkspace.tsx`
- Create: `web/apps/staff/src/components/InspectionForm.tsx`
- Create: `web/apps/staff/src/components/InspectionDetail.tsx`
- Modify: `web/apps/staff/src/styles.css`
- Modify: `web/apps/staff/src/__tests__/App.test.tsx`

- [ ] **Step 1: Write failing UI tests**

In `App.test.tsx`, add tests that:

- Click `Inspections` and expect an inspection dashboard row.
- With mocked API responses, expect backend-backed inspection rows.
- Click `Add Inspection`, fill asset/type/result/pressure fields, save, and see a draft row.
- Open a draft inspection detail, edit pressure test, submit, and see submitted state.
- Open a submitted inspection detail, approve, and see approved state.

Use explicit accessible names:

```ts
await user.click(screen.getByRole("button", { name: "Inspections" }));
expect(await screen.findByRole("heading", { name: "Inspection Management" })).toBeVisible();
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd web/apps/staff
npm test -- --run src/__tests__/App.test.tsx
```

Expected: FAIL because the Inspections nav is not wired to a module.

- [ ] **Step 3: Wire module navigation**

In `AppShell.tsx`, change:

```ts
export type AppModule = "customers" | "assets" | "products" | "reference";
```

to:

```ts
export type AppModule =
  | "customers"
  | "assets"
  | "products"
  | "reference"
  | "inspections";
```

Set the Inspections nav item to `module: "inspections"`.

In `App.tsx`, add module copy and render `InspectionsWorkspace`.

- [ ] **Step 4: Implement hook**

Create `useInspectionsWorkspace.ts` with:

- `inspections`
- `visibleInspections`
- `source`
- `query`
- `statusFilter`
- `selectedInspection`
- `isFormOpen`
- `openCreate`
- `openDetail`
- `saveInspection`
- `saveInspectionUpdate`
- `submitInspection`
- `approveInspection`

Use `loadInspectionsWithFallback`, `loadAssetsWithFallback`, and `createHmsClient`.

- [ ] **Step 5: Implement UI components**

`InspectionsWorkspace.tsx` renders:

- `<h2>Inspection Management</h2>`
- four metric cells for Draft, Submitted, Approved, Attention
- status filter tabs/buttons
- `ModuleTable` rows for status, asset, customer, type, result, pressure, action
- `InspectionForm`
- `InspectionDetail`

`InspectionForm.tsx` renders controlled fields:

- Asset select
- Inspection type select
- Result select/input
- Applied pressure kPa
- Hold time seconds
- Passed checkbox/select
- Measurements note input

`InspectionDetail.tsx` renders:

- Asset/customer/product summary
- Status and timestamps
- Editable pressure test fields when `DRAFT`
- `Save draft`, `Submit inspection`, and `Approve inspection` actions based on status

- [ ] **Step 6: Verify**

```bash
cd web/apps/staff
npm test -- --run src/__tests__/App.test.tsx
npm test -- --run
npm run build
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add web/apps/staff/src
git commit -m "feat: add staff inspection workspace"
```

### Task 6: Server-Backed Browser Verification And Final Checks

**Files:**
- Modify only if verification exposes a defect in previous tasks.

- [ ] **Step 1: Run full backend verification**

```bash
cd backend
uv run ruff check . ../tooling
uv run mypy src tests ../tooling
uv run pytest
```

Expected: PASS.

- [ ] **Step 2: Run full frontend verification**

```bash
cd web/apps/staff
npm test -- --run
npm run build
```

Expected: PASS.

- [ ] **Step 3: Prepare local server-backed data**

```bash
cd backend
rm -f /tmp/hms_phase2a_verify.db
DATABASE_URL=sqlite+aiosqlite:////tmp/hms_phase2a_verify.db uv run alembic upgrade head
DATABASE_URL=sqlite+aiosqlite:////tmp/hms_phase2a_verify.db uv run python -m hms_backend.app.tooling.local_seed
DATABASE_URL=sqlite+aiosqlite:////tmp/hms_phase2a_verify.db uv run uvicorn hms_backend.app.main:app --host 127.0.0.1 --port 8000
```

In another terminal:

```bash
cd web/apps/staff
npm run dev -- --host 127.0.0.1
```

- [ ] **Step 4: Browser QA**

Use the in-app browser at `http://127.0.0.1:5173/` to verify:

- Inspections nav opens the dashboard.
- Seeded backend inspections render.
- Create inspection from asset sends `POST /api/v1/assets/{asset_id}/inspections`.
- Draft pressure edit sends `PATCH /api/v1/inspections/{id}`.
- Submit sends `POST /api/v1/inspections/{id}/submit`.
- Approve sends `POST /api/v1/inspections/{id}/approve`.
- Stop backend and reload: mock fallback renders.
- Desktop and mobile viewports have no horizontal overflow.

- [ ] **Step 5: Commit verification fixes if any**

If browser QA required code changes:

```bash
git status --short
git add backend/src/hms_backend/app/api/records.py backend/src/hms_backend/app/api/schemas.py backend/tests/test_core_records_api.py backend/src/hms_backend/app/tooling/local_seed.py backend/tests/test_local_seed.py web/apps/staff/src
git commit -m "fix: stabilize inspection workflow verification"
```

If no code changes were needed, do not create an empty commit.
