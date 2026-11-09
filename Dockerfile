# Multi-stage build. This is the containerisation lesson of the project made
# explicit: build with the full toolchain, then copy ONLY the compiled output
# and production dependencies into a slim runtime image. The final image never
# contains TypeScript, dev dependencies, or source — just what's needed to run.
#
# Go would give you a tiny image by default; with Node you do this deliberately,
# which is arguably more instructive. A naive single-stage Node image easily
# hits 1GB+; this keeps it small, which matters at every pull.

# ---- builder ---------------------------------------------------------------
FROM node:22-slim AS builder
WORKDIR /app

# Copy manifests first so this layer is cached unless deps change.
COPY package.json package-lock.json* ./
# NOTE: `npm ci` is the reproducible-build pattern and is what you WANT here —
# but it requires a committed package-lock.json. 
# run `npm install` locally to produce the package-lock.json file, 
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies so we can copy a production-only node_modules across.
RUN npm prune --omit=dev

# ---- runtime ---------------------------------------------------------------
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Run as the non-root 'node' user that the base image ships with.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

USER node
EXPOSE 3000

# Liveness check baked into the image (compose/other tooling can use it).
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
