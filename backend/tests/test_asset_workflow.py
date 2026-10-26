"""The asset workflow model: every status, precedence between cycles, and who may act.

The resolver is a pure function of loaded records, so the decision table is tested on
unsaved ORM objects. The endpoint tests then cover what only the API can: tenant scope,
permissions and the shape of the contract.
"""

from __future__ import annotations

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from dataclasses import fields
from datetime import UTC, date, datetime, timedelta

import httpx
import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from hms_backend.app.api.dependencies import get_current_principal, get_session
from hms_backend.app.core.rbac import Principal, Role
from hms_backend.app.main import create_app
from hms_backend.app.models.base import Base
from hms_backend.app.modules.assets.models import Asset, AssetLifecycleStatus
from hms_backend.app.modules.assets.workflow import (
    ActionCode,
    AssetWorkflow,
    Capabilities,
    NextAction,
    TargetType,
    WorkflowStatus,
    resolve_asset_workflow,
)
from hms_backend.app.modules.certificates.models import Certificate, CertificateStatus
from hms_backend.app.modules.customers.models import Customer
from hms_backend.app.modules.inspections.models import (
    Inspection,
    InspectionAppointment,
    InspectionAppointmentChangeRequest,
    InspectionAppointmentStatus,
    InspectionBooking,
    InspectionBookingAsset,
    InspectionBookingStatus,
    InspectionChangeRequestStatus,
    InspectionStatus,
    InspectionType,
    PressureTestResult,
)
from hms_backend.app.modules.products.models import Product
from hms_backend.app.modules.scheduling.models import (
    RetestSchedule,
    RetestScheduleStatus,
)

T0 = datetime(2026, 6, 1, 9, 0, tzinfo=UTC)
ALL = Capabilities(
    edit_asset=True,
    book_inspection=True,
    review_scheduling=True,
    confirm_reschedule=True,
    write_inspection=True,
    approve=True,
)
NONE = Capabilities()


def asset(lifecycle: str = "IN_SERVICE", due: date | None = None) -> Asset:
    return Asset(id="asset-1", lifecycle_status=lifecycle, next_retest_due_at=due)


def schedule(status: str, due: date = date(2026, 9, 1)) -> RetestSchedule:
    return RetestSchedule(id="rs-1", status=status, due_at=due)


def inspection(
    id: str,
    status: str,
    *,
    booking_id: str | None = None,
    created: datetime = T0,
    submitted: datetime | None = None,
    approved: datetime | None = None,
    rejected: datetime | None = None,
    result: str | None = None,
    certificate_result: str | None = None,
) -> Inspection:
    item = Inspection(
        id=id,
        asset_id="asset-1",
        booking_id=booking_id,
        inspection_type=InspectionType.SERVICE.value,
        status=status,
        result=result,
        created_at=created,
        submitted_at=submitted,
        approved_at=approved,
        rejected_at=rejected,
    )
    if certificate_result is not None:
        item.pressure_test = PressureTestResult(
            measurements={"certificate_result": certificate_result}
        )
    return item


def approved(id: str, at: datetime = T0, **extra: object) -> Inspection:
    return inspection(
        id,
        InspectionStatus.APPROVED.value,
        created=at,
        submitted=at,
        approved=at,
        result="PASS",
        certificate_result="PASS",
        **extra,  # type: ignore[arg-type]
    )


def booking(
    id: str,
    status: str = InspectionBookingStatus.PENDING_APPROVAL.value,
    *,
    created: datetime = T0,
    appointment_status: str | None = None,
    changes: tuple[str, ...] = (),
) -> InspectionBooking:
    item = InspectionBooking(
        id=id,
        customer_id="customer-1",
        location_id="location-1",
        status=status,
        created_at=created,
        scheduled_at=created + timedelta(days=7),
    )
    if appointment_status is not None:
        item.appointment = InspectionAppointment(
            id=f"appt-{id}", booking_id=id, status=appointment_status
        )
    for index, change_status in enumerate(changes):
        item.change_requests.append(
            InspectionAppointmentChangeRequest(
                id=f"chg-{id}-{index}",
                booking_id=id,
                status=change_status,
                created_at=created + timedelta(hours=index + 1),
            )
        )
    return item


