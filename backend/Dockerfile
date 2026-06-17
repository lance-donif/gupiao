# syntax=docker/dockerfile:1
FROM oven/bun:1 AS base
WORKDIR /app

# Stage 1: install dependencies (cached unless package.json changes)
FROM base AS install
COPY package.json ./
RUN bun install --frozen-lockfile

# Stage 2: build TypeScript (cached unless source/prisma change)
FROM base AS build
COPY --from=install /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY prisma ./prisma
COPY src ./src
COPY scripts ./scripts
RUN bunx prisma generate && bun run build

# Stage 3: minimal runtime
FROM base AS runtime
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/package.json ./
COPY --from=build /app/src/http ./src/http
COPY --from=build /app/scripts ./scripts
# Install system shared libraries required by Chromium (libglib, libnss, etc.)
# and then install the browser using the exact playwright version in node_modules.
RUN bunx playwright install-deps chromium && \
    bunx playwright install chromium

ENV PORT=8000
ENV HOST=0.0.0.0
EXPOSE 8000

CMD ["bun", "dist/src/http/server.js"]
