from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    app_name: str = "BAT Engineering HMS 2.0 API"
    environment: str = "local"
    database_url: str = "sqlite+aiosqlite:///./hms_dev.db"


settings = Settings()
