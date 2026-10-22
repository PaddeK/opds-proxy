# opds-proxy

Makes password-protected OPDS catalogs (BookOrbit, Calibre-Web, Kavita, …) usable from e-readers whose
built-in OPDS client can't handle authentication, such as PocketBook.

```
e-reader ──(no password, secret reader URL)──▶ opds-proxy ──(HTTP Basic auth)──▶ your OPDS server
```

The proxy fetches every feed with the upstream credentials and rewrites all links (navigation, pagination,
search, OpenSearch description, covers, downloads) to point back through itself. The reader never sees the
upstream server or needs a password. A plain reverse proxy can't do this: the upstream's links don't carry the
proxy's access token, so everything past the first page fails.

Everything is configured in a small web UI:

```
Server (e.g. BookOrbit, Calibre-Web)            several servers side by side
 └─ Account (a login on that server)            e.g. one per family member, or anonymous
     └─ Reader URL (one per device)             revocable, shows when it was last used
```

Each reader URL logs in upstream as its account, so the server keeps reading progress, permissions and
logs per person even though the e-readers themselves never enter a password.

Extra normalisation for picky readers:

- Absolute URLs everywhere, XML declaration with double quotes, plain `application/atom+xml` media type.
- Book and cover links end in a real filename (`…/_f/<id>/Some Title.epub`, `…/cover.jpg`) for readers that
  derive the saved filename or format from the URL.
- Downloads are streamed with `Content-Length`, `Content-Disposition` and `Range` support.

## Quick start

```sh
docker run -d --name opds-proxy -p 8601:8080 -v opds-proxy-data:/data --restart unless-stopped ghcr.io/paddek/opds-proxy:latest
docker logs opds-proxy   # shows a one-time setup code
```

1. Open `http://<docker-host>:8601/admin`, enter the setup code and choose an admin password.
   Prefer to set the code yourself? Pass `-e SETUP_CODE=$(openssl rand -hex 8)` (or set it in your compose file).
2. **Add server**: its OPDS root URL plus the first account (username/password, or empty for anonymous access).
   The URL must be reachable *from the container*; in the same Docker stack use the service name,
   e.g. `http://bookorbit:3000/api/v1/opds`. The login is tested on save.
3. **Create a reader URL** for your device under that account, e.g. `http://192.168.0.10:8601/k7m2-x9qp-4rtw-b8nd/`.
   Add more accounts on the server page if several people read from the same server.
4. On the e-reader, add that URL as an OPDS catalog and leave username and password empty.

To run it next to an existing stack, see [`compose.example.yaml`](compose.example.yaml).

Images are built for amd64 and arm64 (e.g. Raspberry Pi). `latest` follows the main branch; releases are also
tagged by version (`1.2.3`, `1.2`, `1`) if you prefer to pin one. To build the image yourself instead:
`docker build -t opds-proxy https://github.com/PaddeK/opds-proxy.git`.

## Configuration

Servers, accounts and reader URLs live in `/data/config.json` (mode `0600`). Mount `/data` as a volume.
The few environment variables are optional:

| Variable | Default | Purpose |
|---|---|---|
| `SETUP_CODE` | random, printed in the log | Your own code for the first-start setup page (at least 12 characters, no placeholders like `change-me`). Ignored once the admin password is set. |
| `ADMIN_PASSWORD` | – | Sets the admin password on every start and skips setup. Changes made in the UI are overwritten on the next restart, so mainly use it to reset a forgotten password, then remove it. |
| `PUBLIC_URL` | from `Host` header | Externally visible base URL, e.g. `https://books.example.org`. Only needed behind another reverse proxy that rewrites `Host`. |
| `UPSTREAM_TIMEOUT` | `60` | Seconds to wait for the upstream to answer (not counting download time). |
| `PORT` | `8080` | Port inside the container. |
| `DATA_DIR` | `/data` | Where `config.json` is stored. |

The image is a single compiled executable on [distroless](https://github.com/GoogleContainerTools/distroless)
(amd64 and arm64): no shell, so `docker exec … sh` won't work; `docker logs` is where to look.
It runs as uid `1000`. A named volume just works; for a bind mount, give the host directory to that user
(`sudo chown 1000:1000 /path/on/host`), otherwise the container exits with a hint saying exactly that.

## Security

- **Reader URLs are the credential.** Anyone who knows one can browse and download as its account.
  Tokens are ~78 bits, lowercase and without look-alike characters so they can be typed on an e-reader
  keyboard (matching is case-insensitive). Give each device its own URL and revoke it when a device is lost.
- **The admin UI** is protected by a password (argon2id). Logins are rate-limited, sessions are HttpOnly
  SameSite=Strict cookies, and cross-site form posts are rejected. On first start, the account can only be
  claimed with the setup code (from the container log, or your own `SETUP_CODE`).
- **Upstream passwords are stored in plain text** in `config.json`, because the proxy has to send them.
  Use dedicated OPDS users with only the permissions readers need, if the upstream supports that.
- The proxy only forwards requests inside the upstream's OPDS path (the path of the upstream URL);
  `..` tricks are rejected. It never exposes the rest of the upstream's API.
- Use HTTPS (e.g. behind Caddy or Traefik with `PUBLIC_URL` set) or keep it on your LAN.

## Development

Requires [Bun](https://bun.sh) 1.4 or newer.

```sh
bun install
bun test            # unit and integration tests (fake OPDS server included)
bun run typecheck
bun run dev         # http://localhost:8080/admin, data in ./data
bun run build       # standalone executable in dist/, as used in the Docker image

# Crawl a running proxy like a reader would; reports broken or leaking links
bun scripts/crawl.ts http://localhost:8601/<token>/ --search whale
```

Layout: `src/proxy/` holds the OPDS rewriting (`mapper.ts` URL mapping, `rewrite.ts` XML, `handler.ts`
request forwarding), `src/admin/` the web UI (server-rendered HTML, no build step; stylesheet and script in
`src/admin/static/`), `src/store.ts` the config file (older config versions are migrated on startup).

## License

[MIT](LICENSE)
