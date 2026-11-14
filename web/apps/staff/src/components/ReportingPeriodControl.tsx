import { CalendarRange } from "lucide-react";
import { useState } from "react";

import {
  reportingPeriodForPreset,
  reportingPeriodFromDates
} from "../utils/reportingPeriod";
import type { ReportingPeriod, ReportingPeriodPreset } from "../utils/reportingPeriod";

interface ReportingPeriodControlProps {
  onChange: (period: ReportingPeriod) => void;
  period: ReportingPeriod;
  /** The organisation's IANA zone, so custom dates mean whole days there. */
  timeZone?: string;
}

const quickPresets: Array<{ label: string; value: Exclude<ReportingPeriodPreset, "custom"> }> = [
  { value: "last_hour", label: "Last 1 hour" },
  { value: "last_day", label: "Last 1 day" },
  { value: "last_week", label: "Last 1 week" },
  { value: "last_month", label: "Last 1 month" },
  { value: "last_three_months", label: "Last 3 months" }
];

export function ReportingPeriodControl({ onChange, period, timeZone }: ReportingPeriodControlProps) {
  const [startDate, setStartDate] = useState(period.startDate);
  const [endDate, setEndDate] = useState(period.endDate);
  const isCustom = period.preset === "custom";

  function selectPreset(preset: ReportingPeriodPreset) {
    if (preset === "custom") {
      onChange(reportingPeriodFromDates(startDate, endDate, timeZone) ?? reportingPeriodForPreset("last_month"));
      return;
    }
    onChange(reportingPeriodForPreset(preset));
  }

  function applyCustomRange() {
    const range = reportingPeriodFromDates(startDate, endDate, timeZone);
    if (range) onChange(range);
  }

  return (
    <div className="reporting-period-control" role="group" aria-label="Reporting period">
      <label className="reporting-period-select">
        <CalendarRange aria-hidden="true" size={16} />
        <span className="sr-only">Reporting period</span>
        <select
          aria-label="Reporting period"
          onChange={(event) => selectPreset(event.target.value as ReportingPeriodPreset)}
          value={period.preset}
        >
          {quickPresets.map((preset) => <option key={preset.value} value={preset.value}>{preset.label}</option>)}
          <option value="custom">Custom range</option>
        </select>
      </label>
      {isCustom ? (
        <div className="reporting-period-custom">
          <label>
            <span>From</span>
            <input aria-label="Reporting period start" max={endDate} onChange={(event) => setStartDate(event.target.value)} type="date" value={startDate} />
          </label>
          <label>
            <span>To</span>
            <input aria-label="Reporting period end" min={startDate} onChange={(event) => setEndDate(event.target.value)} type="date" value={endDate} />
          </label>
          <button disabled={!reportingPeriodFromDates(startDate, endDate, timeZone)} onClick={applyCustomRange} type="button">
            Apply
          </button>
          {timeZone ? <span className="reporting-period-zone">Whole days, {timeZone.replaceAll("_", " ")}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
