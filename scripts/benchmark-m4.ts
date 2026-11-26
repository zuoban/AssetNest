import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { openDatabase } from "../src/server/db/database.js";
import { runMigrations } from "../src/server/db/migrator.js";
import { listAssets } from "../src/server/modules/assets/service.js";
import { listProducts } from "../src/server/modules/products/service.js";

const PRODUCT_COUNT = 1_000;
const SKUS_PER_PRODUCT = 5; // 5,000 SKUs
const ASSETS_PER_PRODUCT = 50; // 50,000 Assets

const CATEGORIES = [
  "Audio",
  "HomeAppliance",
  "Kitchen",
  "Beauty",
  "Outdoor",
  "PetSupplies",
  "Lighting",
  "SmartHome"
];
const PURPOSES = ["main", "carousel", "sku", "detail", "raw", "video"];
const REVIEW_STATUSES = ["approved", "pending", "rejected"] as const;
const MARKETS = ["TH", "SG", "MY", "VN", "US", "JP"];
const ZH_TOPICS = ["无线降噪耳机", "便携咖啡机", "高速吹风机", "桌面加湿器", "磁吸充电宝", "智能投影仪"];
const EN_TOPICS = [
  "Wireless ANC Headphones",
  "Portable Coffee Maker",
  "High-Speed Hair Dryer",
  "Desk Humidifier",
  "Magnetic Power Bank",
  "Smart Mini Projector"
];
const TH_TOPICS = [
  "หูฟังไร้สายตัดเสียงรบกวน",
  "เครื่องชงกาแฟพกพา",
  "ไดร์เป่าผมความเร็วสูง",
  "เครื่องทำความชื้นตั้งโต๊ะ",
  "พาวเวอร์แบงค์แม่เหล็ก",
  "โปรเจคเตอร์ขนาดเล็ก"
];

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx]!;
}

