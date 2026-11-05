import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { createHmsClient } from "../api/hmsClient";
import { useRemoteOptions } from "../hooks/useRemoteOptions";
import type {
  AssetRecord,
  AdminUserRecord,
  CustomerLocation,
  InspectionAvailabilitySlot,
  InspectionBookingCreateValues,
  InspectionBookingRecord
} from "../domain/types";
import { assetLabel } from "../utils/identity";
import { FormSection } from "./forms/FormLayout";
import { FormShell } from "./forms/FormShell";
import { useDirtyTracker } from "./forms/useDirtyTracker";
import { useFormSeed } from "./forms/useFormSeed";
import { useFormSubmit } from "./forms/useFormSubmit";
import { Combobox } from "./interaction/Combobox";
import { Field, RequiredMark } from "./interaction/FormPrimitives";
import { Select } from "./interaction/Select";

const ERROR_OPTIONS = { conflictNeedsRefresh: true };

const ASSET_PAGE_SIZE = 25;

interface InspectionBookingFormProps {
  open: boolean;
  rescheduleBooking?: InspectionBookingRecord | null;
  inspectors?: Array<Pick<AdminUserRecord, "id" | "displayName">>;
  requiresInspector?: boolean;
  /** A date (YYYY-MM-DD) to offer first, e.g. the day being viewed in the calendar. */
  initialDate?: string;
  onClose: () => void;
  onSubmit: (values: InspectionBookingCreateValues) => Promise<void>;
  onReschedule?: (
    bookingId: string,
    values: {
      availabilityQuoteId: string;
      reason: string | null;
      inspectorUserId: string | null;
    }
  ) => Promise<void>;
}

