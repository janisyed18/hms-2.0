import type {
  AdminUserRecord,
  AuditEventRecord,
  DeviceRecord,
  StaffSession
} from "../domain/types";

export const mockStaffSession: StaffSession = {
  userId: "staff-ui-dev",
  displayName: "Alex Williams",
  roles: ["HMS_ADMIN", "INSPECTOR", "REVIEWER"],
  permissions: [
    "customer:read",
    "customer:write",
    "asset:read",
    "asset:write",
    "inspection:write",
    "certificate:approve",
    "reference:admin",
    "user:admin",
    "device:admin",
    "audit:read"
  ],
  customerIds: [],
  authMode: "mock"
};

export const mockAdminUsers: AdminUserRecord[] = [
  {
    id: "user-1001",
    oidcSubject: "staff-ui-dev",
    email: "staff@example.com",
    firstName: "James",
    lastName: "Mitchell",
    displayName: "James Mitchell",
    role: "HMS_ADMIN",
    customerId: null,
    accountStatus: "ACTIVE",
    mustChangePassword: false,
    mfaEnabled: true,
    lockedUntil: null,
    lastLoginAt: "2026-07-07T02:00:00Z",
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-07T00:00:00Z"
  },
  {
    id: "user-1002",
    oidcSubject: "inspector-1",
    email: "inspector@example.com",
    firstName: "Ivy",
    lastName: "Inspector",
    displayName: "Ivy Inspector",
    role: "INSPECTOR",
    customerId: null,
    accountStatus: "ACTIVE",
    mustChangePassword: false,
    mfaEnabled: true,
    lockedUntil: null,
    lastLoginAt: "2026-07-06T18:00:00Z",
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-06T00:00:00Z"
  },
  {
    id: "user-1003",
    oidcSubject: "reviewer-1",
    email: "reviewer@example.com",
    firstName: "Riley",
    lastName: "Reviewer",
    displayName: "Riley Reviewer",
    role: "REVIEWER",
    customerId: null,
    accountStatus: "LOCKED",
    mustChangePassword: false,
    mfaEnabled: true,
    lockedUntil: "2026-07-12T04:00:00Z",
    lastLoginAt: "2026-07-05T10:00:00Z",
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-05T00:00:00Z"
  }
];

export const mockDevices: DeviceRecord[] = [
  {
    deviceId: "field-tablet-01",
    displayName: "Field Tablet 01",
    userId: "inspector-1",
    platform: "ios",
    appVersion: "26.4.1",
    lastSyncAt: "2026-07-07T01:30:00Z",
    offlineWindowDays: 7,
    revoked: false,
    state: "Offline Ready"
  },
  {
    deviceId: "field-tablet-02",
    displayName: "Field Tablet 02",
    userId: "inspector-2",
    platform: "android",
    appVersion: "26.4.0",
    lastSyncAt: null,
    offlineWindowDays: 7,
    revoked: false,
    state: "Pending"
  }
];

export const mockAuditEvents: AuditEventRecord[] = [
  {
    sequence: 3,
    actorId: "reviewer-1",
    action: "inspection.approved",
    entity: "Inspection",
    entityId: "inspection-1003",
    before: { status: "SUBMITTED" },
    after: { status: "APPROVED" },
    timestamp: "2026-07-07T01:35:00Z",
    hash: "mock-audit-3"
  },
  {
    sequence: 2,
    actorId: "staff-ui-dev",
    action: "certificate.issued",
    entity: "Certificate",
    entityId: "certificate-1001",
    before: null,
    after: { number: "CERT-VOPA-NEW-1" },
    timestamp: "2026-07-07T01:20:00Z",
    hash: "mock-audit-2"
  },
  {
    sequence: 1,
    actorId: "staff-ui-dev",
    action: "asset.updated",
    entity: "Asset",
    entityId: "asset-1001",
    before: { lifecycle_status: "DUE" },
    after: { lifecycle_status: "OVERDUE" },
    timestamp: "2026-07-07T01:10:00Z",
    hash: "mock-audit-1"
  }
];
