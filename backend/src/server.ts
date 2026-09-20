import { buildApp } from "./app";
import { env } from "./config/env";

const app = buildApp();

const server = app.listen(env.port, () => {
  // eslint-disable-next-line no-console
  console.log(`API listening on :${env.port}`);
});

// Report-backed endpoints (sales, finance, account-health) poll SP-API for
// up to ~2 minutes; keep the socket alive past Node's 120s default.
server.timeout = 180_000;
