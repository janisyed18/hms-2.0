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

    # Local object storage root for certificate PDFs and media (dev only).
    object_storage_dir: str = "./var/object-store"

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

    @property
    def effective_broker_url(self) -> str:
        return self.celery_broker_url or self.redis_url

    @property
    def effective_result_backend(self) -> str:
        return self.celery_result_backend or self.redis_url


settings = Settings()
