FROM oven/bun:1-alpine AS build-stage
WORKDIR /app

COPY package.json ./
RUN bun install
COPY . .
RUN bunx vite build --mode production

FROM nginx:stable-alpine AS production-stage

RUN apk add --no-cache curl

COPY --from=build-stage /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY scripts/proxy-smoke-check.sh /usr/local/bin/proxy-smoke-check.sh
COPY scripts/start-nginx-with-smoke.sh /usr/local/bin/start-nginx-with-smoke.sh
RUN chmod +x /usr/local/bin/proxy-smoke-check.sh /usr/local/bin/start-nginx-with-smoke.sh

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 CMD ["/usr/local/bin/proxy-smoke-check.sh"]
CMD ["/usr/local/bin/start-nginx-with-smoke.sh"]
