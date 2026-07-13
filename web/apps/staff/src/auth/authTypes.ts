import type { StaffSession } from "../domain/types";

// --- wire responses (mirror backend api/browser_auth.py) ------------------------

export type BrowserAuthNextStep =
  | "PASSWORD_CHANGE_REQUIRED"
  | "MFA_ENROLLMENT_REQUIRED"
  | "MFA_REQUIRED"
  | "RECOVERY_CODES"
  | "AUTHENTICATED";

export interface BrowserChallengeResponse {
  next_step: BrowserAuthNextStep;
  challenge: string;
  expires_in: number;
}

export interface BrowserEnrollmentResponse {
  next_step: "MFA_ENROLLMENT_REQUIRED";
  challenge: string;
  otpauth_uri: string;
  manual_key: string;
}

export interface BrowserAuthenticatedResponse {
  next_step: "AUTHENTICATED";
  access_token: string;
  token_type: "bearer";
  expires_in: number;
}

export interface BrowserRecoveryCodesResponse {
  next_step: "RECOVERY_CODES";
  access_token: string;
  expires_in: number;
  recovery_codes: string[];
}

export interface BrowserMeResponse {
  user_id: string;
  email: string;
  display_name: string;
  account_status: string;
  roles: string[];
  permissions: string[];
  customer_ids: string[];
}

export interface BrowserMessageResponse {
  message: string;
}

// --- provider state machine -----------------------------------------------------

export type AuthState =
  | { status: "loading" }
  | { status: "signed-out"; message?: string }
  | { status: "forgot-password"; message?: string }
  | { status: "password-reset-sent"; message?: string }
  | { status: "password-reset"; token: string; message?: string }
  | { status: "password-reset-complete"; message?: string }
  | { status: "password-change"; challenge: string; message?: string }
  | {
      status: "mfa-enrollment";
      challenge: string;
      otpauthUri?: string;
      manualKey?: string;
      message?: string;
    }
  | { status: "mfa-challenge"; challenge: string; message?: string }
  | { status: "recovery-codes"; session: StaffSession; recoveryCodes: string[] }
  | { status: "authenticated"; session: StaffSession }
  | { status: "expired"; message: string };

export interface AuthContextValue {
  state: AuthState;
  login(email: string, password: string): Promise<void>;
  showForgotPassword(): void;
  showSignIn(): void;
  requestPasswordReset(email: string): Promise<void>;
  confirmPasswordReset(password: string): Promise<void>;
  changeRequiredPassword(password: string): Promise<void>;
  startMfaEnrollment(): Promise<void>;
  confirmMfa(code: string): Promise<void>;
  verifyMfa(code: string): Promise<void>;
  verifyRecoveryCode(code: string): Promise<void>;
  acknowledgeRecoveryCodes(): void;
  logout(): Promise<void>;
  getAccessToken(): string | null;
}

export class BrowserAuthError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "BrowserAuthError";
    this.status = status;
  }
}
