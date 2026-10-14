FROM nginx:alpine

# This container only routes — no Angular build step, no application code. It is the single
# published entry point and reverse-proxies to the frontend, api and rustfs services over the
# compose network.

COPY nginx.conf /etc/nginx/conf.d/default.conf
# Included from default.conf, and from every location in it that sets a header of its own —
# nginx `add_header` does not inherit into a block that declares any.
COPY security-headers.conf /etc/nginx/security-headers.conf

EXPOSE 80
