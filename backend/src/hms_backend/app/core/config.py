import base64
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    app_name: str = "BAT Engineering HMS 2.0 API"
    environment: str = "local"
    database_url: str = "sqlite+aiosqlite:///./hms_dev.db"

    # Public base URL used to build certificate verification links (QR codes).
    public_base_url: str = "http://127.0.0.1:8000"

    # gRPC address of the certificate engine (services/certificate).
    certificate_service_address: str = "127.0.0.1:50051"
    certificate_service_timeout_seconds: float = 30.0

    # Object storage for certificate PDFs and media.
    #   local - filesystem-backed store (dev/single-node; not multi-task safe)
    #   s3    - Amazon S3 (multi-task safe; required for ECS/Fargate)
    object_storage_backend: Literal["local", "s3"] = "local"
    # Local backend root (dev only).
    object_storage_dir: str = "./var/object-store"
    # S3 backend. Credentials come from the environment/instance/task role
    # (never static keys in config). Region/endpoint are optional — boto3
    # resolves them from the standard AWS chain when blank.
    object_storage_s3_bucket: str = ""
    object_storage_s3_region: str = ""
    object_storage_s3_endpoint_url: str = ""  # e.g. LocalStack/MinIO
    object_storage_s3_prefix: str = ""  # optional prefix namespacing keys
    object_storage_s3_presign_expiry_seconds: int = 900
    # Server-side encryption applied on upload ("AES256" or "aws:kms"; blank off).
    object_storage_s3_sse: str = "AES256"
    object_storage_s3_sse_kms_key_id: str = ""  # required when using aws:kms

    # Issuer identity stamped onto certificates (mirrors the engine defaults).
    issuer_name: str = "BAT Engineering Pty Ltd"
    issuer_identifier: str = "ABN 00 000 000 000"

    # Redis (cache + Celery broker/backend).
    redis_url: str = "redis://127.0.0.1:6379/0"
    redis_connect_timeout_seconds: float = 0.5
    redis_command_timeout_seconds: float = 0.5
    # Cache-aside layer. Degrades gracefully: if Redis is unreachable the app
    # still serves from the database.
    cache_enabled: bool = True
    cache_ttl_seconds: int = 300
    # After a Redis failure, skip cache attempts for this long (circuit breaker)
    # so a Redis outage never adds latency to every request.
    cache_circuit_breaker_seconds: float = 30.0

    celery_broker_url: str = ""
    celery_result_backend: str = ""
    # When true, tasks run inline in the caller (no worker/broker needed) — used
    # by tests and simple local setups.
    celery_task_always_eager: bool = False
    # Max inspections a single bulk-generation request may target.
    bulk_certificate_max_items: int = 1000

    # --- Notifications (spec: Notifications & Alerting) ---
    notifications_enabled: bool = True
    # "console" logs messages (dev default); "live" uses email + Twilio.
    notification_channel_mode: str = "console"
    notification_sender_name: str = "BAT Engineering"
    notification_max_attempts: int = 5
    notification_retry_backoff_seconds: int = 60
    # Reminder cadence (days). Advance before due; escalation after overdue;
    # approaching-condemnation before the grave date.
    retest_advance_days: list[int] = Field(default_factory=lambda: [30, 14])
    retest_overdue_escalation_days: list[int] = Field(
        default_factory=lambda: [7, 14, 30]
    )
    condemnation_advance_days: list[int] = Field(default_factory=lambda: [60, 30])
    phone_verification_ttl_seconds: int = 600
    phone_verification_max_attempts: int = 5
    # Shared secret gating provider delivery webhooks (Twilio status callbacks,
    # SES/SNS delivery/bounce notifications). Empty = open (dev only).
    notification_webhook_secret: str = ""

    # Email — only used in "live" mode.
    notification_email_provider: Literal["smtp", "aws_ses"] = "smtp"
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_username: str = ""
    smtp_password: str = ""
    smtp_use_tls: bool = True
    email_from_address: str = "no-reply@batengineering.example"
    notification_ses_region: str = ""
    notification_ses_configuration_set: str = ""

    # SMS (Twilio) — only used in "live" mode.
    twilio_account_sid: str = ""
    twilio_auth_token: str = ""
    twilio_from: str = ""  # E.164 number or alphanumeric sender ID

    # Auth boundary. Local development keeps explicit HMS headers available;
    # deployed environments should use bearer mode and resolve the token subject
    # against persisted HMS users.
    #   dev    - X-HMS-* headers (local only)
    #   bearer - locally issued HS256 tokens (Argon2 password login)
    #   oidc   - RS256/ES256 tokens from an external IdP (Keycloak / OCI IDs)
    auth_mode: Literal["dev", "bearer", "oidc"] = "dev"
    auth_dev_headers_enabled: bool = True
    auth_dev_allow_role_fallback: bool = True
    auth_token_leeway_seconds: int = 60

    # Local HS256 tokens (bearer mode + Argon2 login output).
    auth_bearer_hmac_secret: str = ""
    auth_bearer_issuer: str | None = None
    auth_bearer_audience: str | None = None
    auth_access_token_ttl_seconds: int = 3600
    auth_password_login_enabled: bool = True
    auth_password_reset_ttl_seconds: int = 900
    auth_password_reset_key_version: int = 1
    auth_password_reset_keys: dict[int, str] = Field(default_factory=dict)
    auth_password_reset_delivery_max_attempts: int = 5
    auth_password_reset_delivery_retry_seconds: int = 60
    staff_web_public_url: str = "http://127.0.0.1:8080"

    # External OIDC provider (oidc mode). JWKS is discovered from the issuer's
    # ``/.well-known/openid-configuration`` unless a JWKS URL is given directly.
    auth_oidc_issuer: str = ""
    auth_oidc_audience: str = ""
    auth_oidc_jwks_url: str = ""
    auth_oidc_jwks_cache_seconds: int = 3600
    # If true, a valid token for an unknown subject provisions a User row (JIT).
    # Off by default: subjects must be provisioned by an admin first.
    auth_oidc_jit_provisioning: bool = False

    # --- Staff browser authentication (Task 2+) ---
    # Separate contract from the native bearer login: multi-role browser sign-in
    # with forced password change, TOTP MFA, and rotating refresh cookies.
    auth_browser_login_enabled: bool = False
    # Password policy bounds (Unicode code points; no truncation).
    auth_password_min_length: int = 12
    auth_password_max_length: int = 128
    # TOTP secrets are AES-256-GCM encrypted at rest. Key is base64/urlsafe of a
    # 32-byte key; versioned so keys can be rotated without re-enrolling everyone.
    auth_mfa_encryption_key: str = ""
    auth_mfa_encryption_keys: dict[int, str] = Field(default_factory=dict)
    auth_mfa_key_version: int = 1
    auth_totp_issuer: str = "BAT Engineering HMS"
    # Recovery codes are stored only as HMAC digests keyed by this pepper.
    auth_recovery_code_pepper: str = ""
    # Challenge / session lifetimes (seconds).
    auth_browser_challenge_ttl_seconds: int = 600
    auth_browser_access_ttl_seconds: int = 900
    auth_browser_refresh_idle_ttl_seconds: int = 60 * 60 * 8
    auth_browser_refresh_absolute_ttl_seconds: int = 60 * 60 * 24 * 30
    # Refresh cookie attributes.
    auth_browser_cookie_name: str = "hms_staff_refresh"
    auth_browser_cookie_path: str = "/api/v1/auth/browser"
    auth_browser_cookie_secure: bool = True
    # Exact origins allowed to call refresh/logout (CSRF hardening).
    auth_browser_allowed_origins: list[str] = Field(default_factory=list)
    # Recent-auth window (seconds) required for privileged admin actions.
    auth_browser_reauth_max_age_seconds: int = 300
    # Max verification attempts against a single challenge before it is rejected.
    auth_browser_challenge_max_attempts: int = 5
    # Login throttling (per normalised account and per source IP, independently).
    auth_login_rate_limit_max_attempts: int = 5
    auth_login_rate_limit_window_seconds: int = 300
    auth_login_lockout_seconds: int = 60

    @property
    def is_local_or_test(self) -> bool:
        return self.environment.lower() in {"local", "test", "development"}

    def browser_auth_config_errors(self) -> list[str]:
        """Return blocking misconfigurations for deployed browser login.

        Empty in local/test, or when browser login is disabled. Used by the app
        startup validator so a broken auth configuration fails fast instead of
        serving a login that cannot issue or verify sessions.
        """
        if not self.auth_browser_login_enabled or self.is_local_or_test:
            return []
        errors: list[str] = []
        if not self.auth_bearer_hmac_secret:
            errors.append("AUTH_BEARER_HMAC_SECRET is required")
        if (
            not self.auth_mfa_encryption_key
            and self.auth_mfa_key_version not in self.auth_mfa_encryption_keys
        ):
            errors.append("AUTH_MFA_ENCRYPTION_KEY is required")
        elif not all(
            _decodes_to_32_bytes(value)
            for value in [
                *self.auth_mfa_encryption_keys.values(),
                *(
                    [self.auth_mfa_encryption_key]
                    if self.auth_mfa_encryption_key
                    else []
                ),
            ]
        ):
            errors.append("AUTH_MFA_ENCRYPTION_KEY values must decode to 32 bytes")
        if not self.auth_recovery_code_pepper:
            errors.append("AUTH_RECOVERY_CODE_PEPPER is required")
        if not self.auth_browser_allowed_origins:
            errors.append("AUTH_BROWSER_ALLOWED_ORIGINS must list the staff origin")
        if not self.auth_browser_cookie_secure:
            errors.append("AUTH_BROWSER_COOKIE_SECURE must be true when deployed")
        return errors

    def validate_browser_auth(self) -> None:
        errors = self.browser_auth_config_errors()
        if errors:
            raise RuntimeError(
                "Invalid browser auth configuration: " + "; ".join(errors)
            )

    @property
    def effective_broker_url(self) -> str:
        return self.celery_broker_url or self.redis_url

    @property
    def effective_result_backend(self) -> str:
        return self.celery_result_backend or self.redis_url


settings = Settings()


def _decodes_to_32_bytes(raw: str) -> bool:
    padded = raw + "=" * (-len(raw) % 4)
    candidates: list[bytes] = []
    for decoder in (base64.urlsafe_b64decode, base64.b64decode):
        try:
            candidates.append(decoder(padded))
        except ValueError:
            pass
    try:
        candidates.append(bytes.fromhex(raw))
    except ValueError:
        pass
    return any(len(candidate) == 32 for candidate in candidates)
