import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode
} from "react";
import { ShieldCheck } from "lucide-react";
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
  useEffect(
    () => () => {
      mounted.current = false;
    },
    []
  );
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
}

export function AuthLayout({
  title,
  subtitle,
  error,
  children,
  footer
}: AuthLayoutProps) {
  return (
    <div className="auth-shell">
      <div className="auth-card" role="dialog" aria-label={title}>
        <div className="auth-brand">
          <span className="brand-shield">
            <ShieldCheck aria-hidden="true" size={20} />
          </span>
          <div>
            <strong>BAT HMS</strong>
            <span>v2.0</span>
          </div>
        </div>
        <h1 className="auth-title">{title}</h1>
        {subtitle ? <p className="auth-subtitle">{subtitle}</p> : null}
        {error ? (
          <p className="auth-error" role="alert">
            {error}
          </p>
        ) : null}
        {children}
        {footer ? <div className="auth-footer">{footer}</div> : null}
      </div>
    </div>
  );
}
