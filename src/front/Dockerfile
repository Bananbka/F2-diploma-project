ARG TARGET=production

# ─── Stage: deps ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps

WORKDIR /app

COPY package*.json ./

# `npm install`, not `npm ci`. esbuild and the Angular CLI ship platform-specific optional
# binaries, and a lockfile generated on Windows does not record the Linux variants, so `npm ci`
# fails here with "Missing: @esbuild/linux-x64 from lock file". Resolving fresh costs
# reproducibility but is what actually builds on a mixed-OS team.
RUN npm install && npm cache clean --force

# ─── Stage: development ───────────────────────────────────────────────────────
FROM deps AS development

EXPOSE 4200

# --poll because bind-mounted volumes on Windows and macOS do not deliver inotify events.
CMD ["sh", "-c", "npm install && npm run start -- --host 0.0.0.0 --poll=1000"]

# ─── Stage: build ─────────────────────────────────────────────────────────────
FROM deps AS build

COPY . .

RUN npm run build -- --configuration production

# ─── Stage: production ────────────────────────────────────────────────────────
FROM nginx:alpine AS production

COPY --from=build /app/dist/messenger/browser/ /usr/share/nginx/html/

COPY nginx.conf /etc/nginx/conf.d/default.conf

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 80

ENTRYPOINT ["/entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
