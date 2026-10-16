import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode
} from "react";
import { KeyRound, LogOut, ShieldCheck } from "lucide-react";

import {
  BrowserAuthError,
  createBrowserAuthClient,
  type BrowserAuthClient,
  type BrowserAuthenticatedResponse,
  type BrowserChallengeResponse,
  type BrowserRecoveryCodesResponse
} from "./browserAuthClient";
import { configureSyncRuntimeAuth } from "../api/syncClient";

export type { BrowserAuthClient } from "./browserAuthClient";

type AuthState =
  | { status: "signed-out"; message?: string }
  | { status: "forgot-password"; message?: string }
  | { status: "reset-sent"; message?: string }
  | { status: "password-change"; challenge: string; message?: string }
  | { status: "mfa-enrollment"; challenge: string; manualKey?: string; message?: string }
  | { status: "mfa-challenge"; challenge: string; recovery: boolean; message?: string }
  | { status: "recovery-codes"; recoveryCodes: string[] }
  | { status: "authenticated" }
  | { status: "access-denied" };

interface InspectorAuthGateProps {
  children: ReactNode;
  client?: BrowserAuthClient;
  /** Test-only seam. Production authentication always begins with refresh/login. */
  initialAccessToken?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof BrowserAuthError
    ? error.message
    : "Something went wrong. Please try again.";
}

function isAuthenticated(
  response: BrowserChallengeResponse | BrowserAuthenticatedResponse
): response is BrowserAuthenticatedResponse {
  return response.next_step === "AUTHENTICATED";
}

function authState(response: BrowserChallengeResponse): AuthState {
  if (response.next_step === "PASSWORD_CHANGE_REQUIRED") {
    return { status: "password-change", challenge: response.challenge };
  }
  if (response.next_step === "MFA_ENROLLMENT_REQUIRED") {
    return { status: "mfa-enrollment", challenge: response.challenge };
  }
  return { status: "mfa-challenge", challenge: response.challenge, recovery: false };
}

function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="inspector-auth" aria-live="polite">
      <section className="inspector-auth__panel">
        <div className="inspector-auth__brand">
          <img alt="Momentum" src="/brand/momentum-logo.png" />
          <span>Hose Management System</span>
        </div>
        {children}
      </section>
    </main>
  );
}

function Message({ children }: { children?: string }) {
  return children ? <p className="inspector-auth__message" role="alert">{children}</p> : null;
}

