FROM oven/bun:1 AS base
WORKDIR /app

FROM base AS install
COPY package.json ./
RUN bun install

FROM base AS build
COPY --from=install /app/node_modules ./node_modules
COPY package.json ./
COPY prisma ./prisma
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN bunx prisma generate && bun run build

FROM base AS runtime
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY src/http ./src/http
COPY package.json ./
RUN bunx playwright@1.60.0 install --with-deps chromium

ENV PORT=8000
ENV HOST=0.0.0.0
EXPOSE 8000

CMD ["bun", "dist/src/http/server.js"]
