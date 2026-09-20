import { serve } from "@hono/node-server";
import { app } from "./app.ts";
import { env } from "./env.ts";

serve({ fetch: app.fetch, port: env.port, hostname: env.host }, (info) => {
  console.log(`listening on http://${env.host}:${info.port}`);
});
