import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/server/config/loader.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assetnest-cfg-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Config Loader", () => {
  it("loads pure-local defaults without requiring any config file or remote env vars", () => {
    const dir = makeTempDir();
    const cfg = loadConfig({
      cwd: dir,
      env: { ASSETNEST_DATA_DIR: path.join(dir, "data") }
    });

    expect(cfg.configPath).toBeNull();
    expect(cfg.app.accessCode).toBeNull();
    expect(cfg.storage.default).toBe("local");
    expect(cfg.storage.providers.local?.type).toBe("local");
    expect(cfg.storage.providers.local?.enabled).toBe(true);
    expect(cfg.database.path).toBe(path.join(dir, "data", "db", "assetnest.db"));
  });

  it("parses optional ASSETNEST_ACCESS_CODE and treats blank values as disabled", () => {
    const dir = makeTempDir();
    const blankCfg = loadConfig({
      cwd: dir,
      env: { ASSETNEST_DATA_DIR: path.join(dir, "data"), ASSETNEST_ACCESS_CODE: "   " }
    });
    expect(blankCfg.app.accessCode).toBeNull();

    const enabledCfg = loadConfig({
      cwd: dir,
      env: { ASSETNEST_DATA_DIR: path.join(dir, "data"), ASSETNEST_ACCESS_CODE: "  my-code-123  " }
    });
    expect(enabledCfg.app.accessCode).toBe("my-code-123");
  });

  it("does not require env vars for explicitly disabled remote providers", () => {
    const dir = makeTempDir();
    const cfgFile = path.join(dir, "config.yaml");
    fs.writeFileSync(
      cfgFile,
      `
app:
  dataDir: ${path.join(dir, "data")}
storage:
  default: local
  providers:
    local:
      type: local
      enabled: true
      root: ${path.join(dir, "assets")}
    r2:
      type: s3
      enabled: false
      endpoint: \${MISSING_S3_ENDPOINT}
      bucket: test
      accessKeyId: \${MISSING_S3_KEY}
      secretAccessKey: \${MISSING_S3_SECRET}
`,
      "utf8"
    );

    const cfg = loadConfig({ configPath: cfgFile, env: {} });
    expect(cfg.storage.providers.local?.enabled).toBe(true);
    expect(cfg.storage.providers.r2?.enabled).toBe(false);
  });

  it("fails fast when an enabled provider references a missing env var", () => {
    const dir = makeTempDir();
    const cfgFile = path.join(dir, "config.yaml");
    fs.writeFileSync(
      cfgFile,
      `
storage:
  default: local
  providers:
    local:
      type: local
      root: ${path.join(dir, "assets")}
    r2:
      type: s3
      enabled: true
      endpoint: https://example.r2.cloudflarestorage.com
      bucket: demo
      accessKeyId: \${S3_ACCESS_KEY}
      secretAccessKey: \${S3_SECRET_KEY}
`,
      "utf8"
    );

    expect(() => loadConfig({ configPath: cfgFile, env: {} })).toThrow(/S3_ACCESS_KEY/);
  });

  it("rejects non-http(s) WebDAV endpoints and disabled default providers", () => {
    const dir = makeTempDir();
    const badProtocolFile = path.join(dir, "bad-webdav.yaml");
    fs.writeFileSync(
      badProtocolFile,
      `
storage:
  default: nas
  providers:
    nas:
      type: webdav
      enabled: true
      endpoint: file:///etc/passwd
      username: admin
      password: secret
`,
      "utf8"
    );
    expect(() => loadConfig({ configPath: badProtocolFile, env: {} })).toThrow(/http:\/\/ 或 https:\/\//);

    const disabledDefaultFile = path.join(dir, "disabled-default.yaml");
    fs.writeFileSync(
      disabledDefaultFile,
      `
storage:
  default: local
  providers:
    local:
      type: local
      enabled: false
`,
      "utf8"
    );
    expect(() => loadConfig({ configPath: disabledDefaultFile, env: {} })).toThrow(/已被禁用/);
  });
});
