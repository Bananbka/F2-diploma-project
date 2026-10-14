ARG TARGET=production

# ─── Stage: deps ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps

WORKDIR /app

COPY package*.json ./

# `npm install`, not `npm ci`. esbuild and the Angular CLI ship platform-specific optional
# binaries, and a lockfile generated on Windows does not record the Linux variants, so `npm ci`
# fails here with "Missing: @esbuild/linux-x64 from lock file". Resolving fresh costs
# reproducibility but is what actually builds on a mixed-OS team.
#
# `--ignore-scripts`: this stage only has package*.json on disk yet (no `src/`, no `scripts/`),
# so the `postinstall` hook (copy-emoji.mjs / fetch-fonts.mjs) would fail outright trying to
# write into directories that don't exist here. The `build` stage's `COPY . .` below brings in
# the full tree — including the already-committed `public/fonts`/`src/styles/_fonts.scss` and
# emoji assets — and its `npm run build` auto-runs `prebuild`, which finds everything already
# present and no-ops. The `development` stage's `npm install` (its CMD, not this RUN) runs again
# at container start against the bind-mounted full source, so postinstall fires correctly there.
RUN npm install --ignore-scripts && npm cache clean --force

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
