import { describe, expect, it } from "vitest";
import type { FolderRecord } from "../../src/shared/types";
import {
  buildFolderPathMap,
  clearRecentVisits,
  getContextualCommands,
  getHighlightRanges,
  isCommandKShortcut,
  isEditableElement,
  loadRecentVisits,
  parseCommandQuery,
  recordRecentVisit,
  scoreCommandMatch
} from "../../src/web/utils/commandPalette";

function makeFolder(id: string, name: string, parentId: string | null = null): FolderRecord {
  return {
    id,
    parentId,
    name,
    position: 0,
    assetCount: 0,
    createdAt: "2026-11-27T00:00:00.000Z",
    updatedAt: "2026-11-27T00:00:00.000Z"
  };
}

function createMockStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    }
  };
}

describe("commandPalette utilities", () => {
  describe("parseCommandQuery", () => {
    it("parses plain queries under default all scope", () => {
      expect(parseCommandQuery("  tumbler mug  ")).toEqual({
        scope: "all",
        term: "tumbler mug",
        prefixApplied: false
      });
    });

    it("detects scope prefixes case-insensitively and trims leading whitespace", () => {
      expect(parseCommandQuery("> 设置")).toEqual({
        scope: "nav",
        term: "设置",
        prefixApplied: true
      });
      expect(parseCommandQuery("p: SPU-001")).toEqual({
        scope: "product",
        term: "SPU-001",
        prefixApplied: true
      });
      expect(parseCommandQuery("  P: 保温杯 ")).toEqual({
        scope: "product",
        term: "保温杯",
        prefixApplied: true
      });
      expect(parseCommandQuery("#SPU-002")).toEqual({
        scope: "product",
        term: "SPU-002",
        prefixApplied: true
      });
      expect(parseCommandQuery("l: shopee")).toEqual({
        scope: "listing",
        term: "shopee",
        prefixApplied: true
      });
      expect(parseCommandQuery("L: PH")).toEqual({
        scope: "listing",
        term: "PH",
        prefixApplied: true
      });
      expect(parseCommandQuery("a: hero.png")).toEqual({
        scope: "asset",
        term: "hero.png",
        prefixApplied: true
      });
      expect(parseCommandQuery("A: 视频")).toEqual({
        scope: "asset",
        term: "视频",
        prefixApplied: true
      });
      expect(parseCommandQuery("s: 旗舰店")).toEqual({
        scope: "store",
        term: "旗舰店",
        prefixApplied: true
      });
      expect(parseCommandQuery("S: lazada")).toEqual({
        scope: "store",
        term: "lazada",
        prefixApplied: true
      });
    });

    it("respects explicit scope without stripping prefixes", () => {
      expect(parseCommandQuery("p: SPU-001", "listing")).toEqual({
        scope: "listing",
        term: "p: SPU-001",
        prefixApplied: false
      });
    });
  });

  describe("scoreCommandMatch", () => {
    it("returns 1 for empty or whitespace queries", () => {
      expect(scoreCommandMatch("", [{ text: "anything" }])).toBe(1);
      expect(scoreCommandMatch("   ", [{ text: "anything" }])).toBe(1);
    });

    it("ranks exact > prefix > word-boundary > mid-word > fuzzy subsequence", () => {
      const exact = scoreCommandMatch("mug", [{ text: "mug" }]);
      const prefix = scoreCommandMatch("mug", [{ text: "mug-pro" }]);
      const boundary = scoreCommandMatch("mug", [{ text: "travel-mug" }]);
      const midWord = scoreCommandMatch("mug", [{ text: "smuggle" }]);
      const fuzzy = scoreCommandMatch("tmg", [{ text: "travel-mug" }]);

      expect(exact).toBeGreaterThan(prefix);
      expect(prefix).toBeGreaterThan(boundary);
      expect(boundary).toBeGreaterThan(midWord);
      expect(midWord).toBeGreaterThan(fuzzy);
      expect(fuzzy).toBeGreaterThan(0);
    });

    it("requires all space-separated tokens to match across fields and applies weights", () => {
      const matched = scoreCommandMatch("shopee ph", [
        { text: "PH 旗舰店", weight: 1.3 },
        { text: "shopee", weight: 0.9 }
      ]);
      expect(matched).toBeGreaterThan(0);

      const partial = scoreCommandMatch("shopee th", [
        { text: "PH 旗舰店", weight: 1.3 },
        { text: "shopee", weight: 0.9 }
      ]);
      expect(partial).toBe(0);

      const higherWeight = scoreCommandMatch("tumbler", [
        { text: "tumbler", weight: 1.5 }
      ]);
      const normalWeight = scoreCommandMatch("tumbler", [
        { text: "tumbler", weight: 1.0 }
      ]);
      expect(higherWeight).toBeGreaterThan(normalWeight);
    });

    it("does not fuzzy-match single characters that are absent", () => {
      expect(scoreCommandMatch("z", [{ text: "abcdef" }])).toBe(0);
    });
  });

  describe("getHighlightRanges", () => {
    it("returns empty array when query or text is empty", () => {
      expect(getHighlightRanges("", "abc")).toEqual([]);
      expect(getHighlightRanges("hello", "")).toEqual([]);
      expect(getHighlightRanges("hello", "   ")).toEqual([]);
    });

    it("finds case-insensitive matches and merges overlapping or adjacent ranges", () => {
      expect(getHighlightRanges("Shopee PH Flagship", "shopee ph")).toEqual([
        [0, 6],
        [7, 9]
      ]);

      // Overlapping tokens ("spu" and "spu-01") merge into a single clean range
      expect(getHighlightRanges("SPU-01 Tumbler", "spu spu-01")).toEqual([[0, 6]]);

      // Adjacent matches ("ab" + "cd") merge cleanly
      expect(getHighlightRanges("abcdef", "ab cd")).toEqual([[0, 4]]);
    });
  });

  describe("buildFolderPathMap", () => {
    it("builds full hierarchical paths and guards against cycles", () => {
      const folders: FolderRecord[] = [
        makeFolder("root", "主图目录", null),
        makeFolder("child", "Shopee", "root"),
        makeFolder("grand", "泰语版", "child"),
        makeFolder("orphan", "孤立目录", "missing-parent"),
        makeFolder("cyc-a", "循环A", "cyc-b"),
        makeFolder("cyc-b", "循环B", "cyc-a")
      ];

      const map = buildFolderPathMap(folders);
      expect(map.get("root")).toBe("主图目录");
      expect(map.get("child")).toBe("主图目录 / Shopee");
      expect(map.get("grand")).toBe("主图目录 / Shopee / 泰语版");
      expect(map.get("orphan")).toBe("孤立目录");
      expect(map.get("cyc-a")).toBe("循环B / 循环A");
      expect(map.get("cyc-b")).toBe("循环A / 循环B");
    });
  });

  describe("getContextualCommands", () => {
    it("returns product detail tab shortcuts", () => {
      const cmds = getContextualCommands("/products/prod-42");
      expect(cmds.map((c) => c.to)).toEqual([
        "/products/prod-42?tab=overview",
        "/products/prod-42?tab=skus",
        "/products/prod-42?tab=assets",
        "/products/prod-42?tab=listings"
      ]);
    });

    it("returns listing workbench section and tab shortcuts", () => {
      const cmds = getContextualCommands("/listings/list-99");
      expect(cmds.map((c) => c.to)).toEqual([
        "/listings/list-99?tab=assets&assetGroup=carousel",
        "/listings/list-99?tab=assets&assetGroup=detail",
        "/listings/list-99?tab=assets&assetGroup=sku",
        "/listings/list-99?tab=assets&assetGroup=video",
        "/listings/list-99?tab=skus",
        "/listings/list-99?tab=pdp",
        "/listings/list-99?tab=release"
      ]);
    });

    it("returns contextual commands for stores, jobs, and assets pages", () => {
      expect(getContextualCommands("/stores").map((c) => c.to)).toEqual([
        "/stores?tab=stores",
        "/stores?tab=dictionaries"
      ]);
      expect(getContextualCommands("/jobs").map((c) => c.to)).toEqual([
        "/jobs?tab=jobs",
        "/jobs?tab=activities"
      ]);
      expect(getContextualCommands("/assets").map((c) => c.to)).toEqual([
        "/assets?quickView=all",
        "/assets?quickView=favorite",
        "/assets?quickView=unfiled"
      ]);
      expect(getContextualCommands("/")).toEqual([]);
      expect(getContextualCommands("/settings")).toEqual([]);
    });
  });

  describe("keyboard helpers", () => {
    it("matches Cmd+K and Ctrl+K while rejecting Alt combos and other keys", () => {
      expect(
        isCommandKShortcut({ key: "k", metaKey: true, ctrlKey: false, altKey: false })
      ).toBe(true);
      expect(
        isCommandKShortcut({ key: "K", metaKey: false, ctrlKey: true, altKey: false })
      ).toBe(true);
      expect(
        isCommandKShortcut({ key: "k", metaKey: true, ctrlKey: false, altKey: true })
      ).toBe(false);
      expect(
        isCommandKShortcut({ key: "k", metaKey: false, ctrlKey: false, altKey: false })
      ).toBe(false);
      expect(
        isCommandKShortcut({ key: "j", metaKey: true, ctrlKey: false, altKey: false })
      ).toBe(false);
    });

    it("detects editable elements accurately", () => {
      expect(isEditableElement(null)).toBe(false);
      expect(isEditableElement({ tagName: "INPUT" } as unknown as EventTarget)).toBe(true);
      expect(isEditableElement({ tagName: "textarea" } as unknown as EventTarget)).toBe(true);
      expect(isEditableElement({ tagName: "SELECT" } as unknown as EventTarget)).toBe(true);
      expect(
        isEditableElement({ tagName: "DIV", isContentEditable: true } as unknown as EventTarget)
      ).toBe(true);
      expect(
        isEditableElement({
          tagName: "SPAN",
          closest: (sel: string) => (sel === '[contenteditable="true"]' ? {} : null)
        } as unknown as EventTarget)
      ).toBe(true);
      expect(
        isEditableElement({
          tagName: "BUTTON",
          isContentEditable: false,
          closest: () => null
        } as unknown as EventTarget)
      ).toBe(false);
    });
  });

  describe("recent visits persistence", () => {
    it("records, deduplicates, caps at 8, and clears recent visits", () => {
      const storage = createMockStorage();
      expect(loadRecentVisits(storage)).toEqual([]);

      for (let i = 1; i <= 10; i += 1) {
        recordRecentVisit(
          {
            kind: "product",
            title: `商品 ${i}`,
            subtitle: `SPU-${i}`,
            to: `/products/p-${i}`
          },
          storage
        );
      }

      const loaded = loadRecentVisits(storage);
      expect(loaded).toHaveLength(8);
      expect(loaded[0].to).toBe("/products/p-10");
      expect(loaded[7].to).toBe("/products/p-3");

      // Re-visiting an older item moves it to the front without duplicating
      recordRecentVisit(
        {
          kind: "product",
          title: "商品 5（更新）",
          subtitle: "SPU-5",
          to: "/products/p-5"
        },
        storage
      );

      const deduped = loadRecentVisits(storage);
      expect(deduped).toHaveLength(8);
      expect(deduped[0].to).toBe("/products/p-5");
      expect(deduped[0].title).toBe("商品 5（更新）");
      expect(deduped.filter((item) => item.to === "/products/p-5")).toHaveLength(1);

      // Ignores blank destination
      const beforeBlank = loadRecentVisits(storage);
      recordRecentVisit({ kind: "page", title: "Empty", to: "   " }, storage);
      expect(loadRecentVisits(storage)).toEqual(beforeBlank);

      clearRecentVisits(storage);
      expect(loadRecentVisits(storage)).toEqual([]);
    });

    it("handles corrupted storage JSON and null storage gracefully", () => {
      const storage = createMockStorage();
      storage.setItem("assetnest:recent-visits:v1", "{bad-json");
      expect(loadRecentVisits(storage)).toEqual([]);

      storage.setItem(
        "assetnest:recent-visits:v1",
        JSON.stringify([{ bad: true }, { kind: "page", title: "Valid", to: "/jobs", visitedAt: 1 }])
      );
      expect(loadRecentVisits(storage)).toHaveLength(1);

      expect(loadRecentVisits(null)).toEqual([]);
      expect(
        recordRecentVisit({ kind: "page", title: "Jobs", to: "/jobs" }, null)
      ).toHaveLength(1);
      expect(() => clearRecentVisits(null)).not.toThrow();
    });
  });
});
