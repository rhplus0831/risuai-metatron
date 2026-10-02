# ------------------------------------------------------------------------------------------

FROM node:24-slim AS base
WORKDIR /app
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# Copy dependency-related file
COPY package.json .
COPY pnpm-lock.yaml .

RUN corepack enable
RUN corepack install --global pnpm@10.34.1

# ------------------------------------------------------------------------------------------

FROM base AS deps
# Install only prod deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod --frozen-lockfile

# ------------------------------------------------------------------------------------------

FROM deps AS builder
COPY . .
# Install including dev deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm build

# ------------------------------------------------------------------------------------------

FROM base AS runtime
WORKDIR /app

COPY package.json .
COPY --from=deps /app/node_modules /app/node_modules
COPY --from=builder /app/server ./server
COPY --from=builder /app/shared ./shared
COPY --from=builder /app/dist ./dist
# The server reads the app version from it (CBS `{{appver}}` in server-side scripts).
COPY --from=builder /app/version.json ./version.json

ENV NODE_ENV=production
EXPOSE 6001

# Node runs as PID 1 (not through pnpm) so SIGTERM reaches its graceful shutdown, which lets a
# running snapshot, restore, or import finish before the resource database closes.
CMD ["node", "server/src/main.ts"]

# ------------------------------------------------------------------------------------------
