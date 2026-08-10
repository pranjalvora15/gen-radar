import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { createPool } from "./db.js";
import { registerHooks } from "./hooks.js";
import articleChatRoutes from "./routes/articleChatsPhase3.js";
import paperWorkspaceRoutes from "./routes/paperWorkspaces.js";
import updateRoutes from "./routes/updates.js";
import { createAiService } from "./services/aiService.js";
import { deleteExpiredChats } from "./services/chatCleanupService.js";
import { createExaService } from "./services/exaService.js";
import { createFeedRefreshService } from "./services/feedRefreshService.js";
import { deleteExpiredPaperData } from "./services/paperWorkspaceService.js";

export async function buildApp(options = {}) {
  const fastify = Fastify({
    logger: options.logger ?? true,
    trustProxy: process.env.NODE_ENV === "production"
  });
  const database = options.database || createPool();

  fastify.decorate("db", database);
  const ai = options.aiService || createAiService();
  const exa = options.exaService || createExaService();
  fastify.decorate("ai", ai);
  fastify.decorate("exa", exa);
  fastify.decorate(
    "feedRefresh",
    options.feedRefreshService || createFeedRefreshService({
      database,
      ai,
      exa,
      logger: fastify.log
    })
  );

  await fastify.register(cors, {
    origin: process.env.CLIENT_ORIGIN || "http://localhost:5173",
    credentials: true,
    allowedHeaders: [
      "Content-Type", "X-Chat-Token", "X-PDF-SHA256", "X-Cleanup-Key"
    ]
  });
  await fastify.register(cookie);
  await fastify.register(multipart, {
    limits: { files: 1, fileSize: 20 * 1024 * 1024 }
  });
  await fastify.register(rateLimit, { global: false });

  registerHooks(fastify, { closeDatabase: !options.database });
  if (!options.database && options.scheduleCleanup !== false) {
    try {
      const [deletedChats, deletedPaperWorkspaces] = await Promise.all([
        deleteExpiredChats(database),
        deleteExpiredPaperData(database)
      ]);
      fastify.log.info(
        { deletedChats, deletedPaperWorkspaces },
        "Startup expiry cleanup complete"
      );
    } catch (error) {
      fastify.log.error({ error }, "Startup expiry cleanup failed");
    }
  }

  fastify.get("/api/health", async () => ({ status: "ok" }));
  await fastify.register(updateRoutes);
  await fastify.register(articleChatRoutes);
  await fastify.register(paperWorkspaceRoutes);

  return fastify;
}
