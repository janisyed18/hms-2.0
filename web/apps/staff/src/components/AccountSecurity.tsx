import { KeyRound, ShieldCheck, Smartphone } from "lucide-react";

import type { StaffSession } from "../domain/types";

interface AccountSecurityProps {
  session: StaffSession;
  onSignOut?: () => void;
}

/**
 * Read-only account & security summary. Shows identity, role, customer scope, and
 * MFA state without ever displaying secret material. Password/MFA resets are
 * performed by an administrator (see Users & Roles), so this surface only guides.
 */
export function AccountSecurity({ session, onSignOut }: AccountSecurityProps) {
  return (
    <section className="detail-page" aria-label="Account and security">
      <div className="detail-page-title">
        <div>
          <h2>Account &amp; security</h2>
          <p>{session.displayName}</p>
        </div>
        {onSignOut ? (
          <button className="secondary-button" type="button" onClick={onSignOut}>
            Sign out
          </button>
        ) : null}
      </div>

      <section className="detail-section">
        <h3>Identity</h3>
        <dl className="info-grid">
          <div>
            <dt>User ID</dt>
            <dd>{session.userId}</dd>
          </div>
          <div>
            <dt>Roles</dt>
            <dd>{session.roles.join(", ")}</dd>
          </div>
          <div>
            <dt>Customer scope</dt>
            <dd>
              {session.customerIds.length > 0
                ? session.customerIds.join(", ")
                : "All customers"}
            </dd>
          </div>
          <div>
            <dt>Sign-in method</dt>
            <dd>{session.authMode}</dd>
          </div>
        </dl>
      </section>

      <section className="detail-section">
        <h3>Security</h3>
        <div className="stack-list">
          <article>
            <ShieldCheck aria-hidden="true" size={17} />
            <div>
              <strong>Multi-factor authentication</strong>
              <span>
                Required for staff sign-in. Reset via an administrator if you lose
                your authenticator.
              </span>
            </div>
          </article>
          <article>
            <KeyRound aria-hidden="true" size={17} />
            <div>
              <strong>Password</strong>
              <span>
                Your session expires after a period of inactivity; you may be asked
                to sign in again.
              </span>
            </div>
          </article>
          <article>
            <Smartphone aria-hidden="true" size={17} />
            <div>
              <strong>Recovery codes</strong>
              <span>
                Keep your saved recovery codes safe. Request new ones from an
                administrator if they run out.
              </span>
            </div>
          </article>
        </div>
      </section>
    </section>
  );
}
