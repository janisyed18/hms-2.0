#!/usr/bin/env bash
# Regenerate Python gRPC stubs from proto/certificate.proto.
# Requires the dev dependency group (grpcio-tools).
set -euo pipefail

cd "$(dirname "$0")/.."

OUT="src/hms_certificate/proto"
mkdir -p "$OUT"

python -m grpc_tools.protoc \
  -I proto \
  --python_out="$OUT" \
  --grpc_python_out="$OUT" \
  --pyi_out="$OUT" \
  proto/certificate.proto

# Make the generated grpc module import its pb2 sibling as a package-relative
# import so it works when installed.
python - "$OUT/certificate_pb2_grpc.py" <<'PY'
import re, sys
path = sys.argv[1]
text = open(path).read()
text = re.sub(
    r'^import certificate_pb2 as certificate__pb2',
    'from . import certificate_pb2 as certificate__pb2',
    text,
    flags=re.MULTILINE,
)
open(path, "w").write(text)
PY

echo "Regenerated stubs in $OUT"
