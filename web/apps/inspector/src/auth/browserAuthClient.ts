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
  roles: string[];
}

export interface BrowserMessageResponse {
  message: string;
}

export class BrowserAuthError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "BrowserAuthError";
  }
}

export interface BrowserAuthClientOptions {
  baseUrl?: string;
  fetcher?: typeof fetch;
}

const prefix = "/api/v1/auth/browser";

async function parse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as { detail?: unknown };
      if (typeof body.detail === "string") {
        message = body.detail;
      }
    } catch {
      // Keep the status-based error if the response is not JSON.
    }
    throw new BrowserAuthError(message, response.status);
  }
  return (await response.json()) as T;
}

function origin(): string {
  return typeof window !== "undefined" ? window.location.origin : "";
}

/**
 * Uses the existing browser-auth API. Refresh tokens remain HttpOnly cookies;
 * callers retain access tokens only in memory.
 */
export function createBrowserAuthClient(options: BrowserAuthClientOptions = {}) {
  const baseUrl = options.baseUrl ?? "";
  const fetcher = options.fetcher ?? fetch;

  function post<T>(path: string, body: unknown, init: RequestInit = {}) {
    return fetcher(`${baseUrl}${prefix}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...init.headers },
      body: JSON.stringify(body),
      ...init
    }).then((response) => parse<T>(response));
  }

  return {
    login(email: string, password: string): Promise<BrowserChallengeResponse | BrowserAuthenticatedResponse> {
      return post("/login", { email, password });
    },
    requestPasswordReset(email: string): Promise<BrowserMessageResponse> {
      return post("/password/reset-request", { email });
    },
    changePassword(challenge: string, newPassword: string): Promise<BrowserChallengeResponse | BrowserAuthenticatedResponse> {
      return post("/password", { challenge, new_password: newPassword });
    },
    startEnrollment(challenge: string): Promise<BrowserEnrollmentResponse> {
      return post("/mfa/enrollment", { challenge });
    },
    confirmMfa(challenge: string, code: string): Promise<BrowserRecoveryCodesResponse> {
      return post("/mfa/confirm", { challenge, code }, { credentials: "include" });
    },
    verifyMfa(challenge: string, code: string): Promise<BrowserAuthenticatedResponse> {
      return post("/mfa/verify", { challenge, code }, { credentials: "include" });
    },
    verifyRecovery(challenge: string, code: string): Promise<BrowserAuthenticatedResponse> {
      return post("/recovery/verify", { challenge, code }, { credentials: "include" });
    },
    refresh(): Promise<BrowserAuthenticatedResponse> {
      return fetcher(`${baseUrl}${prefix}/refresh`, {
        method: "POST",
        credentials: "include",
        headers: { Origin: origin() }
      }).then((response) => parse<BrowserAuthenticatedResponse>(response));
    },
    logout(): Promise<void> {
      return fetcher(`${baseUrl}${prefix}/logout`, {
        method: "POST",
        credentials: "include",
        headers: { Origin: origin() }
      }).then(() => undefined);
    },
    me(accessToken: string): Promise<BrowserMeResponse> {
      return fetcher(`${baseUrl}${prefix}/me`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      }).then((response) => parse<BrowserMeResponse>(response));
    }
  };
}

export type BrowserAuthClient = ReturnType<typeof createBrowserAuthClient>;
