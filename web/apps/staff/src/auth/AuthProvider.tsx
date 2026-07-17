import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";

import type { StaffPermission, StaffRole, StaffSession } from "../domain/types";
import { configureHmsRuntimeAuth } from "../api/hmsClient";
import { createBrowserAuthClient, type BrowserAuthClient } from "./authClient";
import {
  BrowserAuthError,
  type AuthContextValue,
  type AuthState,
  type BrowserChallengeResponse,
  type BrowserMeResponse
} from "./authTypes";
import { capturePasswordResetToken } from "./passwordReset";

const AuthContext = createContext<AuthContextValue | null>(null);

function toSession(me: BrowserMeResponse): StaffSession {
  return {
    userId: me.user_id,
    displayName: me.display_name,
    email: me.email,
    roles: me.roles as StaffRole[],
    permissions: me.permissions as StaffPermission[],
    customerIds: me.customer_ids,
    authMode: "bearer"
  };
}

function challengeState(response: BrowserChallengeResponse): AuthState {
  if (response.next_step === "PASSWORD_CHANGE_REQUIRED") {
    return { status: "password-change", challenge: response.challenge };
  }
  if (response.next_step === "MFA_ENROLLMENT_REQUIRED") {
    return { status: "mfa-enrollment", challenge: response.challenge };
  }
  return { status: "mfa-challenge", challenge: response.challenge };
}

function errorMessage(error: unknown): string {
  if (error instanceof BrowserAuthError) {
    return error.message;
  }
  return "Something went wrong. Please try again.";
}

interface AuthProviderProps {
  client?: BrowserAuthClient;
  children: ReactNode;
}