def certificate(
    id: str,
    inspection_id: str,
    *,
    status: str = CertificateStatus.ISSUED.value,
    issued: datetime = T0,
    version: int = 1,
) -> Certificate:
    return Certificate(
        id=id,
        inspection_id=inspection_id,
        asset_id="asset-1",
        number=f"CERT-{id}",
        certificate_version=version,
        status=status,
        issued_at=issued,
    )


def resolve(
    *,
    lifecycle: str = "IN_SERVICE",
    retest: str | None = None,
    bookings: list[InspectionBooking] | None = None,
    inspections: list[Inspection] | None = None,
    certificates: list[Certificate] | None = None,
    can: Capabilities = ALL,
) -> AssetWorkflow:
    return resolve_asset_workflow(
        asset(lifecycle),
        retest_schedule=schedule(retest) if retest else None,
        bookings=bookings or [],
        inspections=inspections or [],
        certificates=certificates or [],
        capabilities=can,
    )


PENDING = InspectionBookingStatus.PENDING_APPROVAL.value
APPROVED_BOOKING = InspectionBookingStatus.APPROVED.value
CONFIRMED = InspectionAppointmentStatus.CONFIRMED.value
ADMIN_TURN = InspectionChangeRequestStatus.PENDING_ADMIN_APPROVAL.value
CUSTOMER_TURN = InspectionChangeRequestStatus.PENDING_CUSTOMER_CONFIRMATION.value


# --- every status is reachable, and says what it should ---
MATRIX: list[tuple[WorkflowStatus, dict[str, object]]] = [
    (WorkflowStatus.ASSET_DRAFT, {"lifecycle": "DRAFT"}),
    (WorkflowStatus.CURRENT, {}),
    (WorkflowStatus.DUE, {"lifecycle": "DUE"}),
    (WorkflowStatus.OVERDUE, {"lifecycle": "OVERDUE"}),
    (WorkflowStatus.SUSPENDED, {"retest": RetestScheduleStatus.SUSPENDED.value}),
    (WorkflowStatus.SCHEDULE_REQUESTED, {"bookings": [booking("b1", PENDING)]}),
    (
        WorkflowStatus.SCHEDULE_REJECTED,
        {"bookings": [booking("b1", InspectionBookingStatus.REJECTED.value)]},
    ),
    (
        WorkflowStatus.SCHEDULED,
        {"bookings": [booking("b1", APPROVED_BOOKING, appointment_status=CONFIRMED)]},
    ),
    (
        WorkflowStatus.RESCHEDULE_REQUESTED,
        {
            "bookings": [
                booking(
                    "b1",
                    APPROVED_BOOKING,
                    appointment_status=CONFIRMED,
                    changes=(ADMIN_TURN,),
                )
            ]
        },
    ),
    (
        WorkflowStatus.RESCHEDULE_AWAITING_CONFIRMATION,
        {
            "bookings": [
                booking(
                    "b1",
                    APPROVED_BOOKING,
                    appointment_status=CONFIRMED,
                    changes=(CUSTOMER_TURN,),
                )
            ]
        },
    ),
    (
        WorkflowStatus.INSPECTION_DRAFT,
        {"inspections": [inspection("i1", InspectionStatus.DRAFT.value)]},
    ),
    (
        WorkflowStatus.AWAITING_REVIEW,
        {
            "inspections": [
                inspection("i1", InspectionStatus.SUBMITTED.value, submitted=T0)
            ]
        },
    ),
    (
        WorkflowStatus.CHANGES_REQUIRED,
        {
            "inspections": [
                inspection("i1", InspectionStatus.REJECTED.value, rejected=T0)
            ]
        },
    ),
    (
        WorkflowStatus.FAILED,
        {
            "inspections": [
                inspection(
                    "i1",
                    InspectionStatus.APPROVED.value,
                    approved=T0,
                    certificate_result="FAIL",
                )
            ]
        },
    ),
    (WorkflowStatus.READY_FOR_CERTIFICATE, {"inspections": [approved("i1")]}),
    (
        WorkflowStatus.CERTIFIED,
        {"inspections": [approved("i1")], "certificates": [certificate("c1", "i1")]},
    ),
    (
        WorkflowStatus.CANCELLED,
        {"bookings": [booking("b1", InspectionBookingStatus.CANCELLED.value)]},
    ),
    (
        WorkflowStatus.NO_SHOW,
        {
            "bookings": [
                booking(
                    "b1",
                    APPROVED_BOOKING,
                    appointment_status=InspectionAppointmentStatus.NO_SHOW.value,
                )
            ]
        },
    ),
    (WorkflowStatus.CONDEMNED, {"lifecycle": "CONDEMNED"}),
    (WorkflowStatus.RETIRED, {"lifecycle": "RETIRED"}),
]


