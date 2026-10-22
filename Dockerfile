# Compile on the build machine's architecture and cross-compile for the target one, so multi-arch builds need no emulation
FROM --platform=$BUILDPLATFORM oven/bun:1 AS build
ARG TARGETARCH

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY src ./src

# x64 "baseline" also runs on older NAS CPUs without AVX2. TARGETARCH is empty with the legacy builder: build for this machine
RUN arch="${TARGETARCH:-$(dpkg --print-architecture)}" \
    && case "$arch" in \
        amd64) target=bun-linux-x64-baseline ;; \
        arm64) target=bun-linux-arm64 ;; \
        *) echo "Unsupported architecture: $arch" >&2; exit 1 ;; \
    esac \
    && bun build src/index.ts --compile --minify --sourcemap --target="$target" --outfile /out/opds-proxy \
    && mkdir /out/data

# Just glibc and the executable: no shell, no package manager
FROM gcr.io/distroless/base-nossl-debian13

COPY --from=build /out/opds-proxy /opds-proxy
# /data holds config.json (servers, account credentials, reader tokens, admin password hash)
COPY --from=build --chown=1000:1000 /out/data /data
VOLUME /data
USER 1000:1000

ENV PORT=8080 DATA_DIR=/data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD ["/opds-proxy", "--healthcheck"]

ENTRYPOINT ["/opds-proxy"]
