import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/server/config/loader.js";
import { createApp, type AppRuntime } from "../../src/server/http/app.js";
import { resetAdminPasswordCli } from "../../src/server/modules/auth/service.js";

const tempDirs: string[] = [];
const runtimes: AppRuntime[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assetnest-m0-"));
  tempDirs.push(dir);
  return dir;
}

function extractCookie(setCookieHeader: string | string[] | undefined): string {
  if (!setCookieHeader) return "";
  const first = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  return first ? first.split(";")[0] ?? "" : "";
}

afterEach(async () => {
  while (runtimes.length > 0) {
    await runtimes.pop()!.close();
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("M0 API end-to-end foundation", () => {
  it("supports healthz, first-time setup lockout, auth protection, CSRF guard, persistence across restart, and CLI admin reset", async () => {
    const dir = makeTempDir();
    const config = loadConfig({
      cwd: dir,
      env: { ASSETNEST_DATA_DIR: path.join(dir, "data") }
    });

    const runtime = await createApp({
      config,
      logger: false,
      loginRateLimitMax: 5
    });
    runtimes.push(runtime);

    const healthRes = await runtime.app.inject({ method: "GET", url: "/healthz" });
    expect(healthRes.statusCode).toBe(200);
    expect(healthRes.json()).toMatchObject({
      status: "ok",
      initialized: false,
      dbReady: true
    });

    const unauthDash = await runtime.app.inject({ method: "GET", url: "/api/v1/dashboard" });
    expect(unauthDash.statusCode).toBe(401);

    const noCsrfRes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/setup/init",
      payload: { username: "admin", displayName: "管理员", password: "Password123!" }
    });
    expect(noCsrfRes.statusCode).toBe(403);

    const badOriginRes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/setup/init",
      headers: {
        "x-assetnest-request": "1",
        host: "127.0.0.1:3000",
        origin: "https://evil.example.com"
      },
      payload: { username: "admin", displayName: "管理员", password: "Password123!" }
    });
    expect(badOriginRes.statusCode).toBe(403);

    const initRes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/setup/init",
      headers: { "x-assetnest-request": "1" },
      payload: { username: "admin", displayName: "卖家主管", password: "Password123!" }
    });
    expect(initRes.statusCode).toBe(201);
    const sessionCookie = extractCookie(initRes.headers["set-cookie"]);
    expect(sessionCookie).toContain("assetnest_session=");

    const reinitRes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/setup/init",
      headers: { "x-assetnest-request": "1" },
      payload: { username: "hacker", displayName: "Hacker", password: "Password123!" }
    });
    expect(reinitRes.statusCode).toBe(409);

    const dashRes = await runtime.app.inject({
      method: "GET",
      url: "/api/v1/dashboard",
      headers: { cookie: sessionCookie }
    });
    expect(dashRes.statusCode).toBe(200);
    expect(dashRes.json().counts).toEqual({
      products: 0,
      assets: 0,
      pendingReviews: 0,
      draftListings: 0,
      runningJobs: 0,
      failedJobs: 0
    });

    const patchSettings = await runtime.app.inject({
      method: "PATCH",
      url: "/api/v1/settings",
      headers: { cookie: sessionCookie, "x-assetnest-request": "1" },
      payload: { trashRetentionDays: 45, appTimezone: "Asia/Bangkok" }
    });
    expect(patchSettings.statusCode).toBe(200);
    expect(patchSettings.json().trashRetentionDays).toBe(45);
    expect(patchSettings.json().appTimezone).toBe("Asia/Bangkok");

    const logoutRes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { cookie: sessionCookie, "x-assetnest-request": "1" },
      payload: {}
    });
    expect(logoutRes.statusCode).toBe(200);

    const afterLogoutMe = await runtime.app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie: sessionCookie }
    });
    expect(afterLogoutMe.statusCode).toBe(401);

    await runtime.close();
    runtimes.pop();

    const restarted = await createApp({
      config,
      logger: false,
      loginRateLimitMax: 5
    });
    runtimes.push(restarted);

    const healthAfter = await restarted.app.inject({ method: "GET", url: "/healthz" });
    expect(healthAfter.json().initialized).toBe(true);

    const loginRes = await restarted.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { "x-assetnest-request": "1" },
      payload: { username: "admin", password: "Password123!" }
    });
    expect(loginRes.statusCode).toBe(200);
    const newCookie = extractCookie(loginRes.headers["set-cookie"]);

    const settingsAfter = await restarted.app.inject({
      method: "GET",
      url: "/api/v1/settings",
      headers: { cookie: newCookie }
    });
    expect(settingsAfter.statusCode).toBe(200);
    expect(settingsAfter.json().trashRetentionDays).toBe(45);
    expect(settingsAfter.json().appTimezone).toBe("Asia/Bangkok");

    await resetAdminPasswordCli(restarted.db, "admin", "NewHostResetPass99!");

    const revokedCheck = await restarted.app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie: newCookie }
    });
    expect(revokedCheck.statusCode).toBe(401);

    const oldPassLogin = await restarted.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { "x-assetnest-request": "1" },
      payload: { username: "admin", password: "Password123!" }
    });
    expect(oldPassLogin.statusCode).toBe(401);

    const newPassLogin = await restarted.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { "x-assetnest-request": "1" },
      payload: { username: "admin", password: "NewHostResetPass99!" }
    });
    expect(newPassLogin.statusCode).toBe(200);
  });

  it("enforces login rate limiting and marks removed config providers as missing_config", async () => {
    const dir = makeTempDir();
    const cfg1Path = path.join(dir, "cfg1.yaml");
    const cfg2Path = path.join(dir, "cfg2.yaml");

    fs.writeFileSync(
      cfg1Path,
      `
app:
  dataDir: ${path.join(dir, "data")}
storage:
  default: local
  providers:
    local:
      name: 本地盘
      type: local
      root: ${path.join(dir, "assets")}
    archive_nas:
      name: 归档 NAS
      type: webdav
      enabled: false
`,
      "utf8"
    );

    const r1 = await createApp({ config: loadConfig({ configPath: cfg1Path, env: {} }), logger: false });
    await r1.app.inject({
      method: "POST",
      url: "/api/v1/setup/init",
      headers: { "x-assetnest-request": "1" },
      payload: { username: "admin", displayName: "管理员", password: "Password123!" }
    });
    await r1.close();

    fs.writeFileSync(
      cfg2Path,
      `
app:
  dataDir: ${path.join(dir, "data")}
storage:
  default: local
  providers:
    local:
      name: 本地盘
      type: local
      root: ${path.join(dir, "assets")}
`,
      "utf8"
    );

    const r2 = await createApp({
      config: loadConfig({ configPath: cfg2Path, env: {} }),
      logger: false,
      loginRateLimitMax: 2
    });
    runtimes.push(r2);

    const status = await r2.app.inject({ method: "GET", url: "/api/v1/setup/status" });
    const providers = status.json().providersSummary as Array<{ id: string; status: string }>;
    const missing = providers.find((p) => p.id === "archive_nas");
    expect(missing).toBeDefined();
    expect(missing?.status).toBe("missing_config");

    // Trigger login rate limit after 2 failed attempts
    const a1 = await r2.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { "x-assetnest-request": "1" },
      payload: { username: "admin", password: "wrong" }
    });
    const a2 = await r2.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { "x-assetnest-request": "1" },
      payload: { username: "admin", password: "wrong" }
    });
    const a3 = await r2.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { "x-assetnest-request": "1" },
      payload: { username: "admin", password: "wrong" }
    });
    expect(a1.statusCode).toBe(401);
    expect(a2.statusCode).toBe(401);
    expect(a3.statusCode).toBe(429);
  });
});