def test_the_matrix_covers_every_canonical_status() -> None:
    assert {status for status, _ in MATRIX} == set(WorkflowStatus)
    assert len(WorkflowStatus) == 20  # IN_PROGRESS is deliberately not one of them


@pytest.mark.parametrize(("expected", "case"), MATRIX, ids=[m[0] for m in MATRIX])
def test_each_status_is_resolved_with_its_label_and_detail(
    expected: WorkflowStatus, case: dict[str, object]
) -> None:
    result = resolve(**case)  # type: ignore[arg-type]
    assert result.status == expected
    assert result.label and result.detail


def test_labels_are_the_agreed_wording() -> None:
    labels = {status: resolve(**case).label for status, case in MATRIX}  # type: ignore[arg-type]
    assert (
        labels[WorkflowStatus.AWAITING_REVIEW]
        == "Inspection submitted — awaiting approval"
    )
    assert labels[WorkflowStatus.ASSET_DRAFT] == "Asset setup incomplete"
    assert (
        labels[WorkflowStatus.RESCHEDULE_AWAITING_CONFIRMATION]
        == "Reschedule awaiting confirmation"
    )
    assert labels[WorkflowStatus.NO_SHOW] == "No show"


# --- precedence: the current cycle wins over history ---
def test_an_old_certificate_does_not_hide_a_newer_overdue_cycle() -> None:
    old = approved("i1", T0 - timedelta(days=400))
    result = resolve(
        lifecycle="OVERDUE",
        inspections=[old],
        certificates=[certificate("c1", "i1", issued=T0 - timedelta(days=399))],
    )
    assert result.status is WorkflowStatus.OVERDUE
    assert result.related.certificate_id is None


def test_an_old_certificate_does_not_hide_a_newer_pending_booking() -> None:
    old = approved("i1", T0 - timedelta(days=400))
    result = resolve(
        lifecycle="OVERDUE",
        inspections=[old],
        certificates=[certificate("c1", "i1", issued=T0 - timedelta(days=399))],
        bookings=[booking("b1", PENDING, created=T0)],
    )
    assert result.status is WorkflowStatus.SCHEDULE_REQUESTED
    assert result.related.booking_id == "b1"


def test_a_current_certificate_is_certified_while_nothing_is_due() -> None:
    result = resolve(
        inspections=[approved("i1")], certificates=[certificate("c1", "i1")]
    )
    assert result.status is WorkflowStatus.CERTIFIED
    assert result.context.certificate_number == "CERT-c1"
    assert result.related.certificate_id == "c1"


