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
    object_storage_backend: Literal["local", "s3"] = "local"
    object_storage_dir: str = "./var/object-store"
    object_storage_s3_bucket: str = ""
    object_storage_s3_prefix: str = ""
    object_storage_s3_region: str = ""

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
    # "console" logs messages (dev default); "live" uses SMTP + Twilio.
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

    # Email (OCI Email Delivery via SMTP) — only used in "live" mode.
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_username: str = ""
    smtp_password: str = ""
    smtp_use_tls: bool = True
    email_from_address: str = "no-reply@batengineering.example"

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

    # External OIDC provider (oidc mode). JWKS is discovered from the issuer's
    # ``/.well-known/openid-configuration`` unless a JWKS URL is given directly.
    auth_oidc_issuer: str = ""
    auth_oidc_audience: str = ""
    auth_oidc_jwks_url: str = ""
    auth_oidc_jwks_cache_seconds: int = 3600
    # If true, a valid token for an unknown subject provisions a User row (JIT).
    # Off by default: subjects must be provisioned by an admin first.
    auth_oidc_jit_provisioning: bool = False

    @property
    def effective_broker_url(self) -> str:
        return self.celery_broker_url or self.redis_url

    @property
    def effective_result_backend(self) -> str:
        return self.celery_result_backend or self.redis_url


settings = Settings()
