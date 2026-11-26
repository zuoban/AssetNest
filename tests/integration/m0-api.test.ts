import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/server/config/loader.js";
import { createApp, type AppRuntime } from "../../src/server/http/app.js";

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
  it("allows direct system access without login when ASSETNEST_ACCESS_CODE is not configured while keeping CSRF guard", async () => {
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
      initialized: true,
      dbReady: true,
      authEnabled: false
    });

    const statusRes = await runtime.app.inject({ method: "GET", url: "/api/v1/auth/status" });
    expect(statusRes.statusCode).toBe(200);
    expect(statusRes.json()).toMatchObject({
      authEnabled: false,
      authenticated: true
    });

    const meRes = await runtime.app.inject({ method: "GET", url: "/api/v1/auth/me" });
    expect(meRes.statusCode).toBe(200);
    expect(meRes.json().authEnabled).toBe(false);

    const dashRes = await runtime.app.inject({ method: "GET", url: "/api/v1/dashboard" });
    expect(dashRes.statusCode).toBe(200);
    expect(dashRes.json().counts).toEqual({
      products: 0,
      assets: 0,
      pendingReviews: 0,
      draftListings: 0,
      runningJobs: 0,
      failedJobs: 0
    });

    // Mutating requests still require CSRF header and same-origin
    const noCsrfRes = await runtime.app.inject({
      method: "PATCH",
      url: "/api/v1/settings",
      payload: { trashRetentionDays: 45 }
    });
    expect(noCsrfRes.statusCode).toBe(403);

    const badOriginRes = await runtime.app.inject({
      method: "PATCH",
      url: "/api/v1/settings",
      headers: {
        "x-assetnest-request": "1",
        host: "127.0.0.1:3000",
        origin: "https://evil.example.com"
      },
      payload: { trashRetentionDays: 45 }
    });
    expect(badOriginRes.statusCode).toBe(403);

    const patchSettings = await runtime.app.inject({
      method: "PATCH",
      url: "/api/v1/settings",
      headers: { "x-assetnest-request": "1" },
      payload: { trashRetentionDays: 45, appTimezone: "Asia/Bangkok" }
    });
    expect(patchSettings.statusCode).toBe(200);
    expect(patchSettings.json().trashRetentionDays).toBe(45);
    expect(patchSettings.json().appTimezone).toBe("Asia/Bangkok");

    // Login endpoint reports conflict when access code is disabled
    const loginDisabledRes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { "x-assetnest-request": "1" },
      payload: { accessCode: "anything" }
    });
    expect(loginDisabledRes.statusCode).toBe(409);
  });

  it("enforces access-code login when ASSETNEST_ACCESS_CODE is set, persists sessions across restart, and invalidates sessions on code rotation", async () => {
    const dir = makeTempDir();
    const dataDir = path.join(dir, "data");
    const config = loadConfig({
      cwd: dir,
      env: {
        ASSETNEST_DATA_DIR: dataDir,
        ASSETNEST_ACCESS_CODE: "SecretCode2026!"
      }
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
      initialized: true,
      dbReady: true,
      authEnabled: true
    });

    const statusUnauthed = await runtime.app.inject({ method: "GET", url: "/api/v1/auth/status" });
    expect(statusUnauthed.statusCode).toBe(200);
    expect(statusUnauthed.json()).toMatchObject({
      authEnabled: true,
      authenticated: false
    });

    const unauthDash = await runtime.app.inject({ method: "GET", url: "/api/v1/dashboard" });
    expect(unauthDash.statusCode).toBe(401);

    const noCsrfLogin = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { accessCode: "SecretCode2026!" }
    });
    expect(noCsrfLogin.statusCode).toBe(403);

    const wrongLogin = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { "x-assetnest-request": "1" },
      payload: { accessCode: "WrongCode" }
    });
    expect(wrongLogin.statusCode).toBe(401);

    const loginRes = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { "x-assetnest-request": "1" },
      payload: { accessCode: "SecretCode2026!" }
    });
    expect(loginRes.statusCode).toBe(200);
    const sessionCookie = extractCookie(loginRes.headers["set-cookie"]);
    expect(sessionCookie).toContain("assetnest_session=");

    const statusAuthed = await runtime.app.inject({
      method: "GET",
      url: "/api/v1/auth/status",
      headers: { cookie: sessionCookie }
    });
    expect(statusAuthed.json()).toMatchObject({
      authEnabled: true,
      authenticated: true
    });

    const patchSettings = await runtime.app.inject({
      method: "PATCH",
      url: "/api/v1/settings",
      headers: { cookie: sessionCookie, "x-assetnest-request": "1" },
      payload: { trashRetentionDays: 45, appTimezone: "Asia/Bangkok" }
    });
    expect(patchSettings.statusCode).toBe(200);

    // Restart with the SAME access code -> session remains valid
    await runtime.close();
    runtimes.pop();

    const restartedSameCode = await createApp({
      config,
      logger: false,
      loginRateLimitMax: 5
    });
    runtimes.push(restartedSameCode);

    const settingsAfter = await restartedSameCode.app.inject({
      method: "GET",
      url: "/api/v1/settings",
      headers: { cookie: sessionCookie }
    });
    expect(settingsAfter.statusCode).toBe(200);
    expect(settingsAfter.json().trashRetentionDays).toBe(45);
    expect(settingsAfter.json().appTimezone).toBe("Asia/Bangkok");

    // Logout revokes the session
    const logoutRes = await restartedSameCode.app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { cookie: sessionCookie, "x-assetnest-request": "1" },
      payload: {}
    });
    expect(logoutRes.statusCode).toBe(200);

    const afterLogoutMe = await restartedSameCode.app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie: sessionCookie }
    });
    expect(afterLogoutMe.statusCode).toBe(401);

    // Log in again before rotating access code
    const loginAgain = await restartedSameCode.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { "x-assetnest-request": "1" },
      payload: { accessCode: "SecretCode2026!" }
    });
    expect(loginAgain.statusCode).toBe(200);
    const preRotateCookie = extractCookie(loginAgain.headers["set-cookie"]);

    await restartedSameCode.close();
    runtimes.pop();

    // Restart with a ROTATED access code -> old session & old code are immediately rejected
    const rotatedConfig = loadConfig({
      cwd: dir,
      env: {
        ASSETNEST_DATA_DIR: dataDir,
        ASSETNEST_ACCESS_CODE: "NewRotatedCode99!"
      }
    });
    const restartedRotated = await createApp({
      config: rotatedConfig,
      logger: false,
      loginRateLimitMax: 5
    });
    runtimes.push(restartedRotated);

    const oldSessionCheck = await restartedRotated.app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie: preRotateCookie }
    });
    expect(oldSessionCheck.statusCode).toBe(401);

    const oldCodeLogin = await restartedRotated.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { "x-assetnest-request": "1" },
      payload: { accessCode: "SecretCode2026!" }
    });
    expect(oldCodeLogin.statusCode).toBe(401);

    const newCodeLogin = await restartedRotated.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { "x-assetnest-request": "1" },
      payload: { accessCode: "NewRotatedCode99!" }
    });
    expect(newCodeLogin.statusCode).toBe(200);
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

    const r1 = await createApp({
      config: loadConfig({ configPath: cfg1Path, env: { ASSETNEST_ACCESS_CODE: "RateCode123!" } }),
      logger: false
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
      config: loadConfig({ configPath: cfg2Path, env: { ASSETNEST_ACCESS_CODE: "RateCode123!" } }),
      logger: false,
      loginRateLimitMax: 2
    });
    runtimes.push(r2);

    // Trigger login rate limit after 2 failed attempts
    const a1 = await r2.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { "x-assetnest-request": "1" },
      payload: { accessCode: "wrong" }
    });
    const a2 = await r2.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { "x-assetnest-request": "1" },
      payload: { accessCode: "wrong" }
    });
    const a3 = await r2.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { "x-assetnest-request": "1" },
      payload: { accessCode: "wrong" }
    });
    expect(a1.statusCode).toBe(401);
    expect(a2.statusCode).toBe(401);
    expect(a3.statusCode).toBe(429);

    await r2.close();
    runtimes.pop();

    // Reopen without access code to verify missing_config provider status directly
    const r3 = await createApp({
      config: loadConfig({ configPath: cfg2Path, env: {} }),
      logger: false
    });
    runtimes.push(r3);

    const providersRes = await r3.app.inject({ method: "GET", url: "/api/v1/storage/providers" });
    expect(providersRes.statusCode).toBe(200);
    const providers = providersRes.json().items as Array<{ id: string; status: string }>;
    const missing = providers.find((p) => p.id === "archive_nas");
    expect(missing).toBeDefined();
    expect(missing?.status).toBe("missing_config");
  });
});
