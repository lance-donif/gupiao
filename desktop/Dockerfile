FROM alpine:3.22 AS desktop-runtime
COPY --chmod=0444 worker.py /opt/echo/worker.py
RUN --mount=type=secret,id=ca_bundle \
    if [ -f /run/secrets/ca_bundle ]; then export SSL_CERT_FILE=/run/secrets/ca_bundle; fi && \
    apk add --no-cache python3 python3-tkinter xvfb scrot font-wqy-zenhei && \
    chmod 0755 /opt /opt/echo && addgroup -g 10001 echo && adduser -D -H -u 10001 -G echo echo
ENV DISPLAY=:99 HOME=/tmp XDG_CACHE_HOME=/tmp/cache LANG=C.UTF-8
USER 10001:10001
ENTRYPOINT ["/usr/bin/python3", "-I", "/opt/echo/worker.py", "serve"]
