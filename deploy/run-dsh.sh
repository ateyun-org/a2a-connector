#!/bin/sh
set -eu
# Private environment file belongs to the same OS user as the service.
set -a
. "$HOME/.config/a2a-connector/dsh.env"
set +a
: "${DSH_BINARY:?Set the absolute DSH executable path}"
: "${DSH_PROFILE:?Set the persistent DSH profile name}"
: "${DSH_WORKDIR:?Set the absolute task working directory}"
cd "$DSH_WORKDIR"
exec "$DSH_BINARY" --profile "$DSH_PROFILE"