function formatMs(ms: number): string {
  return `${ms.toFixed(2)} ms`;
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "assetnest-bench-m4-"));
  const dbPath = path.join(tempDir, "bench.sqlite");

  console.log(`Benchmark workspace: ${tempDir}`);
  console.log(
    `Seeding ${PRODUCT_COUNT.toLocaleString()} products, ${(PRODUCT_COUNT * SKUS_PER_PRODUCT).toLocaleString()} SKUs, ${(PRODUCT_COUNT * ASSETS_PER_PRODUCT).toLocaleString()} assets...`
  );

  const db = openDatabase({ dbPath, acquireInstanceLock: false });
  runMigrations(db);

  const seedStart = performance.now();
  const now = new Date().toISOString();

  // Ensure local storage provider & user & tags exist
  const adminId = crypto.randomUUID();
  db.raw
    .prepare(
      `INSERT INTO users (id, username, display_name, password_hash, role, created_at, updated_at)
       VALUES (?, 'bench_admin', 'Bench Admin', 'hash', 'admin', ?, ?)`
    )
    .run(adminId, now, now);

  db.raw
    .prepare(
      `INSERT OR IGNORE INTO storage_providers
         (id, name, type, config_ref, enabled, status, created_at, updated_at)
       VALUES ('local', 'Local Bench', 'local', 'bench', 1, 'healthy', ?, ?)`
    )
    .run(now, now);

  const tagIds: string[] = [];
  const insertTag = db.raw.prepare(
    "INSERT OR IGNORE INTO tags (id, dimension, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
  );
  const findTag = db.raw.prepare(
    "SELECT id FROM tags WHERE dimension = 'market' AND name = ? AND parent_id IS NULL"
  );
  for (const market of MARKETS) {
    const tid = crypto.randomUUID();
    insertTag.run(tid, "market", market, now, now);
    const existing = findTag.get(market) as { id: string };
    tagIds.push(existing.id);
  }

  const insertProduct = db.raw.prepare(
    `INSERT INTO products (id, spu, name_zh, name_en, category, brand_model, supplier_name, status, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`
  );
  const insertSku = db.raw.prepare(
    `INSERT INTO skus (id, product_id, code, name, attributes_json, attributes_canonical, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`
  );
  const insertFile = db.raw.prepare(
    `INSERT INTO files (id, storage_id, object_key, sha256, size_bytes, mime_type, ext, width, height, state, created_at, updated_at)
     VALUES (?, 'local', ?, ?, ?, 'image/jpeg', 'jpg', 1200, 1200, 'ready', ?, ?)`
  );
  const insertAsset = db.raw.prepare(
    `INSERT INTO assets (id, name, original_filename, asset_type, purpose, source, current_version_id, is_favorite, notes, created_at, updated_at)
     VALUES (?, ?, ?, 'image', ?, 'studio', ?, ?, ?, ?, ?)`
  );
  const insertVersion = db.raw.prepare(
    `INSERT INTO asset_versions (id, asset_id, file_id, version_no, original_filename, review_status, change_note, created_at)
     VALUES (?, ?, ?, 1, ?, ?, '', ?)`
  );
  const insertProdAsset = db.raw.prepare(
    "INSERT INTO product_assets (product_id, asset_id, created_at) VALUES (?, ?, ?)"
  );
  const insertAssetTag = db.raw.prepare(
    "INSERT INTO asset_tags (asset_id, tag_id, created_at) VALUES (?, ?, ?)"
  );
  const insertSearchDoc = db.raw.prepare(
    "INSERT INTO search_documents (entity_type, entity_id, search_text, updated_at) VALUES (?, ?, ?, ?)"
  );
  const insertSearchFts = db.raw.prepare(
    "INSERT INTO search_fts (entity_type, entity_id, search_text) VALUES (?, ?, ?)"
  );

  let sampleProductId = "";
  const sampleTagId = tagIds[0]!;

  // Seed in batches of 50 products per transaction for fast seeding
  const BATCH_SIZE = 50;
  for (let start = 0; start < PRODUCT_COUNT; start += BATCH_SIZE) {
    const end = Math.min(PRODUCT_COUNT, start + BATCH_SIZE);
    db.transaction(() => {
      for (let pIdx = start; pIdx < end; pIdx++) {
        const pid = crypto.randomUUID();
        if (pIdx === 420) sampleProductId = pid;
        const spu = `SPU-${String(pIdx).padStart(4, "0")}`;
        const topicIdx = pIdx % ZH_TOPICS.length;
        const cat = CATEGORIES[pIdx % CATEGORIES.length]!;
        const nameZh = `${ZH_TOPICS[topicIdx]} Pro-${pIdx}`;
        const nameEn = `${EN_TOPICS[topicIdx]} Model-${pIdx}`;
        const nameTh = `${TH_TOPICS[topicIdx]} รุ่น-${pIdx}`;
        const prodSearchText = `${spu} ${nameZh} ${nameEn} ${nameTh} ${cat}`;

        insertProduct.run(pid, spu, nameZh, nameEn, cat, `BM-${pIdx}`, "FactoryA", nameTh, now, now);
        insertSearchDoc.run("product", pid, prodSearchText, now);
        insertSearchFts.run("product", pid, prodSearchText);

        for (let sIdx = 0; sIdx < SKUS_PER_PRODUCT; sIdx++) {
          const sid = crypto.randomUUID();
          const skuCode = `${spu}-SKU${sIdx + 1}`;
          const attrs = JSON.stringify({ color: `C${sIdx + 1}` });
          insertSku.run(
            sid,
            pid,
            skuCode,
            `颜色${sIdx + 1}`,
            attrs,
            attrs,
            now,
            now
          );
        }

        for (let aIdx = 0; aIdx < ASSETS_PER_PRODUCT; aIdx++) {
          const aid = crypto.randomUUID();
          const vid = crypto.randomUUID();
          const fid = crypto.randomUUID();
          const globalIdx = pIdx * ASSETS_PER_PRODUCT + aIdx;
          const sha = crypto.createHash("sha256").update(`bench-${globalIdx}`).digest("hex");
          const purpose = PURPOSES[aIdx % PURPOSES.length]!;
          const reviewStatus = REVIEW_STATUSES[aIdx % REVIEW_STATUSES.length]!;
          const marketTagId = tagIds[aIdx % tagIds.length]!;
          const marketLabel = MARKETS[aIdx % MARKETS.length]!;
          const fileName = `${spu}_${purpose}_${String(aIdx + 1).padStart(2, "0")}.jpg`;
          const assetName = `${nameZh} ${purpose} #${aIdx + 1}`;
          const assetSearchText = `${assetName} ${fileName} ${spu} ${nameZh} ${nameEn} ${nameTh} ${marketLabel} ${purpose}`;

          insertFile.run(fid, `sha256/${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}`, sha, 250_000 + (aIdx * 1024), now, now);
          insertAsset.run(
            aid,
            assetName,
            fileName,
            purpose,
            vid,
            aIdx === 0 ? 1 : 0,
            nameTh,
            now,
            now
          );
          insertVersion.run(vid, aid, fid, fileName, reviewStatus, now);
          insertProdAsset.run(pid, aid, now);
          insertAssetTag.run(aid, marketTagId, now);
          insertSearchDoc.run("asset", aid, assetSearchText, now);
          insertSearchFts.run("asset", aid, assetSearchText);
        }
      }
    });
  }

  // Optimize FTS5 & query planner stats
  db.raw.exec("INSERT INTO search_fts(search_fts) VALUES('optimize'); ANALYZE;");

  const seedMs = performance.now() - seedStart;
  const dbSizeBytes = fs.statSync(dbPath).size;
  console.log(`Seeding + FTS optimize + ANALYZE finished in ${(seedMs / 1000).toFixed(2)}s (DB size: ${formatMb(dbSizeBytes)})`);

  interface BenchCase {
    name: string;
    run: () => { total: number; count: number };
  }

  const cases: BenchCase[] = [
    {
      name: "Browse page 1 (50k assets, unfiltered, pageSize=60)",
      run: () => {
        const res = listAssets(db, { page: 1, pageSize: 60, sort: "newest" });
        return { total: res.total, count: res.items.length };
      }
    },
    {
      name: "Search ZH keyword ('无线降噪耳机', ~8.3k hits, pageSize=60)",
      run: () => {
        const res = listAssets(db, { q: "无线降噪耳机", page: 1, pageSize: 60, sort: "newest" });
        return { total: res.total, count: res.items.length };
      }
    },
    {
      name: "Search EN exact SPU ('SPU-0420', 50 hits)",
      run: () => {
        const res = listAssets(db, { q: "SPU-0420", page: 1, pageSize: 60, sort: "newest" });
        return { total: res.total, count: res.items.length };
      }
    },
    {
      name: "Search TH keyword ('หูฟังไร้สายตัดเสียงรบกวน', ~8.3k hits)",
      run: () => {
        const res = listAssets(db, { q: "หูฟังไร้สายตัดเสียงรบกวน", page: 1, pageSize: 60, sort: "newest" });
        return { total: res.total, count: res.items.length };
      }
    },
    {
      name: "Search 2-char short token ('TH', ~8.3k hits, fallback path)",
      run: () => {
        const res = listAssets(db, { q: "TH", page: 1, pageSize: 60, sort: "newest" });
        return { total: res.total, count: res.items.length };
      }
    },
    {
      name: "Combined filter (ZH keyword + tagId + reviewStatus=approved + type=image)",
      run: () => {
        const res = listAssets(db, {
          q: "便携咖啡机",
          tagId: sampleTagId,
          reviewStatus: "approved",
          type: "image",
          page: 1,
          pageSize: 60,
          sort: "newest"
        });
        return { total: res.total, count: res.items.length };
      }
    },
    {
      name: "Filter by productId + reviewStatus=approved",
      run: () => {
        const res = listAssets(db, {
          productId: sampleProductId,
          reviewStatus: "approved",
          page: 1,
          pageSize: 60,
          sort: "newest"
        });
        return { total: res.total, count: res.items.length };
      }
    },
    {
      name: "Search Products ('无线降噪耳机', 1k products)",
      run: () => {
        const res = listProducts(db, { q: "无线降噪耳机", page: 1, pageSize: 24 });
        return { total: res.total, count: res.items.length };
      }
    }
  ];

  console.log("\n=== Benchmark Results (Cold + 20 Warm Runs) ===");
  let worstWarmP95 = 0;
  let failed = false;

  for (const c of cases) {
    try {
      const coldStart = performance.now();
      const coldRes = c.run();
      const coldMs = performance.now() - coldStart;

      const warmTimes: number[] = [];
      for (let i = 0; i < 20; i++) {
        const t0 = performance.now();
        c.run();
        warmTimes.push(performance.now() - t0);
      }
      warmTimes.sort((a, b) => a - b);
      const p50 = percentile(warmTimes, 50);
      const p95 = percentile(warmTimes, 95);
      const max = warmTimes[warmTimes.length - 1]!;
      if (p95 > worstWarmP95) worstWarmP95 = p95;

      const status = p95 <= 500 ? "PASS" : "FAIL (>500ms)";
      if (p95 > 500) failed = true;

      console.log(
        `[${status}] ${c.name}\n` +
          `   hits=${coldRes.total} returned=${coldRes.count} | cold=${formatMs(coldMs)} | warm P50=${formatMs(p50)} P95=${formatMs(p95)} max=${formatMs(max)}`
      );
    } catch (err) {
      failed = true;
      console.error(`[ERROR] ${c.name}:`, err instanceof Error ? err.message : err);
    }
  }

  const mem = process.memoryUsage();
  console.log("\n=== Memory & Summary ===");
  console.log(`RSS: ${formatMb(mem.rss)} | Heap Used: ${formatMb(mem.heapUsed)} | External: ${formatMb(mem.external)}`);
  console.log(`Worst Warm P95: ${formatMs(worstWarmP95)} (Target: <= 500.00 ms)`);

  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });

  if (failed) {
    process.exitCode = 1;
  }
}

void main();
