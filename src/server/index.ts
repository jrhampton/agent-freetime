import Fastify from "fastify";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { openDb } from "./db.js";
import { getSettings } from "./settings.js";
import { AgentManager } from "./runtime.js";
import { registerRoutes } from "./routes.js";
import { seedPersonalities } from "./seed.js";

const db = openDb();
getSettings(db);
seedPersonalities(db);
const mgr = new AgentManager(db);

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" }, bodyLimit: 2_000_000 });
await app.register(cookie);
await app.register(websocket);
registerRoutes(app, db, mgr);

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../web");
if (fs.existsSync(webDir)) {
  await app.register(fastifyStatic, { root: webDir });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "not found" });
    return reply.sendFile("index.html");
  });
}

if (!config.adminPassword) app.log.warn("ADMIN_PASSWORD is not set: the UI is open to anyone who can reach it.");

await app.listen({ port: config.port, host: config.host });
mgr.resumeAutostart();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    mgr.stopAll();
    await app.close();
    db.close();
    process.exit(0);
  });
}
