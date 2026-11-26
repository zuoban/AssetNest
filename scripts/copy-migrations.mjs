import fs from "node:fs";
import path from "node:path";

const srcDir = path.resolve(import.meta.dirname, "../src/server/db/migrations");
const destDir = path.resolve(import.meta.dirname, "../dist/server/db/migrations");

fs.mkdirSync(destDir, { recursive: true });
for (const entry of fs.readdirSync(srcDir)) {
  if (entry.endsWith(".sql")) {
    fs.copyFileSync(path.join(srcDir, entry), path.join(destDir, entry));
  }
}
