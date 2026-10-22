"""The product pressure rating that applies to an asset."""

from __future__ import annotations

from hms_backend.app.modules.assets.models import Asset


def rated_pressures(asset: Asset) -> tuple[str, int, int] | None:
    """``(nominal_bore_id, working_kpa, test_kpa)`` for the hose's bore, or None.

    The nominal bore is recorded on the asset's ends, not on the asset, and both ends
    of a hose share one bore, so end A is used and end B only if A has none. None means
    the product has no rating for that bore (or the asset has no bore), in which case a
    caller must ask for the pressures rather than assume defaults.
    """
    bore_id = next(
        (
            end.nominal_bore_id
            for end in sorted(asset.ends, key=lambda configuration: configuration.end)
            if end.deleted_at is None and end.nominal_bore_id is not None
        ),
        None,
    )
    if bore_id is None:
        return None
    for rating in asset.product.pressure_ratings:
        if rating.nominal_bore_id == bore_id and rating.deleted_at is None:
            return bore_id, rating.working_pressure_kpa, rating.test_pressure_kpa
    return None