def test_a_pending_change_outranks_the_ordinary_scheduled_state() -> None:
    plain = booking("b1", APPROVED_BOOKING, appointment_status=CONFIRMED)
    asked = booking(
        "b1", APPROVED_BOOKING, appointment_status=CONFIRMED, changes=(ADMIN_TURN,)
    )
    assert resolve(bookings=[plain]).status is WorkflowStatus.SCHEDULED
    assert resolve(bookings=[asked]).status is WorkflowStatus.RESCHEDULE_REQUESTED


def test_customer_confirmation_is_a_different_state_from_admin_review() -> None:
    admin = booking(
        "b1", APPROVED_BOOKING, appointment_status=CONFIRMED, changes=(ADMIN_TURN,)
    )
    customer = booking(
        "b1", APPROVED_BOOKING, appointment_status=CONFIRMED, changes=(CUSTOMER_TURN,)
    )
    assert resolve(bookings=[admin]).status is WorkflowStatus.RESCHEDULE_REQUESTED
    assert (
        resolve(bookings=[customer]).status
        is WorkflowStatus.RESCHEDULE_AWAITING_CONFIRMATION
    )


def test_a_finished_change_request_no_longer_outranks_the_schedule() -> None:
    applied = booking(
        "b1",
        APPROVED_BOOKING,
        appointment_status=CONFIRMED,
        changes=(InspectionChangeRequestStatus.APPLIED.value,),
    )
    assert resolve(bookings=[applied]).status is WorkflowStatus.SCHEDULED


def test_the_inspection_of_a_booking_outranks_the_booking_that_scheduled_it() -> None:
    scheduled = booking(
        "b1", APPROVED_BOOKING, appointment_status=CONFIRMED, created=T0
    )
    started = inspection(
        "i1",
        InspectionStatus.DRAFT.value,
        booking_id="b1",
        created=T0 + timedelta(days=7),
    )
    assert (
        resolve(bookings=[scheduled], inspections=[started]).status
        is WorkflowStatus.INSPECTION_DRAFT
    )


def test_an_inspection_newer_than_the_latest_booking_is_the_current_cycle() -> None:
    old_booking = booking(
        "b1", APPROVED_BOOKING, appointment_status=CONFIRMED, created=T0
    )
    started = inspection(
        "i1", InspectionStatus.DRAFT.value, created=T0 + timedelta(days=30)
    )
    result = resolve(bookings=[old_booking], inspections=[started])
    assert result.status is WorkflowStatus.INSPECTION_DRAFT


def test_an_approved_failing_inspection_is_failed_not_ready_for_a_certificate() -> None:
    for kwargs in (
        {"certificate_result": "FAIL"},
        {"certificate_result": None, "result": "FAIL"},  # legacy: result column only
        {"certificate_result": None, "result": "FAILED"},
    ):
        failing = inspection(
            "i1",
            InspectionStatus.APPROVED.value,
            approved=T0,
            **kwargs,
        )
        assert resolve(inspections=[failing]).status is WorkflowStatus.FAILED
    passing_form_failing_legacy_result = approved("i2")
    assert (
        resolve(inspections=[passing_form_failing_legacy_result]).status
        is WorkflowStatus.READY_FOR_CERTIFICATE
    )


def test_a_revoked_or_superseded_certificate_does_not_certify() -> None:
    for state in (CertificateStatus.REVOKED.value, CertificateStatus.DRAFT.value):
        result = resolve(
            inspections=[approved("i1")],
            certificates=[certificate("c1", "i1", status=state)],
        )
        assert result.status is WorkflowStatus.READY_FOR_CERTIFICATE


def test_a_certificate_for_another_inspection_does_not_certify_this_one() -> None:
    result = resolve(
        inspections=[approved("i2", T0)],
        certificates=[certificate("c1", "i-other")],
    )
    assert result.status is WorkflowStatus.READY_FOR_CERTIFICATE


