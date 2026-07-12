import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { QRCodeSVG } from "qrcode.react";

import { useAuth } from "./AuthProvider";
import type { AuthState } from "./authTypes";
import { AuthLayout, estimatePasswordStrength, useAsyncAction } from "./authUi";

function messageOf(state: AuthState): string | undefined {
  return "message" in state ? state.message : undefined;
}

// --- Sign in --------------------------------------------------------------------

function LoginScreen({ message }: { message?: string }) {
  const { login } = useAuth();
  const { pending, run } = useAsyncAction();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  function submit(event: FormEvent) {
    event.preventDefault();
    void run(() => login(email, password));
  }

  return (
    <AuthLayout title="Sign in" subtitle="BAT Engineering HMS" error={message}>
      <form className="auth-form" onSubmit={submit}>
        <label className="auth-field">
          <span>Email</span>
          <input
            type="email"
            name="email"
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </label>
        <label className="auth-field">
          <span>Password</span>
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>
        <button
          className="primary-button auth-submit"
          type="submit"
          disabled={pending || !email.trim() || !password}
        >
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </AuthLayout>
  );
}

// --- Forced password change -----------------------------------------------------

function PasswordChangeScreen({ message }: { message?: string }) {
  const { changeRequiredPassword } = useAuth();
  const { pending, run } = useAsyncAction();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const strength = estimatePasswordStrength(password);
  const mismatch = confirm.length > 0 && confirm !== password;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (mismatch) {
      return;
    }
    void run(() => changeRequiredPassword(password));
  }

  return (
    <AuthLayout
      title="Choose a new password"
      subtitle="Your account requires a new password before continuing."
      error={message}
    >
      <form className="auth-form" onSubmit={submit}>
        <label className="auth-field">
          <span>New password</span>
          <input
            type="password"
            name="new-password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>
        <div className="auth-strength" aria-live="polite">
          Strength: <strong data-testid="strength">{strength.label}</strong>
        </div>
        <label className="auth-field">
          <span>Confirm password</span>
          <input
            type="password"
            name="confirm-password"
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            required
          />
        </label>
        {mismatch ? (
          <p className="auth-error" role="alert">
            Passwords do not match.
          </p>
        ) : null}
        <button
          className="primary-button auth-submit"
          type="submit"
          disabled={pending || !password || mismatch}
        >
          {pending ? "Saving…" : "Set password"}
        </button>
      </form>
    </AuthLayout>
  );
}

// --- MFA enrollment -------------------------------------------------------------

