# HMS 2.0 certificate engine (gRPC).
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HOME=/var/run/hms \
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
RUN pip install --no-cache-dir . \
    && groupadd --system hms \
    && useradd --system --gid hms --home-dir /var/lib/hms hms \
    && install -d --owner=hms --group=hms /var/lib/hms/.hms /var/run/hms

EXPOSE 50051

USER hms

CMD ["hms-certificate-engine"]