export function InspectorAuthGate({
  children,
  client: suppliedClient,
  initialAccessToken
}: InspectorAuthGateProps) {
  const client = useMemo(() => suppliedClient ?? createBrowserAuthClient(), [suppliedClient]);
  const [state, setState] = useState<AuthState>({ status: "signed-out" });
  const tokenRef = useRef<string | null>(null);
  const refreshInFlight = useRef<Promise<string> | null>(null);

  const signOut = useCallback((message?: string) => {
    tokenRef.current = null;
    setState({ status: "signed-out", message });
  }, []);

  const refreshAccessToken = useCallback(async () => {
    if (refreshInFlight.current) {
      return refreshInFlight.current;
    }
    const refresh = client
      .refresh()
      .then((response) => {
        tokenRef.current = response.access_token;
        return response.access_token;
      })
      .finally(() => {
        refreshInFlight.current = null;
      });
    refreshInFlight.current = refresh;
    return refresh;
  }, [client]);

  const enterAuthenticated = useCallback(
    async (accessToken: string, recoveryCodes?: string[]) => {
      tokenRef.current = accessToken;
      const profile = await client.me(accessToken);
      if (!profile.roles.includes("INSPECTOR")) {
        tokenRef.current = null;
        void client.logout();
        setState({ status: "access-denied" });
        return;
      }
      setState(
        recoveryCodes
          ? { status: "recovery-codes", recoveryCodes }
          : { status: "authenticated" }
      );
    },
    [client]
  );

  useEffect(() => {
    return configureSyncRuntimeAuth({
      getAccessToken: () => tokenRef.current,
      refreshAccessToken,
      onAuthFailure: () => signOut("Your session has expired. Please sign in again.")
    });
  }, [refreshAccessToken, signOut]);

  useEffect(() => {
    let active = true;
    if (initialAccessToken) {
      tokenRef.current = initialAccessToken;
      setState({ status: "authenticated" });
      return () => {
        active = false;
      };
    }
    void refreshAccessToken()
      .then((accessToken) => {
        if (active) {
          return enterAuthenticated(accessToken);
        }
      })
      .catch(() => {
        if (active) {
          signOut();
        }
      });
    return () => {
      active = false;
    };
  }, [enterAuthenticated, initialAccessToken, refreshAccessToken, signOut]);

  const login = useCallback(async (email: string, password: string) => {
    try {
      const response = await client.login(email, password);
      if (isAuthenticated(response)) {
        await enterAuthenticated(response.access_token);
      } else {
        setState(authState(response));
      }
    } catch (error) {
      signOut(errorMessage(error));
    }
  }, [client, enterAuthenticated, signOut]);

  const changePassword = useCallback(async (challenge: string, password: string) => {
    try {
      const response = await client.changePassword(challenge, password);
      if (isAuthenticated(response)) {
        await enterAuthenticated(response.access_token);
      } else {
        setState(authState(response));
      }
    } catch (error) {
      setState({ status: "password-change", challenge, message: errorMessage(error) });
    }
  }, [client, enterAuthenticated]);

  const beginEnrollment = useCallback(async (challenge: string) => {
    try {
      const enrollment = await client.startEnrollment(challenge);
      setState({
        status: "mfa-enrollment",
        challenge,
        manualKey: enrollment.manual_key
      });
    } catch (error) {
      setState({ status: "mfa-enrollment", challenge, message: errorMessage(error) });
    }
  }, [client]);

  const confirmEnrollment = useCallback(async (challenge: string, code: string) => {
    try {
      const response: BrowserRecoveryCodesResponse = await client.confirmMfa(challenge, code);
      await enterAuthenticated(response.access_token, response.recovery_codes);
    } catch (error) {
      setState({ status: "mfa-enrollment", challenge, message: errorMessage(error) });
    }
  }, [client, enterAuthenticated]);

  const verifyMfa = useCallback(async (challenge: string, code: string, recovery: boolean) => {
    try {
      const response = recovery
        ? await client.verifyRecovery(challenge, code)
        : await client.verifyMfa(challenge, code);
      await enterAuthenticated(response.access_token);
    } catch (error) {
      setState({ status: "mfa-challenge", challenge, recovery, message: errorMessage(error) });
    }
  }, [client, enterAuthenticated]);

  const requestPasswordReset = useCallback(async (email: string) => {
    try {
      const response = await client.requestPasswordReset(email);
      setState({ status: "reset-sent", message: response.message });
    } catch (error) {
      setState({ status: "forgot-password", message: errorMessage(error) });
    }
  }, [client]);

  const logout = useCallback(async () => {
    try {
      await client.logout();
    } finally {
      signOut();
    }
  }, [client, signOut]);

  if (state.status === "authenticated") {
    return <>{children}</>;
  }

  if (state.status === "access-denied") {
    return (
      <AuthLayout>
        <ShieldCheck aria-hidden="true" className="inspector-auth__icon" size={28} />
        <p className="inspector-auth__eyebrow">Inspector workspace</p>
        <h1>Inspector access required</h1>
        <p>Your account is not assigned the Inspector role.</p>
        <button className="inspector-auth__button" onClick={() => void logout()} type="button">
          <LogOut aria-hidden="true" size={17} /> Sign out
        </button>
      </AuthLayout>
    );
  }

  if (state.status === "forgot-password") {
    return <EmailForm title="Reset your password" action="Send reset link" message={state.message} onSubmit={requestPasswordReset} onBack={() => signOut()} />;
  }

  if (state.status === "reset-sent") {
    return (
      <AuthLayout>
        <p className="inspector-auth__eyebrow">Inspector workspace</p>
        <h1>Check your inbox</h1>
        <p>{state.message ?? "If the account exists, a password reset link is on its way."}</p>
        <button className="inspector-auth__button" onClick={() => signOut()} type="button">Return to sign in</button>
      </AuthLayout>
    );
  }

  if (state.status === "password-change") {
    return <PasswordForm title="Set a new password" action="Save password" message={state.message} onSubmit={(password) => changePassword(state.challenge, password)} />;
  }

  if (state.status === "mfa-enrollment") {
    return <EnrollmentForm state={state} onBegin={beginEnrollment} onConfirm={confirmEnrollment} />;
  }

  if (state.status === "mfa-challenge") {
    return <MfaForm state={state} onVerify={verifyMfa} onToggleRecovery={() => setState({ ...state, recovery: !state.recovery })} />;
  }

  if (state.status === "recovery-codes") {
    return (
      <AuthLayout>
        <p className="inspector-auth__eyebrow">Inspector workspace</p>
        <h1>Save your recovery codes</h1>
        <p>Store these codes in a secure password manager. Each code can be used once.</p>
        <ul className="inspector-auth__codes">
          {state.recoveryCodes.map((code) => <li key={code}>{code}</li>)}
        </ul>
        <button className="inspector-auth__button" onClick={() => setState({ status: "authenticated" })} type="button">I saved these codes</button>
      </AuthLayout>
    );
  }

  return <LoginForm message={state.message} onLogin={login} onForgot={() => setState({ status: "forgot-password" })} />;
}