function MfaEnrollmentScreen({
  challenge,
  otpauthUri,
  manualKey,
  message
}: {
  challenge: string;
  otpauthUri?: string;
  manualKey?: string;
  message?: string;
}) {
  const { startMfaEnrollment, confirmMfa } = useAuth();
  const { pending, run } = useAsyncAction();
  const [code, setCode] = useState("");

  useEffect(() => {
    if (!otpauthUri) {
      void startMfaEnrollment();
    }
    // Only re-run when the challenge changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [challenge]);

  function submit(event: FormEvent) {
    event.preventDefault();
    void run(() => confirmMfa(code));
  }

  return (
    <AuthLayout
      title="Set up authenticator"
      subtitle="Scan the QR code with your authenticator app, then enter the 6-digit code."
      error={message}
    >
      {otpauthUri ? (
        <div className="auth-qr" data-testid="auth-qr">
          <QRCodeSVG value={otpauthUri} size={168} />
        </div>
      ) : (
        <p className="auth-subtitle">Preparing your enrollment…</p>
      )}
      {manualKey ? (
        <p className="auth-manual-key">
          Manual key: <code>{manualKey}</code>
        </p>
      ) : null}
      <form className="auth-form" onSubmit={submit}>
        <label className="auth-field">
          <span>Authentication code</span>
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(event) =>
              setCode(event.target.value.replace(/\D/g, ""))
            }
            required
          />
        </label>
        <button
          className="primary-button auth-submit"
          type="submit"
          disabled={pending || code.length !== 6 || !otpauthUri}
        >
          {pending ? "Verifying…" : "Verify & finish"}
        </button>
      </form>
    </AuthLayout>
  );
}

// --- MFA challenge (returning user) ---------------------------------------------

function MfaChallengeScreen({ message }: { message?: string }) {
  const { verifyMfa, verifyRecoveryCode } = useAuth();
  const { pending, run } = useAsyncAction();
  const [code, setCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);

  function submit(event: FormEvent) {
    event.preventDefault();
    void run(() =>
      useRecovery ? verifyRecoveryCode(code) : verifyMfa(code)
    );
  }

  return (
    <AuthLayout
      title="Two-factor authentication"
      subtitle={
        useRecovery
          ? "Enter one of your saved recovery codes."
          : "Enter the 6-digit code from your authenticator app."
      }
      error={message}
      footer={
        <button
          type="button"
          className="auth-link"
          onClick={() => {
            setUseRecovery((value) => !value);
            setCode("");
          }}
        >
          {useRecovery ? "Use authenticator app" : "Use a recovery code"}
        </button>
      }
    >
      <form className="auth-form" onSubmit={submit}>
        <label className="auth-field">
          <span>{useRecovery ? "Recovery code" : "Authentication code"}</span>
          <input
            inputMode={useRecovery ? "text" : "numeric"}
            autoComplete="one-time-code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            required
          />
        </label>
        <button
          className="primary-button auth-submit"
          type="submit"
          disabled={pending || !code.trim()}
        >
          {pending ? "Verifying…" : "Verify"}
        </button>
      </form>
    </AuthLayout>
  );
}

// --- Recovery codes (shown once) ------------------------------------------------

function RecoveryCodesScreen({ codes }: { codes: string[] }) {
  const { acknowledgeRecoveryCodes } = useAuth();
  const [acknowledged, setAcknowledged] = useState(false);

  function copy() {
    if (navigator.clipboard) {
      void navigator.clipboard.writeText(codes.join("\n"));
    }
  }

  return (
    <AuthLayout
      title="Save your recovery codes"
      subtitle="Store these somewhere safe. Each code works once if you lose your authenticator."
    >
      <ul className="auth-recovery-codes" data-testid="recovery-codes">
        {codes.map((code) => (
          <li key={code}>
            <code>{code}</code>
          </li>
        ))}
      </ul>
      <div className="auth-recovery-actions">
        <button type="button" className="secondary-button" onClick={copy}>
          Copy codes
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={() => window.print()}
        >
          Print
        </button>
      </div>
      <label className="auth-check">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.target.checked)}
        />
        <span>I have saved my recovery codes.</span>
      </label>
      <button
        className="primary-button auth-submit"
        type="button"
        disabled={!acknowledged}
        onClick={acknowledgeRecoveryCodes}
      >
        Continue to HMS
      </button>
    </AuthLayout>
  );
}

// --- Router ---------------------------------------------------------------------

export function AuthFlow({ children }: { children?: ReactNode }) {
  const { state } = useAuth();
  switch (state.status) {
    case "loading":
      return (
        <AuthLayout title="Loading…" subtitle="Restoring your session.">
          <div className="auth-loading" aria-label="Loading" />
        </AuthLayout>
      );
    case "authenticated":
      return <>{children}</>;
    case "password-change":
      return <PasswordChangeScreen message={messageOf(state)} />;
    case "mfa-enrollment":
      return (
        <MfaEnrollmentScreen
          challenge={state.challenge}
          otpauthUri={state.otpauthUri}
          manualKey={state.manualKey}
          message={messageOf(state)}
        />
      );
    case "mfa-challenge":
      return <MfaChallengeScreen message={messageOf(state)} />;
    case "recovery-codes":
      return <RecoveryCodesScreen codes={state.recoveryCodes} />;
    case "expired":
      return <LoginScreen message={state.message} />;
    case "signed-out":
    default:
      return <LoginScreen message={messageOf(state)} />;
  }
}