@pytest.mark.parametrize("terminal", ["CONDEMNED", "RETIRED"])
def test_terminal_asset_states_override_everything_else(terminal: str) -> None:
    result = resolve(
        lifecycle=terminal,
        retest="OVERDUE",
        bookings=[booking("b1", PENDING)],
        inspections=[inspection("i1", InspectionStatus.SUBMITTED.value, submitted=T0)],
    )
    assert result.status.value == terminal
    assert result.next_action is None
    assert result.related.inspection_id is None and result.related.booking_id is None


def test_a_draft_asset_is_incomplete_whatever_else_exists() -> None:
    result = resolve(lifecycle="DRAFT", bookings=[booking("b1", PENDING)])
    assert result.status is WorkflowStatus.ASSET_DRAFT
    assert result.next_action is not None
    assert result.next_action.code is ActionCode.EDIT_ASSET


def test_a_suspended_schedule_shows_as_suspended_when_nothing_is_in_flight() -> None:
    assert resolve(retest="SUSPENDED").status is WorkflowStatus.SUSPENDED
    assert (
        resolve(retest="SUSPENDED", lifecycle="OVERDUE").status
        is WorkflowStatus.SUSPENDED
    )


# --- determinism ---
def test_identical_timestamps_are_broken_by_id_whatever_the_order() -> None:
    a = inspection("i-a", InspectionStatus.DRAFT.value, created=T0)
    b = inspection("i-b", InspectionStatus.SUBMITTED.value, created=T0, submitted=T0)
    forward = resolve(inspections=[a, b])
    backward = resolve(inspections=[b, a])
    assert forward.status == backward.status is WorkflowStatus.AWAITING_REVIEW
    assert forward.related.inspection_id == backward.related.inspection_id == "i-b"


def test_equal_booking_times_pick_the_greater_id_whatever_the_order() -> None:
    low = booking("b-1", PENDING)
    high = booking("b-2", InspectionBookingStatus.REJECTED.value)
    assert resolve(bookings=[low, high]).related.booking_id == "b-2"
    assert resolve(bookings=[high, low]).related.booking_id == "b-2"


def test_naive_and_aware_timestamps_compare() -> None:
    naive = inspection(
        "i1", InspectionStatus.DRAFT.value, created=T0.replace(tzinfo=None)
    )
    newer_booking = booking("b1", PENDING, created=T0 + timedelta(hours=1))
    assert (
        resolve(inspections=[naive], bookings=[newer_booking]).status
        is WorkflowStatus.SCHEDULE_REQUESTED
    )


def test_deleted_records_are_ignored() -> None:
    gone = booking("b1", PENDING)
    gone.deleted_at = T0
    assert resolve(bookings=[gone]).status is WorkflowStatus.CURRENT


# --- next action: only what this principal may do, and only semantic targets ---
def action(case: dict[str, object], can: Capabilities = ALL) -> NextAction | None:
    return resolve(can=can, **case).next_action  # type: ignore[arg-type]


