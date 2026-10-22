import { createApp } from "./server.ts";
import { Store } from "./store.ts";
import { SetupCodeError, resolveSetupCode } from "./setup.ts";

const port = Number(process.env.PORT ?? 8080);
const dataDir = process.env.DATA_DIR ?? "/data";
const publicUrl = process.env.PUBLIC_URL?.replace(/\/+$/, "") || undefined;
const adminPassword = process.env.ADMIN_PASSWORD;
const setupCodeEnv = process.env.SETUP_CODE;
const upstreamTimeoutMs = Number(process.env.UPSTREAM_TIMEOUT ?? 60) * 1000;

// The container image has no shell or wget, so Docker's HEALTHCHECK runs the binary itself: opds-proxy --healthcheck
if (process.argv.includes("--healthcheck")) {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(4000) }).catch(() => null);
    process.exit(res?.ok ? 0 : 1);
}

let store: Store;
try {
    store = await Store.open(dataDir);
} catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EACCES" && code !== "EPERM") throw err;
    const uid = process.getuid?.() ?? "?";
    const gid = process.getgid?.() ?? "?";
    console.error(`Cannot write to ${dataDir} as uid ${uid}. If it is a bind mount, create the directory on the host and`
        + ` give it to this user, e.g.:\n\n  mkdir -p /path/on/host && sudo chown ${uid}:${gid} /path/on/host\n`);
    process.exit(1);
}

// ADMIN_PASSWORD (re)sets the admin password on every start: handy for automation and for recovery
if (adminPassword) {
    const hash = store.config.adminPasswordHash;
    if (!hash || !(await Bun.password.verify(adminPassword, hash))) {
        const newHash = await Bun.password.hash(adminPassword);
        await store.update((c) => {
            c.adminPasswordHash = newHash;
        });
        console.log("Admin password set from ADMIN_PASSWORD.");
    }
}

let setup;
try {
    setup = resolveSetupCode(!!store.config.adminPasswordHash, setupCodeEnv);
} catch (err) {
    if (!(err instanceof SetupCodeError)) throw err;
    console.error(err.message);
    process.exit(1);
}
if (!setup && setupCodeEnv) console.log("SETUP_CODE is ignored: the admin account is already set up. You can remove it.");

const app = createApp({ store, setupCode: setup?.code, setupCodeFromEnv: setup?.source === "env", publicUrl, upstreamTimeoutMs });
const server = Bun.serve({ port, fetch: app.fetch, idleTimeout: 120 });
void app.checkAll();

const adminUrl = publicUrl ? `${publicUrl}/admin` : "/admin on the published port (e.g. http://<docker-host>:8601/admin)";
console.log(`opds-proxy listening on :${server.port}, data in ${dataDir}`);
if (setup?.source === "env") {
    console.log(`\n  First start: open ${adminUrl}\n  and enter the SETUP_CODE from your environment\n`);
} else if (setup) {
    console.log(`\n  First start: open ${adminUrl}\n  and enter the setup code  ${setup.code}\n`);
} else {
    console.log(`Admin UI: ${adminUrl}`);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
        await server.stop();
        await store.flush();
        process.exit(0);
    });
}