export function AuthProvider({ client, children }: AuthProviderProps) {
  const authClient = useMemo(
    () => client ?? createBrowserAuthClient(),
    [client]
  );
  const [state, setState] = useState<AuthState>({ status: "loading" });
  const stateRef = useRef<AuthState>(state);
  const tokenRef = useRef<string | null>(null);
  const refreshInFlight = useRef<Promise<string> | null>(null);
  const resetTokenRef = useRef<string | null | undefined>(undefined);

  const apply = useCallback((next: AuthState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  // Owns the access token only in a ref (never state/storage) and coalesces
  // concurrent refreshes into a single in-flight request.
  const refreshAccessToken = useCallback(async (): Promise<string> => {
    if (refreshInFlight.current) {
      return refreshInFlight.current;
    }
    const promise = authClient
      .refresh()
      .then((response) => {
        tokenRef.current = response.access_token;
        return response.access_token;
      })
      .finally(() => {
        refreshInFlight.current = null;
      });
    refreshInFlight.current = promise;
    return promise;
  }, [authClient]);

  const handleAuthFailure = useCallback(() => {
    tokenRef.current = null;
    apply({ status: "signed-out", message: "Your session has expired. Please sign in again." });
  }, [apply]);

  useEffect(
    () =>
      configureHmsRuntimeAuth({
        getAccessToken: () => tokenRef.current,
        refreshAccessToken,
        onAuthFailure: handleAuthFailure
      }),
    [handleAuthFailure, refreshAccessToken]
  );

  const enterAuthenticated = useCallback(
    async (accessToken: string, recoveryCodes?: string[]) => {
      tokenRef.current = accessToken;
      const me = await authClient.me(accessToken);
      const session = toSession(me);
      apply(
        recoveryCodes
          ? { status: "recovery-codes", session, recoveryCodes }
          : { status: "authenticated", session }
      );
    },
    [authClient, apply]
  );

  useEffect(() => {
    let active = true;
    // Strict Mode replays effects in development. Capture a reset token once
    // so the replay does not consume it a second time or skip state restore.
    const resetToken =
      resetTokenRef.current === undefined
        ? capturePasswordResetToken()
        : resetTokenRef.current;
    resetTokenRef.current = resetToken;
    if (resetToken) {
      apply({ status: "password-reset", token: resetToken });
      return () => {
        active = false;
      };
    }
    (async () => {
      try {
        const accessToken = await refreshAccessToken();
        if (active) {
          await enterAuthenticated(accessToken);
        }
      } catch {
        tokenRef.current = null;
        if (active) {
          apply({ status: "signed-out" });
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [refreshAccessToken, enterAuthenticated, apply]);

  const login = useCallback(
    async (email: string, password: string) => {
      try {
        apply(challengeState(await authClient.login(email, password)));
      } catch (error) {
        apply({ status: "signed-out", message: errorMessage(error) });
      }
    },
    [authClient, apply]
  );

  const showForgotPassword = useCallback(() => {
    apply({ status: "forgot-password" });
  }, [apply]);

  const showSignIn = useCallback(() => {
    tokenRef.current = null;
    apply({ status: "signed-out" });
  }, [apply]);

  const requestPasswordReset = useCallback(
    async (email: string) => {
      try {
        const response = await authClient.requestPasswordReset(email);
        apply({ status: "password-reset-sent", message: response.message });
      } catch (error) {
        apply({ status: "forgot-password", message: errorMessage(error) });
      }
    },
    [authClient, apply]
  );

  const confirmPasswordReset = useCallback(
    async (password: string) => {
      const current = stateRef.current;
      if (current.status !== "password-reset") {
        return;
      }
      try {
        const response = await authClient.confirmPasswordReset(
          current.token,
          password
        );
        apply({
          status: "password-reset-complete",
          message: response.message
        });
      } catch (error) {
        apply({ ...current, message: errorMessage(error) });
      }
    },
    [authClient, apply]
  );

  const changeRequiredPassword = useCallback(
    async (password: string) => {
      const current = stateRef.current;
      if (current.status !== "password-change") {
        return;
      }
      try {
        apply(challengeState(await authClient.changePassword(current.challenge, password)));
      } catch (error) {
        apply({ ...current, message: errorMessage(error) });
      }
    },
    [authClient, apply]
  );

  const startMfaEnrollment = useCallback(async () => {
    const current = stateRef.current;
    if (current.status !== "mfa-enrollment") {
      return;
    }
    try {
      const response = await authClient.startEnrollment(current.challenge);
      apply({
        status: "mfa-enrollment",
        challenge: current.challenge,
        otpauthUri: response.otpauth_uri,
        manualKey: response.manual_key
      });
    } catch (error) {
      apply({ ...current, message: errorMessage(error) });
    }
  }, [authClient, apply]);

  const confirmMfa = useCallback(
    async (code: string) => {
      const current = stateRef.current;
      if (current.status !== "mfa-enrollment") {
        return;
      }
      try {
        const response = await authClient.confirmMfa(current.challenge, code);
        await enterAuthenticated(response.access_token, response.recovery_codes);
      } catch (error) {
        apply({ ...current, message: errorMessage(error) });
      }
    },
    [authClient, apply, enterAuthenticated]
  );

  const verifyMfa = useCallback(
    async (code: string) => {
      const current = stateRef.current;
      if (current.status !== "mfa-challenge") {
        return;
      }
      try {
        const response = await authClient.verifyMfa(current.challenge, code);
        await enterAuthenticated(response.access_token);
      } catch (error) {
        apply({ ...current, message: errorMessage(error) });
      }
    },
    [authClient, apply, enterAuthenticated]
  );

  const verifyRecoveryCode = useCallback(
    async (code: string) => {
      const current = stateRef.current;
      if (current.status !== "mfa-challenge") {
        return;
      }
      try {
        const response = await authClient.verifyRecovery(current.challenge, code);
        await enterAuthenticated(response.access_token);
      } catch (error) {
        apply({ ...current, message: errorMessage(error) });
      }
    },
    [authClient, apply, enterAuthenticated]
  );

  const acknowledgeRecoveryCodes = useCallback(() => {
    const current = stateRef.current;
    if (current.status === "recovery-codes") {
      apply({ status: "authenticated", session: current.session });
    }
  }, [apply]);

  const logout = useCallback(async () => {
    try {
      await authClient.logout();
    } catch {
      // Best-effort: clear local auth regardless of the network result.
    } finally {
      tokenRef.current = null;
      apply({ status: "signed-out" });
    }
  }, [authClient, apply]);

  const getAccessToken = useCallback(() => tokenRef.current, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      state,
      login,
      showForgotPassword,
      showSignIn,
      requestPasswordReset,
      confirmPasswordReset,
      changeRequiredPassword,
      startMfaEnrollment,
      confirmMfa,
      verifyMfa,
      verifyRecoveryCode,
      acknowledgeRecoveryCodes,
      logout,
      getAccessToken
    }),
    [
      state,
      login,
      showForgotPassword,
      showSignIn,
      requestPasswordReset,
      confirmPasswordReset,
      changeRequiredPassword,
      startMfaEnrollment,
      confirmMfa,
      verifyMfa,
      verifyRecoveryCode,
      acknowledgeRecoveryCodes,
      logout,
      getAccessToken
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (context === null) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