def test_each_status_offers_the_expected_navigational_action() -> None:
    expected: dict[WorkflowStatus, tuple[ActionCode, TargetType] | None] = {
        WorkflowStatus.ASSET_DRAFT: (ActionCode.EDIT_ASSET, TargetType.ASSET),
        WorkflowStatus.DUE: (ActionCode.BOOK_INSPECTION, TargetType.SCHEDULING),
        WorkflowStatus.OVERDUE: (ActionCode.BOOK_INSPECTION, TargetType.SCHEDULING),
        WorkflowStatus.NO_SHOW: (ActionCode.BOOK_INSPECTION, TargetType.SCHEDULING),
        WorkflowStatus.CANCELLED: (ActionCode.BOOK_INSPECTION, TargetType.SCHEDULING),
        WorkflowStatus.SCHEDULE_REJECTED: (
            ActionCode.BOOK_INSPECTION,
            TargetType.SCHEDULING,
        ),
        WorkflowStatus.SCHEDULE_REQUESTED: (
            ActionCode.REVIEW_SCHEDULE_REQUEST,
            TargetType.SCHEDULING,
        ),
        WorkflowStatus.RESCHEDULE_REQUESTED: (
            ActionCode.REVIEW_RESCHEDULE,
            TargetType.SCHEDULING,
        ),
        WorkflowStatus.RESCHEDULE_AWAITING_CONFIRMATION: (
            ActionCode.CONFIRM_RESCHEDULE,
            TargetType.SCHEDULING,
        ),
        WorkflowStatus.INSPECTION_DRAFT: (
            ActionCode.CONTINUE_INSPECTION,
            TargetType.INSPECTION,
        ),
        WorkflowStatus.AWAITING_REVIEW: (
            ActionCode.REVIEW_INSPECTION,
            TargetType.INSPECTION,
        ),
        WorkflowStatus.CHANGES_REQUIRED: (
            ActionCode.UPDATE_INSPECTION,
            TargetType.INSPECTION,
        ),
        WorkflowStatus.READY_FOR_CERTIFICATE: (
            ActionCode.ISSUE_CERTIFICATE,
            TargetType.CERTIFICATES,
        ),
    }
    for status, case in MATRIX:
        got = action(case)
        want = expected.get(status)
        if want is None:
            assert got is None, status
        else:
            assert got is not None, status
            assert (got.code, got.target_type) == want, status


def test_inspection_actions_point_at_the_exact_inspection() -> None:
    for status, case in MATRIX:
        if status in {
            WorkflowStatus.INSPECTION_DRAFT,
            WorkflowStatus.AWAITING_REVIEW,
            WorkflowStatus.CHANGES_REQUIRED,
        }:
            got = action(case)
            assert got is not None and got.target_id == "i1"


def test_the_certificate_action_carries_the_inspection_it_is_about() -> None:
    got = action({"inspections": [approved("i1")]})
    assert got is not None
    assert got.code is ActionCode.ISSUE_CERTIFICATE
    assert got.inspection_id == "i1"
    assert got.target_type is TargetType.CERTIFICATES


def test_scheduling_actions_carry_the_booking() -> None:
    got = action({"bookings": [booking("b9", PENDING)]})
    assert got is not None and got.target_id == "b9"


@pytest.mark.parametrize(
    ("status", "missing"),
    [
        (WorkflowStatus.ASSET_DRAFT, "edit_asset"),
        (WorkflowStatus.OVERDUE, "book_inspection"),
        (WorkflowStatus.SCHEDULE_REQUESTED, "review_scheduling"),
        (WorkflowStatus.RESCHEDULE_REQUESTED, "review_scheduling"),
        (WorkflowStatus.RESCHEDULE_AWAITING_CONFIRMATION, "confirm_reschedule"),
        (WorkflowStatus.INSPECTION_DRAFT, "write_inspection"),
        (WorkflowStatus.CHANGES_REQUIRED, "write_inspection"),
        (WorkflowStatus.AWAITING_REVIEW, "approve"),
        (WorkflowStatus.READY_FOR_CERTIFICATE, "approve"),
    ],
)
def test_the_action_is_left_out_without_its_capability(
    status: WorkflowStatus, missing: str
) -> None:
    case = dict(MATRIX)[status]
    every_other = {f.name: f.name != missing for f in fields(Capabilities)}
    without = resolve(can=Capabilities(**every_other), **case)  # type: ignore[arg-type]
    assert without.status is status  # the explanation stays
    assert without.next_action is None
    assert resolve(can=ALL, **case).next_action is not None  # type: ignore[arg-type]
    assert resolve(can=NONE, **case).next_action is None  # type: ignore[arg-type]


def test_an_action_never_carries_a_url_method_or_command() -> None:
    assert {f.name for f in fields(NextAction)} == {
        "code",
        "label",
        "target_type",
        "target_id",
        "inspection_id",
    }
    assert {t.value for t in TargetType} == {
        "ASSET",
        "SCHEDULING",
        "INSPECTION",
        "CERTIFICATES",
    }


