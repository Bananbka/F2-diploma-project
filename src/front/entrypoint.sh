#!/bin/sh
set -e

CONFIG_PATH="/usr/share/nginx/html/config.json"

# Runtime config so one image can target different backends without a rebuild. A mounted file
# always wins, so an operator can override without touching the image.
if [ -f "$CONFIG_PATH" ] && [ -s "$CONFIG_PATH" ]; then
    echo "Existing config.json found; skipping generation."
else
    echo "Generating config.json..."
    cat <<EOF > "$CONFIG_PATH"
{
  "apiUrl": "${API_URL:-/api/}",
  "wsUrl": "${WS_URL:-/ws}"
}
EOF
    cat "$CONFIG_PATH"
fi

exec "$@"
