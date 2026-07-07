import type {
  ActivityItem,
  CustomerFormValues,
  CustomerMetrics,
  CustomerRecord,
  InspectionState,
  RiskLevel
} from "../domain/types";

export const mockTotalCustomers = 45;

const sharedActivity: ActivityItem[] = [
  {
    id: "act-1",
    type: "inspection",
    title: "Inspection overdue for HP Hose Assembly - 10023",
    meta: "North Sea Drilling Ltd. * ABZ-PLT-1",
    status: "Overdue",
    time: "2h ago"
  },
  {
    id: "act-2",
    type: "inspection",
    title: "Inspection due soon for Water Hose - 10087",
    meta: "North Sea Drilling Ltd. * ABZ-PLT-2",
    status: "Due Soon",
    time: "6h ago"
  },
  {
    id: "act-3",
    type: "inspection",
    title: "Inspection completed for Chemical Hose - 10045",
    meta: "North Sea Drilling Ltd. * John Inspector",
    status: "Current",
    time: "1d ago"
  },
  {
    id: "act-4",
    type: "certificate",
    title: "Certificate renewed for HP Hose Assembly - 10022",
    meta: "North Sea Drilling Ltd. * Certificate #CERT-55678",
    status: "Valid",
    time: "2d ago"
  },
  {
    id: "act-5",
    type: "contact",
    title: "Contact updated: Michael Grant",
    meta: "North Sea Drilling Ltd. * Operations Manager",
    time: "3d ago"
  }
];

const recentInspections = [
  {
    id: "insp-1",
    status: "Overdue" as InspectionState,
    asset: "HP Hose Assembly - 10023",
    date: "02 May 2025",
    locationCode: "ABZ-PLT-1"
  },
  {
    id: "insp-2",
    status: "Due Soon" as InspectionState,
    asset: "Water Hose - 10087",
    date: "18 May 2025",
    locationCode: "ABZ-PLT-2"
  },
  {
    id: "insp-3",
    status: "Current" as InspectionState,
    asset: "Chemical Hose - 10045",
    date: "25 May 2025",
    locationCode: "ABZ-YD-1"
  }
];

function metrics(
  assetCount: number,
  inspectionDueCount: number,
  certificateValidPercent: number,
  inspectionDueLabel: string
): CustomerMetrics {
  return {
    assetCount,
    inServiceCount: Math.max(assetCount - inspectionDueCount, 0),
    outOfServiceCount: inspectionDueCount,
    inspectionDueCount,
    inspectionDueLabel,
    certificateValidPercent,
    certificateStatusLabel: `${certificateValidPercent}% Valid`,
    recentInspections,
    activity: sharedActivity
  };
}

function customer(
  id: string,
  code: string,
  name: string,
  location: { name: string; city: string; country: string },
  assetCount: number,
  inspectionDueCount: number,
  certificateValidPercent: number,
  riskLevel: RiskLevel,
  lastActivity: string,
  inspectionDueLabel: string
): CustomerRecord {
  return {
    id,
    code,
    name,
    notes: `Coordinate retest scheduling and site access through ${location.name}.`,
    retestEnabled: true,
    defaultRetestMonths: 12,
    status: "Active",
    riskLevel,
    industry: "Offshore Drilling",
    paymentTerms: "Net 30",
    contractStart: "15 Mar 2022",
    contractEnd: "14 Mar 2025",
    lastActivity,
    metrics: metrics(
      assetCount,
      inspectionDueCount,
      certificateValidPercent,
      inspectionDueLabel
    ),
    locations: [
      {
        id: `${id}-loc-1`,
        name: location.name,
        address1: "Primary operations site",
        address2: null,
        city: location.city,
        state: null,
        country: location.country
      },
      {
        id: `${id}-loc-2`,
        name: `${location.city} Service Yard`,
        address1: "Inspection and retest bay",
        address2: null,
        city: location.city,
        state: null,
        country: location.country
      },
      {
        id: `${id}-loc-3`,
        name: `${location.city} Offshore Platform`,
        address1: "Operating asset location",
        address2: null,
        city: location.city,
        state: null,
        country: location.country
      }
    ],
    contacts: [
      {
        id: `${id}-contact-1`,
        name: "Michael Grant",
        email: "michael.grant@example.com",
        phone: "+44 20 1000 1000",
        role: "Operations Manager",
        receivesRetestReminders: true
      },
      {
        id: `${id}-contact-2`,
        name: "Sarah Walker",
        email: "sarah.walker@example.com",
        phone: "+44 20 1000 1001",
        role: "Asset Coordinator",
        receivesRetestReminders: true
      },
      {
        id: `${id}-contact-3`,
        name: "Daniel Hughes",
        email: "daniel.hughes@example.com",
        phone: "+44 20 1000 1002",
        role: "Maintenance Lead",
        receivesRetestReminders: false
      },
      {
        id: `${id}-contact-4`,
        name: "Priya Nair",
        email: "priya.nair@example.com",
        phone: "+44 20 1000 1003",
        role: "Compliance Officer",
        receivesRetestReminders: true
      }
    ]
  };
}

