# HMS 2.0 certificate engine (gRPC).
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HMS_CERT_HOST=0.0.0.0 \
    HMS_CERT_PORT=50051

WORKDIR /app

# build-essential for any source builds; fonts-dejavu-core lets ReportLab embed
# TrueType fonts (a prerequisite for archival/PDF-A output).
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

# The generated proto stubs are committed under src/, so a plain install works.
COPY pyproject.toml README.md ./
COPY proto ./proto
COPY src ./src
RUN pip install --no-cache-dir .

EXPOSE 50051

# Dev signing material is auto-generated on first run under this path.
VOLUME ["/root/.hms"]

CMD ["hms-certificate-engine"]
