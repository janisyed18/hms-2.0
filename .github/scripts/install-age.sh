#!/usr/bin/env bash
set -euo pipefail

AGE_VERSION="1.2.1"
AGE_ARCHIVE_SHA256="7df45a6cc87d4da11cc03a539a7470c15b1041ab2b396af088fe9990f7c79d50"

case "${RUNNER_ARCH:-}" in
  X64) ;;
  *)
    echo "This release workflow supports only GitHub's Linux X64 runner." >&2
    exit 1
    ;;
esac

install_dir="${RUNNER_TEMP:?RUNNER_TEMP must be set}/age-${AGE_VERSION}-linux-amd64"
archive="${RUNNER_TEMP}/age-v${AGE_VERSION}-linux-amd64.tar.gz"

mkdir -p "$install_dir"
curl --fail --location --proto '=https' --tlsv1.2 --retry 3 \
  --output "$archive" \
  "https://github.com/FiloSottile/age/releases/download/v${AGE_VERSION}/age-v${AGE_VERSION}-linux-amd64.tar.gz"
printf '%s  %s\n' "$AGE_ARCHIVE_SHA256" "$archive" | sha256sum --check --status
tar --extract --gzip --file "$archive" --directory "$install_dir" --strip-components=1

test -x "$install_dir/age"
test -x "$install_dir/age-keygen"
"$install_dir/age" --version
printf '%s\n' "$install_dir" >> "$GITHUB_PATH"
