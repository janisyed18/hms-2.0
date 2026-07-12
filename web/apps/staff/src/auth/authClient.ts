import {
  BrowserAuthError,
  type BrowserAuthenticatedResponse,
  type BrowserChallengeResponse,
  type BrowserEnrollmentResponse,
  type BrowserMeResponse,
  type BrowserRecoveryCodesResponse
} from "./authTypes";

export interface BrowserAuthClientOptions {
  baseUrl?: string;
  fetcher?: typeof fetch;
}

const PREFIX = "/api/v1/auth/browser";

async function parse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as { detail?: unknown };
      if (typeof body.detail === "string") {
        message = body.detail;
      }
    } catch {
      // non-JSON error body; keep the generic message.
    }
    throw new BrowserAuthError(message, response.status);
  }
  return (await response.json()) as T;
}

/**
 * Thin client for the staff browser-auth endpoints. Refresh and logout send the
 * HttpOnly cookie (`credentials: "include"`); other calls are stateless. The
 * access token is never stored here — the caller injects it for `me`.
 */
export function createBrowserAuthClient(options: BrowserAuthClientOptions = {}) {
  const baseUrl = options.baseUrl ?? "";
  const fetcher = options.fetcher ?? fetch;

  function post<T>(
    path: string,
    body: unknown,
    init: RequestInit = {}
  ): Promise<T> {
    return fetcher(`${baseUrl}${PREFIX}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...init.headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      ...init
    }).then((response) => parse<T>(response));
  }

  return {
    login(email: string, password: string): Promise<BrowserChallengeResponse> {
      return post("/login", { email, password });
    },
    changePassword(
      challenge: string,
      newPassword: string
    ): Promise<BrowserChallengeResponse> {
      return post("/password", { challenge, new_password: newPassword });
    },
    startEnrollment(challenge: string): Promise<BrowserEnrollmentResponse> {
      return post("/mfa/enrollment", { challenge });
    },
    confirmMfa(
      challenge: string,
      code: string
    ): Promise<BrowserRecoveryCodesResponse> {
      return post("/mfa/confirm", { challenge, code }, { credentials: "include" });
    },
    verifyMfa(
      challenge: string,
      code: string
    ): Promise<BrowserAuthenticatedResponse> {
      return post("/mfa/verify", { challenge, code }, { credentials: "include" });
    },
    verifyRecovery(
      challenge: string,
      code: string
    ): Promise<BrowserAuthenticatedResponse> {
      return post(
        "/recovery/verify",
        { challenge, code },
        { credentials: "include" }
      );
    },
    refresh(): Promise<BrowserAuthenticatedResponse> {
      return fetcher(`${baseUrl}${PREFIX}/refresh`, {
        method: "POST",
        credentials: "include",
        headers: { Origin: origin() }
      }).then((response) => parse<BrowserAuthenticatedResponse>(response));
    },
    logout(): Promise<void> {
      return fetcher(`${baseUrl}${PREFIX}/logout`, {
        method: "POST",
        credentials: "include",
        headers: { Origin: origin() }
      }).then(() => undefined);
    },
    me(accessToken: string): Promise<BrowserMeResponse> {
      return fetcher(`${baseUrl}${PREFIX}/me`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      }).then((response) => parse<BrowserMeResponse>(response));
    }
  };
}

export type BrowserAuthClient = ReturnType<typeof createBrowserAuthClient>;

function origin(): string {
  return typeof window !== "undefined" && window.location
    ? window.location.origin
    : "";
}
