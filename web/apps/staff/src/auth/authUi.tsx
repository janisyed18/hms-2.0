import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode
} from "react";
import { ArrowLeft, Eye, EyeOff, LockKeyhole } from "lucide-react";
import { ZxcvbnFactory } from "@zxcvbn-ts/core";
import {
  adjacencyGraphs,
  dictionary
} from "@zxcvbn-ts/language-common";

const passwordEstimator = new ZxcvbnFactory({
  dictionary,
  graphs: adjacencyGraphs,
  useLevenshteinDistance: true
});

/** Run an async provider action while tracking a pending flag (unmount-safe). */
export function useAsyncAction(): {
  pending: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
} {
  const [pending, setPending] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = useCallback(async (fn: () => Promise<void>) => {
    setPending(true);
    try {
      await fn();
    } finally {
      if (mounted.current) {
        setPending(false);
      }
    }
  }, []);
  return { pending, run };
}

export interface PasswordStrength {
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
}

/**
 * Password-cracking-aware estimate for on-screen guidance only. The backend
 * password policy remains authoritative, so this never blocks submission.
 */
export function estimatePasswordStrength(password: string): PasswordStrength {
  if (!password) {
    return { score: 0, label: "Enter a password" };
  }
  const clamped = passwordEstimator.check(password).score as PasswordStrength["score"];
  const labels = ["Very weak", "Weak", "Fair", "Good", "Strong"];
  return { score: clamped, label: labels[clamped] };
}

interface AuthLayoutProps {
  title: string;
  subtitle?: string;
  error?: string;
  children: ReactNode;
  footer?: ReactNode;
  eyebrow?: string;
  backAction?: () => void;
  backLabel?: string;
}

interface PasswordFieldProps {
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: "current-password" | "new-password";
  describedBy?: string;
  required?: boolean;
}

export function PasswordField({
  label,
  name,
  value,
  onChange,
  autoComplete,
  describedBy,
  required = true
}: PasswordFieldProps) {
  const [visible, setVisible] = useState(false);
  const inputId = `auth-${name}`;

  return (
    <label className="auth-field" htmlFor={inputId}>
      <span>{label}</span>
      <span className="auth-password-control">
        <input
          id={inputId}
          type={visible ? "text" : "password"}
          name={name}
          autoComplete={autoComplete}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-describedby={describedBy}
          required={required}
        />
        <button
          type="button"
          className="auth-password-toggle"
          aria-label={visible ? "Hide password" : "Show password"}
          aria-pressed={visible}
          onClick={() => setVisible((current) => !current)}
        >
          {visible ? <EyeOff aria-hidden="true" size={18} /> : <Eye aria-hidden="true" size={18} />}
        </button>
      </span>
    </label>
  );
}

export function AuthLayout({
  title,
  subtitle,
  error,
  children,
  footer,
  eyebrow = "Secure operations workspace",
  backAction,
  backLabel = "Back to sign in"
}: AuthLayoutProps) {
  return (
    <div className="auth-shell">
      <header className="auth-brand">
        <span className="auth-brand-logo-frame">
          <img alt="Momentum" className="auth-brand-logo" height="500" width="500"
            src={`${import.meta.env.BASE_URL}brand/momentum-logo.png`} />
        </span>
        <span className="auth-brand-product-label">Hose Management System</span>
      </header>
      <div className="auth-gateway">
        <main className="auth-card">
          {backAction ? (
            <button type="button" className="auth-back" onClick={backAction}>
              <ArrowLeft aria-hidden="true" size={16} /> {backLabel}
            </button>
          ) : null}
          <div className="auth-heading">
            <p className="auth-eyebrow">{eyebrow}</p>
            <h1 className="auth-title">{title}</h1>
            {subtitle ? <p className="auth-subtitle">{subtitle}</p> : null}
          </div>
          {error ? (
            <p className="auth-error" role="alert">
              {error}
            </p>
          ) : null}
          {children}
          {footer ? <div className="auth-footer">{footer}</div> : null}
        </main>
      </div>
      <footer className="auth-trust-note">
        <LockKeyhole aria-hidden="true" size={14} />
        <span>Authorised access only</span>
      </footer>
    </div>
  );
}