export function InspectionBookingForm({
  open,
  rescheduleBooking = null,
  inspectors = [],
  requiresInspector = false,
  initialDate = "",
  onClose,
  onSubmit,
  onReschedule
}: InspectionBookingFormProps) {
  const [customerId, setCustomerId] = useState("");
  const [chosenCustomer, setChosenCustomer] = useState<{ value: string; label: string; description?: string } | null>(null);
  const [customerLocations, setCustomerLocations] = useState<CustomerLocation[]>([]);
  // Customers are searched on the server, so one past the first page can still be booked for.
  const customerSearch = useRemoteOptions(
    (text) => createHmsClient().listCustomers({ search: text, sort: "name", limit: 25 }).then((result) => result.items),
    open && !rescheduleBooking
  );
  const locations = useMemo(() => {
    if (rescheduleBooking) {
      return [{
        id: rescheduleBooking.location.id,
        label: `${rescheduleBooking.customer.name} - ${rescheduleBooking.location.name}`,
        timezone: rescheduleBooking.location.schedulingTimezone ?? "UTC"
      }];
    }
    return customerLocations
      .map((location) => ({ id: location.id, label: location.name, timezone: location.schedulingTimezone ?? "UTC" }))
      .sort((left, right) => left.label.localeCompare(right.label));
  }, [customerLocations, rescheduleBooking]);
  const [locationId, setLocationId] = useState("");
  const [assetIds, setAssetIds] = useState<string[]>([]);
  // What was ticked, kept apart from the page on screen so a search or a later page never loses a choice.
  const [pickedAssets, setPickedAssets] = useState<Record<string, AssetRecord>>({});
  const [assetQuery, setAssetQuery] = useState("");
  const [assetPage, setAssetPage] = useState<{ items: AssetRecord[]; total: number; loading: boolean; error: string | null }>({ items: [], total: 0, loading: false, error: null });
  const [selectAllLoading, setSelectAllLoading] = useState(false);
  const [bookingDate, setBookingDate] = useState("");
  // Availability is stored with the location and date it was requested for, and only
  // trusted while both still match, so a quote can never outlive the choices it priced.
  const [availability, setAvailability] = useState<{
    key: string;
    slots: InspectionAvailabilitySlot[];
  }>({ key: "", slots: [] });
  const [chosenQuoteId, setChosenQuoteId] = useState("");
  const [inspectorUserId, setInspectorUserId] = useState("");
  const [isLoadingAvailability, setLoadingAvailability] = useState(false);
  const [availabilityError, setAvailabilityError] = useState<string | null>(null);
  const [additionalInformation, setAdditionalInformation] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  const bookingCustomerId = rescheduleBooking?.customer.id ?? customerId;
  // A reschedule shows the booking's own assets, which need not be on any page.
  const assetChoices = rescheduleBooking
    ? rescheduleBooking.assets.map((asset) => ({ id: asset.id, assetNumber: asset.assetNumber, assetName: asset.assetName ?? null }))
    : assetPage.items;
  const schedulingTimezone = locations.find((location) => location.id === locationId)?.timezone ?? "UTC";
  const availabilityKey = locationId && bookingDate ? `${locationId}|${bookingDate}` : "";
  const availableSlots = availability.key === availabilityKey ? availability.slots : [];
  const availabilityQuoteId = availableSlots.some((slot) => slot.quoteId === chosenQuoteId)
    ? chosenQuoteId
    : "";

  // Reset only when the form opens or its subject changes. Depending on the option
  // lists would wipe the user's choices whenever the workspace refreshes them.
  const rescheduleKey = rescheduleBooking?.id ?? null;
  const { dirty, markClean, touch } = useDirtyTracker(
    JSON.stringify([locationId, assetIds, bookingDate, availabilityQuoteId, inspectorUserId, additionalInformation])
  );
  const seed = useFormSeed({
    dirty,
    sourceKey: open ? (rescheduleKey ?? "new") : null,
    sourceSignature: "",
    seed: () => {
      // A new booking starts blank: the user must choose the location and the assets.
      // A reschedule keeps the booking's own location and assets.
      setCustomerId("");
      setChosenCustomer(null);
      setCustomerLocations([]);
      setLocationId(rescheduleBooking ? rescheduleBooking.location.id : "");
      setAssetIds(rescheduleBooking ? rescheduleBooking.assets.map((asset) => asset.id) : []);
      setPickedAssets({});
      setAssetQuery("");
      setAssetPage({ items: [], total: 0, loading: false, error: null });
      setBookingDate(rescheduleBooking ? "" : initialDate);
      setAvailability({ key: "", slots: [] });
      setChosenQuoteId("");
      setInspectorUserId("");
      setLoadingAvailability(false);
      setAvailabilityError(null);
      setAdditionalInformation("");
      submission.reset();
      markClean();
    }
  });
  const submission = useFormSubmit({
    errorOptions: ERROR_OPTIONS,
    fallback: rescheduleBooking ? "The reschedule could not be requested. Try again." : "The booking could not be created. Try again.",
    formRef,
    isCurrent: seed.isCurrent,
    order: [],
    session: seed.current
  });

  useEffect(() => {
    if (!open || !bookingDate || !bookingCustomerId || !locationId) return;
    const requestKey = `${locationId}|${bookingDate}`;
    let active = true;
    setLoadingAvailability(true);
    setAvailabilityError(null);
    setChosenQuoteId("");
    void createHmsClient()
      .listInspectionAvailability({
        customerId: bookingCustomerId,
        locationId,
        localDate: bookingDate,
        durationMinutes: 60
      })
      .then((slots) => {
        if (active) setAvailability({ key: requestKey, slots });
      })
      .catch((reason: unknown) => {
        if (active) {
          setAvailabilityError(
            reason instanceof Error
              ? reason.message
              : "Availability could not be loaded."
          );
        }
      })
      .finally(() => {
        if (active) setLoadingAvailability(false);
      });
    return () => {
      active = false;
    };
  }, [bookingDate, bookingCustomerId, locationId, open]);

  // The chosen customer's locations, read from that customer and never guessed.
  useEffect(() => {
    if (!open || rescheduleBooking || !customerId) { setCustomerLocations([]); return; }
    let active = true;
    createHmsClient().getCustomer(customerId)
      .then((customer) => { if (active) setCustomerLocations((customer.locations ?? []).filter((location): location is CustomerLocation => Boolean(location))); })
      .catch(() => { if (active) setCustomerLocations([]); });
    return () => { active = false; };
  }, [open, rescheduleBooking, customerId]);

  // The assets at the chosen location are searched and paged on the server. Only assets that can take new
  // work are offered: an archived customer's are not.
  function fetchAssets(offset: number) {
    return createHmsClient().listAssets({
      customerId, locationId, search: assetQuery, newWorkOnly: true, sort: "asset_number", limit: ASSET_PAGE_SIZE, offset
    });
  }
  useEffect(() => {
    if (!open || rescheduleBooking || !customerId || !locationId) { setAssetPage({ items: [], total: 0, loading: false, error: null }); return; }
    let active = true;
    setAssetPage((current) => ({ ...current, loading: true, error: null }));
    const timer = window.setTimeout(() => {
      createHmsClient().listAssets({ customerId, locationId, search: assetQuery, newWorkOnly: true, sort: "asset_number", limit: ASSET_PAGE_SIZE, offset: 0 })
        .then((result) => { if (active) setAssetPage({ items: result.items, total: result.total, loading: false, error: null }); })
        .catch(() => { if (active) setAssetPage({ items: [], total: 0, loading: false, error: "Assets could not be loaded." }); });
    }, assetQuery ? 250 : 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [open, rescheduleBooking, customerId, locationId, assetQuery]);
  async function loadMoreAssets() {
    setAssetPage((current) => ({ ...current, loading: true, error: null }));
    try {
      const next = await fetchAssets(assetPage.items.length);
      setAssetPage((current) => ({ items: [...current.items, ...next.items.filter((item) => !current.items.some((known) => known.id === item.id))], total: next.total, loading: false, error: null }));
    } catch {
      setAssetPage((current) => ({ ...current, loading: false, error: "More assets could not be loaded." }));
    }
  }

  // The customer and location the form is showing now. Select All reads it after its request returns, so an
  // answer for a place the user has already left is dropped rather than ticked into the new place.
  const assetScope = `${customerId}|${locationId}`;
  const assetScopeRef = useRef(assetScope);
  useEffect(() => { assetScopeRef.current = assetScope; }, [assetScope]);

  async function selectAllAssets() {
    if (!customerId || !locationId || selectAllLoading) return;
    const requestedScope = assetScope;
    setSelectAllLoading(true);
    try {
      const result = await createHmsClient().listAllAssets({
        customerId,
        locationId,
        newWorkOnly: true,
        sort: "asset_number"
      });
      if (assetScopeRef.current !== requestedScope) return;
      setAssetIds(result.items.map((asset) => asset.id));
      setPickedAssets(Object.fromEntries(result.items.map((asset) => [asset.id, asset])));
    } catch {
      if (assetScopeRef.current === requestedScope) {
        setAssetPage((current) => ({ ...current, error: "All eligible assets could not be selected." }));
      }
    } finally {
      setSelectAllLoading(false);
    }
  }

  if (!open) return null;

  function updateCustomer(nextCustomerId: string) {
    setCustomerId(nextCustomerId);
    setCustomerLocations([]);
    updateLocation("");
  }

  function updateLocation(nextLocationId: string) {
    // Everything that depended on the previous location is dropped, including the
    // assets: the user picks them again for the new location.
    setLocationId(nextLocationId);
    setAssetIds([]);
    setPickedAssets({});
    setAssetQuery("");
    setBookingDate("");
    setAvailability({ key: "", slots: [] });
    setChosenQuoteId("");
    setAvailabilityError(null);
    setLoadingAvailability(false);
  }

  function toggleAsset(asset: { id: string } & Partial<AssetRecord>) {
    setAssetIds((current) =>
      current.includes(asset.id)
        ? current.filter((id) => id !== asset.id)
        : [...current, asset.id]
    );
    setPickedAssets((current) => {
      if (current[asset.id]) {
        const { [asset.id]: _removed, ...rest } = current;
        return rest;
      }
      return "assetNumber" in asset ? { ...current, [asset.id]: asset as AssetRecord } : current;
    });
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    // The submit button is not available until the choices are complete; a form submitted by the
    // keyboard before then does nothing.
    if (!bookingCustomerId || !locationId || assetIds.length === 0 || !availabilityQuoteId) return;
    await submission.run(
      async () => {
        if (rescheduleBooking && onReschedule) {
          await onReschedule(rescheduleBooking.id, {
            availabilityQuoteId,
            reason: additionalInformation.trim() || null,
            inspectorUserId: requiresInspector ? inspectorUserId : null
          });
        } else {
          await onSubmit({
            customerId: bookingCustomerId,
            locationId,
            assetIds,
            availabilityQuoteId,
            additionalInformation: additionalInformation.trim() || null,
          });
        }
      },
      markClean,
      // Keep the chosen site, assets and date; a gone or taken time must be chosen again.
      (failure) => {
        if (failure.kind === "validation" || failure.kind === "conflict" || failure.kind === "missing") setChosenQuoteId("");
      }
    );
  }

  const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: schedulingTimezone });
  return (
    <div className="drawer-backdrop">
      <FormShell
        closeLabel="Close booking form"
        description={rescheduleBooking ? "Choose a new available time for this confirmed visit." : "Choose one location and the assets that need the same visit."}
        dirty={dirty}
        errorSummaryTitle={rescheduleBooking ? "Reschedule not requested" : "Booking not created"}
        errors={submission.errors}
        fieldLabels={{}}
        fieldOrder={[]}
        formClassName="customer-drawer inspection-booking-form"
        formRef={formRef}
        headerClassName="drawer-header"
        isSubmitting={submission.isSubmitting}
        onClose={onClose}
        onEdit={touch}
        onSubmit={handleSubmit}
        pendingLabel="Saving…"
        submitDisabled={!locationId || assetIds.length === 0 || !availabilityQuoteId || (rescheduleBooking !== null && requiresInspector && !inspectorUserId)}
        submitError={submission.submitError}
        submitLabel={rescheduleBooking ? "Request reschedule" : "Create booking"}
        title={rescheduleBooking ? "Request reschedule" : "Book inspection"}
      >
        <FormSection title="Where">
          {rescheduleBooking ? null : (
            <Field label="Customer" name="customerId" required>
              {(props) => (
                <Combobox
                  {...props}
                  aria-label="Booking customer"
                  emptyText="No customers match"
                  loading={customerSearch.loading}
                  onChange={(next) => {
                    const found = customerSearch.items.find((option) => option.id === next);
                    setChosenCustomer(found ? { value: found.id, label: found.name, description: found.code ?? undefined } : null);
                    updateCustomer(next);
                    touch();
                  }}
                  onSearch={customerSearch.search}
                  options={customerSearch.items.map((customer) => ({ value: customer.id, label: customer.name, description: customer.code ?? undefined, searchText: `${customer.code ?? ""} ${customer.name}` }))}
                  placeholder="Select a customer"
                  selectedOption={chosenCustomer}
                  value={customerId}
                />
              )}
            </Field>
          )}
          <Field label="Location" name="locationId" required>
            {(props) => (
              <Select
                {...props}
                aria-label="Booking location"
                disabled={Boolean(rescheduleBooking) || !customerId}
                onChange={(next) => { updateLocation(next); touch(); }}
                emptyLabel={rescheduleBooking ? undefined : customerId ? "Choose the location" : "Choose a customer first"}
                options={locations.map((location) => ({ value: location.id, label: location.label }))}
                placeholder={customerId || rescheduleBooking ? "Choose the location" : "Choose a customer first"}
                value={locationId}
              />
            )}
          </Field>
          <fieldset className="booking-asset-list" disabled={Boolean(rescheduleBooking)}>
            <legend>Assets<RequiredMark /></legend>
            {!locationId ? <p className="field-hint">Choose a location to see its assets.</p> : null}
            {locationId && !rescheduleBooking ? (
              <input
                aria-label="Search assets"
                className="booking-asset-search"
                onChange={(event) => setAssetQuery(event.target.value)}
                placeholder="Search assets"
                type="search"
                value={assetQuery}
              />
            ) : null}
            {locationId && !rescheduleBooking ? (
              <p className="field-hint" role="status">
                {assetPage.loading && assetPage.items.length === 0 ? "Loading assets" : assetQuery.trim() ? `${assetPage.total} matching` : `${assetPage.items.length} of ${assetPage.total} assets shown`}
                {assetIds.length > 0 ? `, ${assetIds.length} selected` : ""}
              </p>
            ) : null}
            {locationId && !rescheduleBooking && assetPage.total > 0 ? (
              <div className="row-actions">
                <button className="secondary-button" disabled={selectAllLoading} onClick={() => void selectAllAssets()} type="button">
                  {selectAllLoading ? "Selecting…" : "Select all assets"}
                </button>
                {assetIds.length ? <button className="ghost-button" onClick={() => { setAssetIds([]); setPickedAssets({}); }} type="button">Clear selection</button> : null}
              </div>
            ) : null}
            {assetPage.error ? <p className="field-error" role="alert">{assetPage.error}</p> : null}
            {locationId && !rescheduleBooking && !assetPage.loading && !assetPage.error && assetChoices.length === 0 ? (
              <p className="field-hint">{assetQuery.trim() ? "No assets match this search." : "No assets are assigned to this location."}</p>
            ) : null}
            {rescheduleBooking ? assetChoices.map((asset) => (
              <label key={asset.id} className="checkbox-field">
                <input checked={assetIds.includes(asset.id)} onChange={() => toggleAsset(asset)} type="checkbox" />
                <span>{assetLabel(asset)}</span>
              </label>
            )) : (
              <>
                {Object.values(pickedAssets).filter((picked) => !assetPage.items.some((item) => item.id === picked.id)).map((asset) => (
                  <label key={asset.id} className="checkbox-field">
                    <input checked={assetIds.includes(asset.id)} onChange={() => toggleAsset(asset)} type="checkbox" />
                    <span>{assetLabel(asset)}</span>
                  </label>
                ))}
                {assetPage.items.map((asset) => (
                  <label key={asset.id} className="checkbox-field">
                    <input checked={assetIds.includes(asset.id)} onChange={() => toggleAsset(asset)} type="checkbox" />
                    <span>{assetLabel(asset)}</span>
                  </label>
                ))}
                {assetPage.items.length < assetPage.total ? (
                  <button className="secondary-button" disabled={assetPage.loading} onClick={() => void loadMoreAssets()} type="button">
                    {assetPage.loading ? "Loading…" : "Show more assets"}
                  </button>
                ) : null}
              </>
            )}
          </fieldset>
        </FormSection>
        <FormSection title="When">
          <Field label="Preferred inspection date" name="bookingDate" required>
            {(props) => (
              <input
                {...props}
                aria-label="Preferred inspection date"
                disabled={!locationId}
                type="date"
                value={bookingDate}
                onChange={(event) => setBookingDate(event.target.value)}
              />
            )}
          </Field>
          {bookingDate ? (
            <Field error={availabilityError ?? undefined} label={`Available time (${schedulingTimezone})`} name="availabilityQuoteId" required>
              {(props) => (
                <Select
                  {...props}
                  aria-label="Available inspection time"
                  disabled={isLoadingAvailability || availableSlots.length === 0}
                  onChange={(next) => { setChosenQuoteId(next); touch(); }}
                  options={availableSlots.map((slot) => ({ value: slot.quoteId, label: `${timeFormat.format(new Date(slot.startsAt))} - ${timeFormat.format(new Date(slot.endsAt))}` }))}
                  placeholder={isLoadingAvailability ? "Checking availability..." : availableSlots.length ? "Select a time" : "No times available"}
                  value={availabilityQuoteId}
                />
              )}
            </Field>
          ) : null}
        </FormSection>
        <FormSection title="Details">
          {rescheduleBooking && requiresInspector ? (
            <Field label="Inspector" name="inspectorUserId" required>
              {(props) => (
                <Select
                  {...props}
                  aria-label="Inspector for rescheduled inspection"
                  onChange={(next) => { setInspectorUserId(next); touch(); }}
                  options={inspectors.map((inspector) => ({ value: inspector.id, label: inspector.displayName }))}
                  placeholder="Assign inspector"
                  value={inspectorUserId}
                />
              )}
            </Field>
          ) : null}
          <Field label={rescheduleBooking ? "Reason for rescheduling" : "Additional information"} name="additionalInformation">
            {(props) => (
              <textarea
                {...props}
                aria-label="Additional inspection information"
                rows={3}
                value={additionalInformation}
                onChange={(event) => setAdditionalInformation(event.target.value)}
              />
            )}
          </Field>
        </FormSection>
      </FormShell>
    </div>
  );
}
