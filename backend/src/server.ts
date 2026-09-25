import { buildApp } from "./app";
import { env } from "./config/env";
import * as Sentry from "@sentry/node";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || "0.1"),
  enabled: Boolean(process.env.SENTRY_DSN),
});

const app = buildApp();

const server = app.listen(env.port, () => {
  // eslint-disable-next-line no-console
  console.log(`API listening on :${env.port}`);
});

// Report-backed endpoints (sales, finance, account-health) poll SP-API for
// up to ~2 minutes; keep the socket alive past Node's 120s default.
server.timeout = 180_000;
