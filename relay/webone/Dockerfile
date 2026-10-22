# WebOne, the HTTP proxy for old browsers (https://github.com/atauenis/webone),
# from its official release packages.
FROM debian:bookworm-slim

ARG WEBONE_VERSION=0.19.0
ARG TARGETARCH
# The address the emulated PCs reach the proxy at (WebOne writes it into links to its own pages).
ARG WEBONE_HOST=172.31.98.10

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && curl -fsSL -o /tmp/webone.deb \
        "https://github.com/atauenis/webone/releases/download/v${WEBONE_VERSION}/webone.${WEBONE_VERSION}.linux-${TARGETARCH}.deb" \
    && apt-get install -y --no-install-recommends /tmp/webone.deb \
    && rm /tmp/webone.deb \
    && rm -rf /var/lib/apt/lists/* \
    && sed -i "s/^DefaultHostName=.*/DefaultHostName=${WEBONE_HOST}/" /etc/webone.conf

ENV HOME=/tmp OPENSSL_CONF=/etc/webone.conf.d/openssl_webone.cnf
EXPOSE 8080
CMD ["/usr/local/bin/webone", "--daemon"]