def test_certified_and_terminal_states_offer_nothing() -> None:
    for status in (
        WorkflowStatus.CERTIFIED,
        WorkflowStatus.CURRENT,
        WorkflowStatus.CONDEMNED,
        WorkflowStatus.RETIRED,
        WorkflowStatus.SCHEDULED,
        WorkflowStatus.FAILED,
    ):
        assert action(dict(MATRIX)[status]) is None


def test_attention_marks_the_states_that_need_it() -> None:
    flagged = {status for status, case in MATRIX if resolve(**case).attention}  # type: ignore[arg-type]
    assert flagged == {
        WorkflowStatus.ASSET_DRAFT,
        WorkflowStatus.DUE,
        WorkflowStatus.OVERDUE,
        WorkflowStatus.SCHEDULE_REJECTED,
        WorkflowStatus.CHANGES_REQUIRED,
        WorkflowStatus.FAILED,
        WorkflowStatus.CANCELLED,
        WorkflowStatus.NO_SHOW,
    }


# --- the endpoint ---
@pytest_asyncio.fixture
async def session_factory() -> AsyncGenerator[async_sessionmaker[AsyncSession]]:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


@asynccontextmanager
async def api_client(
    session_factory: async_sessionmaker[AsyncSession], principal: Principal
) -> AsyncGenerator[httpx.AsyncClient]:
    app = create_app()

    async def override_session() -> AsyncGenerator[AsyncSession]:
        async with session_factory() as session:
            yield session

    async def override_principal() -> Principal:
        return principal

    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[get_current_principal] = override_principal
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        yield client


@pytest_asyncio.fixture
async def world(session_factory: async_sessionmaker[AsyncSession]) -> dict[str, str]:
    async with session_factory() as session:
        product = Product(category="Composite", code="P1", name="Hose")
        mine = Customer(code="MINE", name="Mine Ltd")
        theirs = Customer(code="THEM", name="Theirs Ltd")
        overdue = Asset(
            customer=mine,
            product=product,
            asset_number="A-OVERDUE",
            lifecycle_status=AssetLifecycleStatus.OVERDUE.value,
        )
        review = Asset(
            customer=mine,
            product=product,
            asset_number="A-REVIEW",
            lifecycle_status=AssetLifecycleStatus.IN_SERVICE.value,
        )
        other = Asset(
            customer=theirs,
            product=product,
            asset_number="A-OTHER",
            lifecycle_status=AssetLifecycleStatus.IN_SERVICE.value,
        )
        submitted = Inspection(
            asset=review,
            inspection_type=InspectionType.SERVICE.value,
            status=InspectionStatus.SUBMITTED.value,
            submitted_at=datetime.now(UTC),
        )
        foreign = Inspection(
            asset=other,
            inspection_type=InspectionType.SERVICE.value,
            status=InspectionStatus.SUBMITTED.value,
            submitted_at=datetime.now(UTC),
        )
        session.add_all([overdue, review, other, submitted, foreign])
        await session.commit()
        return {
            "mine": mine.id,
            "theirs": theirs.id,
            "overdue": overdue.id,
            "review": review.id,
            "other": other.id,
            "inspection": submitted.id,
            "foreign_inspection": foreign.id,
        }


def principal(role: Role, customers: frozenset[str] = frozenset()) -> Principal:
    return Principal(
        user_id=f"{role.value}-1", roles=frozenset({role}), customer_ids=customers
    )


@pytest.mark.asyncio
async def test_endpoint_returns_the_status_and_a_semantic_action(
    session_factory: async_sessionmaker[AsyncSession], world: dict[str, str]
) -> None:
    async with api_client(session_factory, principal(Role.HMS_ADMIN)) as client:
        response = await client.get(f"/api/v1/assets/{world['overdue']}/workflow")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "OVERDUE"
    assert body["label"] == "Inspection overdue"
    assert body["attention"] is True
    assert body["next_action"] == {
        "code": "BOOK_INSPECTION",
        "label": "Book inspection",
        "target_type": "SCHEDULING",
        "target_id": None,
        "inspection_id": None,
    }
    assert "url" not in str(body).lower() and "method" not in body["next_action"]


