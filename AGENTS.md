# AssetNest — Engineering & Agent Guidelines

This repository implements **AssetNest**, a self-hosted, single-container cross-border e-commerce Digital Asset Management (DAM) system built around `docs/PRD.md`.

## 1. Hard Architectural Constraints (Non-Negotiable)

- **Single-instance monolith**: One Node.js 22 runtime serving both REST API and built React SPA inside one Docker container.
- **SQLite only**: Use Node 22 built-in `node:sqlite` (`DatabaseSync`) on local persistent disk (`/data/db/assetnest.db`) with `WAL`, `foreign_keys = ON`, and `busy_timeout = 5000`. Never store SQLite or WAL/SHM files on S3, WebDAV, or non-POSIX network shares.
- **Zero unnecessary infrastructure**: Do **not** add PostgreSQL, MySQL, Redis, Elasticsearch, MinIO (as a required runtime service), RabbitMQ, external queues, microservices, or paid cloud dependencies. Any new runtime dependency must be strictly justified.
- **Pluggable storage via unified adapter**: All file I/O must go through `StorageProvider` (`Local`, `S3`, `WebDAV`). Business modules must never call vendor SDKs or `fs` directly for asset objects.
- **Secrets hygiene**: Never store remote storage credentials, presigned URLs, plaintext passwords, or binary file blobs in SQLite, API responses, activity logs, job error logs, or export manifests.
- **Immutability invariants**:
  - Original files (`files`) are immutable and content-addressed (`originals/<sha256[0..2]>/<sha256>`).
  - Historical `asset_versions` are never overwritten in place.
  - Locked `product_master_images` pin a specific `asset_version_id`.
  - Frozen `releases` and `release_assets` are strictly immutable after creation.
- **No fake completeness**: Never ship mock data, stubbed APIs, or un-wired placeholder buttons to pretend a feature is done. Only render controls backed by real database state and real APIs.
- **Scope discipline**: Build P0 (`M0–M4`) thoroughly before any P1/P2 feature. Do not expand scope without explicit instruction.

## 2. Tech Stack & Directory Layout

- **Runtime**: Node.js 22 LTS (ESM), TypeScript 5 (strict mode)
- **Server**: Fastify 5 (`@fastify/cookie`, `@fastify/multipart`, `@fastify/static`, `@fastify/rate-limit`), Zod, `node:sqlite`, Sharp, `@aws-sdk/client-s3` + `@aws-sdk/lib-storage`, native-fetch WebDAV adapter, `yazl` / `yauzl`
- **Frontend**: React 19, Vite 6, TypeScript, Tailwind CSS v4, React Router v7, Lucide React, `@tanstack/react-virtual`, `@dnd-kit/core` + `@dnd-kit/sortable`
- **Testing**: Vitest (unit, DB, API, storage integration) + Playwright (dev-only E2E)

```text
src/
  server/
    config/        # config.yaml + env interpolation + Zod validation
    db/            # node:sqlite wrapper, transaction helper, migrations/
    storage/       # StorageProvider interface + local/s3/webdav adapters
    jobs/          # SQLite persistent job queue + in-process Worker
    modules/       # auth, setup, products, assets, listings, pdp, releases, backup, system
    http/          # Fastify app factory, auth/CSRF hooks, error handler
    cli.ts         # Host-controlled maintenance CLI (e.g. reset-admin)
    index.ts       # Server entrypoint + graceful shutdown
  web/
    app/           # Router, layout shell, auth guard
    api/           # Typed API client
    components/    # Reusable desktop UI primitives
    pages/         # Feature pages (Chinese UI)
  shared/          # Shared TypeScript types, error codes, constants
tests/
  unit/
  integration/
  e2e/
docs/              # PRD, ARCHITECTURE, SCHEMA, STORAGE, API, UI_UX, PLAN
config/            # config.example.yaml
```

## 3. Coding & Data Integrity Rules

- **Transactions**: Use `withTransaction(db, fn)` (`BEGIN IMMEDIATE`) for multi-step mutations. Never hold a SQLite write transaction open across network I/O, storage I/O, or image processing.
- **File upload & migration order**: Stage to temp disk while streaming SHA-256 -> dedup check `(storage_id, sha256)` -> write & verify object in storage -> commit short SQLite transaction -> enqueue async thumbnail/index work. Never mark an unverified object as `ready`.
- **Reference-protected deletion**: Products, Listings, and Assets use soft delete (`deleted_at`). Physical file deletion runs exclusively via GC jobs after verifying zero references across live assets, recoverable soft-deleted versions, locked master images, asset sets, releases, and active jobs.
- **Security**:
  - All business, media, download, export, and settings endpoints enforce server-side session auth.
  - Mutating endpoints enforce CSRF origin checks + `HttpOnly`, `SameSite=Lax` cookies.
  - Sanitize all filenames, object keys, and ZIP paths against path traversal and symlinks.
  - Never execute or render untrusted HTML/SVG/scripts inline on the app origin without strict sandbox headers (`Content-Security-Policy: default-src 'none'; sandbox`) or `Content-Disposition: attachment`.
- **Logging**: Use Fastify Pino logger with redaction paths for passwords, tokens, cookies, and storage keys.
- **UI Language**: Chinese UI (`zh-CN`), while preserving arbitrary UTF-8 content (EN/TH/ZH/etc.) in products, assets, and PDP. Never use color alone to convey status—always pair with explicit text label and icon.

## 4. Verification Workflow

Every milestone (`M0–M4`) must pass real verification before proceeding:

1. Type-check: `pnpm typecheck`
2. Build (server + web): `pnpm build`
3. Unit & integration tests: `pnpm test`
4. Milestone-specific E2E / Docker / real storage checks as defined in `docs/PLAN.md`.
5. Report actual commands run, verified pass/fail outcomes, unverified items, and residual risks. Never claim full pass for untested acceptance criteria.

## 5. Documentation Map

- `docs/PRD.md`: Baseline product requirements (P0/P1/P2, AC-01 to AC-15)
- `docs/ARCHITECTURE.md`: PRD conflict/risk analysis, tech stack, architecture, worker, security, backup/restore
- `docs/SCHEMA.md`: Complete SQLite DDL, constraints, triggers, FTS5 search, migration plan
- `docs/STORAGE.md`: `StorageProvider` contract, Local/S3/WebDAV behavior, dedup, migration state machine
- `docs/API.md`: REST API contracts, error format, streaming & Range specifications
- `docs/UI_UX.md`: Desktop-first visual system, layout architecture, interaction flows
- `docs/PLAN.md`: M0–M4 task breakdown and verifiable acceptance criteria
