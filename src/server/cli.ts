import readline from "node:readline";
import { ensureRuntimeDirectories, loadConfig } from "./config/loader.js";
import { openDatabase } from "./db/database.js";
import { runMigrations } from "./db/migrator.js";
import { resetAdminPasswordCli } from "./modules/auth/service.js";

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

function readPasswordFromStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    let content = "";
    rl.on("line", (line) => {
      if (!content) content = line.trim();
    });
    rl.on("close", () => resolve(content));
    rl.on("error", reject);
  });
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));

  if (command !== "reset-admin") {
    console.error("用法: node dist/server/cli.js reset-admin --username <name> --password-stdin [--config <path>]");
    process.exit(1);
  }

  const username = typeof flags.username === "string" ? flags.username : "admin";
  const configPath = typeof flags.config === "string" ? flags.config : undefined;

  let newPassword = "";
  if (flags["password-stdin"]) {
    newPassword = await readPasswordFromStdin();
  } else if (typeof flags.password === "string") {
    newPassword = flags.password;
  } else {
    console.error("请通过 --password-stdin（推荐）提供新密码");
    process.exit(1);
  }

  const config = loadConfig({ configPath });
  ensureRuntimeDirectories(config);
  const db = openDatabase({ dbPath: config.database.path, wal: config.database.wal });
  try {
    runMigrations(db);
    const result = await resetAdminPasswordCli(db, username, newPassword);
    if (result.created) {
      console.log(`已创建管理员账号 "${result.username}"（ID: ${result.userId}）`);
    } else {
      console.log(`已重置管理员 "${result.username}" 密码，并吊销全部历史会话。`);
    }
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