function LoginForm({ message, onLogin, onForgot }: { message?: string; onLogin: (email: string, password: string) => Promise<void>; onForgot: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    await onLogin(email, password);
    setPending(false);
  }
  return <AuthLayout><KeyRound aria-hidden="true" className="inspector-auth__icon" size={28} /><p className="inspector-auth__eyebrow">Inspector workspace</p><h1>Inspector sign in</h1><p>Use your Momentum HMS account to access assigned field work.</p><Message>{message}</Message><form className="inspector-auth__form" onSubmit={submit}><label>Email<input autoComplete="username" onChange={(event) => setEmail(event.target.value)} required type="email" value={email} /></label><label>Password<input autoComplete="current-password" onChange={(event) => setPassword(event.target.value)} required type="password" value={password} /></label><button className="inspector-auth__button" disabled={pending} type="submit">{pending ? "Signing in…" : "Sign in"}</button></form><button className="inspector-auth__link" onClick={onForgot} type="button">Forgot password?</button></AuthLayout>;
}

function EmailForm({ title, action, message, onSubmit, onBack }: { title: string; action: string; message?: string; onSubmit: (email: string) => Promise<void>; onBack: () => void }) {
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  async function submit(event: FormEvent) { event.preventDefault(); setPending(true); await onSubmit(email); setPending(false); }
  return <AuthLayout><p className="inspector-auth__eyebrow">Inspector workspace</p><h1>{title}</h1><p>Enter your work email to receive a one-time reset link.</p><Message>{message}</Message><form className="inspector-auth__form" onSubmit={submit}><label>Email<input autoComplete="email" onChange={(event) => setEmail(event.target.value)} required type="email" value={email} /></label><button className="inspector-auth__button" disabled={pending} type="submit">{pending ? "Sending…" : action}</button></form><button className="inspector-auth__link" onClick={onBack} type="button">Back to sign in</button></AuthLayout>;
}

function PasswordForm({ title, action, message, onSubmit }: { title: string; action: string; message?: string; onSubmit: (password: string) => Promise<void> }) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const mismatch = Boolean(confirmation) && password !== confirmation;
  async function submit(event: FormEvent) { event.preventDefault(); if (mismatch) return; setPending(true); await onSubmit(password); setPending(false); }
  return <AuthLayout><p className="inspector-auth__eyebrow">Inspector workspace</p><h1>{title}</h1><Message>{message}</Message><form className="inspector-auth__form" onSubmit={submit}><label>New password<input autoComplete="new-password" onChange={(event) => setPassword(event.target.value)} required type="password" value={password} /></label><label>Confirm password<input autoComplete="new-password" onChange={(event) => setConfirmation(event.target.value)} required type="password" value={confirmation} /></label>{mismatch ? <Message>Passwords do not match.</Message> : null}<button className="inspector-auth__button" disabled={pending || mismatch} type="submit">{pending ? "Saving…" : action}</button></form></AuthLayout>;
}

function EnrollmentForm({ state, onBegin, onConfirm }: { state: Extract<AuthState, { status: "mfa-enrollment" }>; onBegin: (challenge: string) => Promise<void>; onConfirm: (challenge: string, code: string) => Promise<void> }) {
  const [code, setCode] = useState("");
  useEffect(() => { if (!state.manualKey) void onBegin(state.challenge); }, [onBegin, state.challenge, state.manualKey]);
  return <AuthLayout><p className="inspector-auth__eyebrow">Inspector workspace</p><h1>Set up authenticator</h1><p>Add this manual key to your authenticator application, then enter the six-digit code.</p>{state.manualKey ? <code className="inspector-auth__manual-key">{state.manualKey}</code> : <p>Preparing enrollment…</p>}<Message>{state.message}</Message><form className="inspector-auth__form" onSubmit={(event) => { event.preventDefault(); void onConfirm(state.challenge, code); }}><label>Authentication code<input autoComplete="one-time-code" inputMode="numeric" maxLength={6} onChange={(event) => setCode(event.target.value)} required value={code} /></label><button className="inspector-auth__button" type="submit">Verify authenticator</button></form></AuthLayout>;
}

function MfaForm({ state, onVerify, onToggleRecovery }: { state: Extract<AuthState, { status: "mfa-challenge" }>; onVerify: (challenge: string, code: string, recovery: boolean) => Promise<void>; onToggleRecovery: () => void }) {
  const [code, setCode] = useState("");
  return <AuthLayout><p className="inspector-auth__eyebrow">Inspector workspace</p><h1>Verify your sign in</h1><p>{state.recovery ? "Enter one of your recovery codes." : "Enter the code from your authenticator application."}</p><Message>{state.message}</Message><form className="inspector-auth__form" onSubmit={(event) => { event.preventDefault(); void onVerify(state.challenge, code, state.recovery); }}><label>{state.recovery ? "Recovery code" : "Authentication code"}<input autoComplete={state.recovery ? "off" : "one-time-code"} inputMode={state.recovery ? "text" : "numeric"} onChange={(event) => setCode(event.target.value)} required value={code} /></label><button className="inspector-auth__button" type="submit">Verify</button></form><button className="inspector-auth__link" onClick={() => { setCode(""); onToggleRecovery(); }} type="button">Use {state.recovery ? "authenticator code" : "recovery code"}</button></AuthLayout>;
}
