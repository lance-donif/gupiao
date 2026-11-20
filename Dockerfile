FROM ghcr.io/astral-sh/uv:0.13.6 AS uv
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PATH="/app/.venv/bin:$PATH" UV_LINK_MODE=copy
COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN --mount=type=secret,id=ca_bundle \
    if [ -f /run/secrets/ca_bundle ]; then export SSL_CERT_FILE=/run/secrets/ca_bundle; fi && \
    uv sync --frozen --no-dev --no-install-project && useradd --create-home --uid 10001 echo && mkdir data && chown echo:echo data
COPY --chown=echo:echo assistant assistant
COPY --chown=echo:echo web web
COPY --chown=echo:echo .env.example .env.example
USER echo
EXPOSE 8000
CMD ["python", "-m", "assistant", "serve", "--host", "0.0.0.0"]