@pytest.mark.asyncio
async def test_endpoint_offers_the_review_only_to_someone_who_may_approve(
    session_factory: async_sessionmaker[AsyncSession], world: dict[str, str]
) -> None:
    path = f"/api/v1/assets/{world['review']}/workflow"
    async with api_client(session_factory, principal(Role.REVIEWER)) as client:
        reviewer = (await client.get(path)).json()
    async with api_client(session_factory, principal(Role.HMS_ADMIN)) as client:
        admin = (await client.get(path)).json()
    assert reviewer["status"] == admin["status"] == "AWAITING_REVIEW"
    assert reviewer["related"]["inspection_id"] == world["inspection"]
    assert reviewer["next_action"] == {
        "code": "REVIEW_INSPECTION",
        "label": "Review inspection",
        "target_type": "INSPECTION",
        "target_id": world["inspection"],
        "inspection_id": None,
    }
    assert admin["next_action"] is None  # can see it, may not act on it


@pytest.mark.asyncio
async def test_endpoint_never_leaks_another_customers_workflow(
    session_factory: async_sessionmaker[AsyncSession], world: dict[str, str]
) -> None:
    customer = principal(Role.CUSTOMER_USER, frozenset({world["mine"]}))
    async with api_client(session_factory, customer) as client:
        mine = await client.get(f"/api/v1/assets/{world['review']}/workflow")
        theirs = await client.get(f"/api/v1/assets/{world['other']}/workflow")
        missing = await client.get("/api/v1/assets/not-a-real-id/workflow")
    assert mine.status_code == 200
    assert theirs.status_code == missing.status_code == 404
    assert world["foreign_inspection"] not in theirs.text
    assert (
        theirs.json() == missing.json()
    )  # indistinguishable from a record that does not exist


@pytest.mark.asyncio
async def test_endpoint_answers_an_unassigned_inspector_with_not_found(
    session_factory: async_sessionmaker[AsyncSession], world: dict[str, str]
) -> None:
    async with api_client(session_factory, principal(Role.INSPECTOR)) as client:
        response = await client.get(f"/api/v1/assets/{world['review']}/workflow")
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_endpoint_narrows_an_inspector_to_their_own_booking(
    session_factory: async_sessionmaker[AsyncSession], world: dict[str, str]
) -> None:
    """Another inspector's booking and inspection on the asset are not theirs to see."""
    async with session_factory() as session:
        asset = await session.get(Asset, world["review"])
        assert asset is not None
        mine = InspectionBooking(
            customer_id=world["mine"],
            location_id="loc",
            status=InspectionBookingStatus.APPROVED.value,
            scheduled_at=datetime.now(UTC) + timedelta(days=3),
            requested_by_user_id="c",
            inspector_user_id="inspector-user-1",
        )
        mine.assets.append(InspectionBookingAsset(asset=asset))
        mine.appointment = InspectionAppointment(
            customer_id=world["mine"],
            location_id="loc",
            status=InspectionAppointmentStatus.CONFIRMED.value,
        )
        session.add(mine)
        await session.commit()
    inspector = Principal(
        user_id="inspector-1",
        roles=frozenset({Role.INSPECTOR}),
        customer_ids=frozenset(),
        record_user_id="inspector-user-1",
    )
    async with api_client(session_factory, inspector) as client:
        response = await client.get(f"/api/v1/assets/{world['review']}/workflow")
    assert response.status_code == 200
    body = response.json()
    # The submitted inspection is on no assigned booking, so it is not theirs to see.
    assert body["status"] == "SCHEDULED"
    assert body["related"]["inspection_id"] is None
    assert body["related"]["booking_id"] is not None
    assert world["inspection"] not in response.text
