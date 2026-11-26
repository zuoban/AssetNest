import { ensureRuntimeDirectories, loadConfig } from "./config/loader.js";
import { openDatabase } from "./db/database.js";
import { runMigrations } from "./db/migrator.js";
import { revokeAllSessions } from "./modules/auth/service.js";

function parseArgs(argv: string[]): { command: string; flags: Record<string, string | boolean> } {
  const [command = "", ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  for (let idx = 0; idx < rest.length; idx += 1) {
    const arg = rest[idx];
    if (!arg || !arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = rest[idx + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      idx += 1;
    } else {
      flags[key] = true;
    }
  }
  return { command, flags };
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));

  if (command === "reset-admin") {
    console.error(
      "AssetNest 已改为通过环境变量 ASSETNEST_ACCESS_CODE 控制访问码登录（未配置则免登录）。请直接调整环境变量并重启服务。"
    );
    process.exit(1);
  }

  if (command !== "revoke-sessions") {
    console.error("用法: node dist/server/cli.js revoke-sessions [--config <path>]");
    process.exit(1);
  }

  const configPath = typeof flags.config === "string" ? flags.config : undefined;
  const config = loadConfig({ configPath });
  ensureRuntimeDirectories(config);
  const db = openDatabase({ dbPath: config.database.path, wal: config.database.wal });
  try {
    runMigrations(db);
    const count = revokeAllSessions(db);
    console.log(`已吊销全部活动会话（共 ${count} 条）。`);
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
