# HMS 2.0 backend (FastAPI API + Celery worker share this image).
#
# Uses the base image's Python 3.12 directly (UV_PYTHON_DOWNLOADS=never) so the
# build never reaches out to GitHub for a managed interpreter.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_PYTHON_DOWNLOADS=never \
    UV_PYTHON_PREFERENCE=only-system \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/app/.venv \
    PATH="/app/.venv/bin:$PATH"

WORKDIR /app

# build-essential + libpq-dev cover any source builds (asyncpg, argon2, etc.);
# curl is used by the container healthcheck.
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential libpq-dev curl \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir uv

# Install dependencies first (cached layer), then the project.
# Not using --frozen: the committed uv.lock may lag pyproject, so we let uv
# resolve at build time (network is available during the image build). Refresh
# the committed lock on a Python 3.12 host with `uv lock`.
COPY pyproject.toml uv.lock* ./
RUN uv sync --no-dev --no-install-project

COPY . .
RUN uv sync --no-dev

EXPOSE 8000

# Default command runs the API; the worker service overrides `command` in compose.
CMD ["uvicorn", "hms_backend.app.main:app", "--host", "0.0.0.0", "--port", "8000"]