export const mockCustomers: CustomerRecord[] = [
  customer(
    "cust-1001",
    "NSD",
    "North Sea Drilling Ltd.",
    { name: "Aberdeen Yard", city: "Aberdeen", country: "UK" },
    128,
    12,
    92,
    "High",
    "2h ago",
    "12 Overdue"
  ),
  customer(
    "cust-1002",
    "OPI",
    "Oceanic Platforms Inc.",
    { name: "Stavanger Base", city: "Stavanger", country: "Norway" },
    96,
    3,
    89,
    "High",
    "1d ago",
    "3 Overdue"
  ),
  customer(
    "cust-1003",
    "PMS",
    "PetroMarine Services",
    { name: "Houston Facility", city: "Houston", country: "USA" },
    75,
    5,
    95,
    "Medium",
    "3h ago",
    "5 Due Soon"
  ),
  customer(
    "cust-1004",
    "BWE",
    "Bluewater Energy",
    { name: "Singapore Terminal", city: "Singapore", country: "Singapore" },
    62,
    0,
    100,
    "Medium",
    "5d ago",
    "All Current"
  ),
  customer(
    "cust-1005",
    "AOA",
    "Arctic Offshore AS",
    { name: "Tromso Depot", city: "Tromso", country: "Norway" },
    48,
    2,
    84,
    "High",
    "6h ago",
    "2 Overdue"
  ),
  customer(
    "cust-1006",
    "GCM",
    "Gulf Coast Marine",
    { name: "New Orleans Dock", city: "New Orleans", country: "USA" },
    33,
    0,
    97,
    "Low",
    "1d ago",
    "All Current"
  ),
  customer(
    "cust-1007",
    "SOL",
    "Seaway Offshore Ltd.",
    { name: "Perth Service Centre", city: "Perth", country: "Australia" },
    27,
    1,
    90,
    "Medium",
    "2d ago",
    "1 Due Soon"
  ),
  customer(
    "cust-1008",
    "WAO",
    "West Africa Operators",
    { name: "Lagos Base", city: "Lagos", country: "Nigeria" },
    19,
    0,
    88,
    "Medium",
    "4d ago",
    "All Current"
  ),
  customer(
    "cust-1009",
    "BDC",
    "Baltic Drilling Co.",
    { name: "Gdansk Yard", city: "Gdansk", country: "Poland" },
    15,
    0,
    100,
    "Low",
    "7d ago",
    "All Current"
  ),
  customer(
    "cust-1010",
    "PEL",
    "Pacific Energy Ltd.",
    { name: "Auckland Yard", city: "Auckland", country: "NZ" },
    12,
    1,
    92,
    "Low",
    "3d ago",
    "1 Due Soon"
  )
];

export function makeLocalCustomer(values: CustomerFormValues): CustomerRecord {
  const id = `local-${Date.now()}`;
  return {
    id,
    code: values.code.trim().toUpperCase(),
    name: values.name.trim(),
    notes: values.notes,
    retestEnabled: values.retestEnabled,
    defaultRetestMonths: values.defaultRetestMonths,
    status: "Review",
    riskLevel: "Low",
    industry: "Marine Operations",
    paymentTerms: "Net 30",
    contractStart: "Not set",
    contractEnd: "Not set",
    lastActivity: "Just now",
    metrics: metrics(0, 0, 100, "All Current"),
    locations: [],
    contacts: []
  };
}

export function mergeMockMetrics(customer: CustomerRecord): CustomerRecord {
  const fixture =
    mockCustomers.find((item) => item.code === customer.code) ??
    mockCustomers.find((item) => item.name === customer.name);
  if (!fixture) {
    return customer;
  }
  return {
    ...customer,
    status: fixture.status,
    riskLevel: fixture.riskLevel,
    industry: fixture.industry,
    paymentTerms: fixture.paymentTerms,
    contractStart: fixture.contractStart,
    contractEnd: fixture.contractEnd,
    lastActivity: fixture.lastActivity,
    metrics: fixture.metrics
  };
}
