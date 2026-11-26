import { loadConfig } from "./config/loader.js";
import { createApp } from "./http/app.js";

async function start(): Promise<void> {
  const config = loadConfig();
  const runtime = await createApp({
    config,
    acquireInstanceLock: true,
    logger: true
  });

  const shutdown = async (signal: string) => {
    runtime.app.log.info({ signal }, "Shutting down AssetNest gracefully...");
    try {
      await runtime.close();
      process.exit(0);
    } catch (err) {
      runtime.app.log.error({ err }, "Error during graceful shutdown");
      process.exit(1);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await runtime.app.listen({
    host: config.app.host,
    port: config.app.port
  });

  runtime.app.log.info(
    {
      host: config.app.host,
      port: config.app.port,
      configPath: config.configPath ?? "(default local)",
      dbPath: config.database.path
    },
    "AssetNest server started"
  );
}

start().catch((err) => {
  console.error("AssetNest 启动失败:", err instanceof Error ? err.message : err);
  process.exit(1);
});
