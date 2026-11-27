import { describe, expect, it } from "vitest";
import type { FolderRecord } from "../../src/shared/types";
import {
  buildFolderTree,
  collectExpandableFolderIds,
  formatFolderSelectOption,
  getFolderBreadcrumb,
  getFolderSubtreeIdSet
} from "../../src/web/utils/folderTree";

function makeFolder(
  id: string,
  name: string,
  opts: { parentId?: string | null; position?: number; assetCount?: number } = {}
): FolderRecord {
  return {
    id,
    name,
    parentId: opts.parentId ?? null,
    position: opts.position ?? 0,
    assetCount: opts.assetCount ?? 0,
    createdAt: "2026-11-27T00:00:00.000Z",
    updatedAt: "2026-11-27T00:00:00.000Z"
  };
}

describe("folderTree utilities", () => {
  it("builds a multi-level tree with aggregated counts, paths, and deterministic sorting", () => {
    const folders: FolderRecord[] = [
      makeFolder("root-b", "B目录", { position: 1, assetCount: 2 }),
      makeFolder("root-a", "A目录", { position: 0, assetCount: 1 }),
      makeFolder("child-a2", "主图", { parentId: "root-a", position: 2, assetCount: 3 }),
      makeFolder("child-a1", "白底图", { parentId: "root-a", position: 1, assetCount: 4 }),
      makeFolder("grand-1", "泰语版", { parentId: "child-a2", position: 0, assetCount: 5 })
    ];

    const tree = buildFolderTree(folders);

    expect(tree.roots.map((n) => n.folder.id)).toEqual(["root-a", "root-b"]);

    const rootA = tree.nodeMap.get("root-a")!;
    expect(rootA.depth).toBe(0);
    expect(rootA.directAssetCount).toBe(1);
    expect(rootA.totalAssetCount).toBe(1 + 4 + 3 + 5);
    expect(rootA.descendantFolderCount).toBe(3);
    expect(rootA.children.map((c) => c.folder.id)).toEqual(["child-a1", "child-a2"]);

    const grand = tree.nodeMap.get("grand-1")!;
    expect(grand.depth).toBe(2);
    expect(grand.pathNames).toEqual(["A目录", "主图", "泰语版"]);
    expect(grand.pathLabel).toBe("A目录 / 主图 / 泰语版");
    expect(grand.ancestorIds).toEqual(["root-a", "child-a2"]);

    // Flat order is depth-first pre-order
    expect(tree.flatNodes.map((n) => n.folder.id)).toEqual([
      "root-a",
      "child-a1",
      "child-a2",
      "grand-1",
      "root-b"
    ]);
  });

  it("computes subtree id sets, breadcrumbs, select labels, and expandable ids", () => {
    const folders: FolderRecord[] = [
      makeFolder("r", "商品素材"),
      makeFolder("c1", "东南亚", { parentId: "r" }),
      makeFolder("c2", "欧美", { parentId: "r" }),
      makeFolder("g1", "Shopee TH", { parentId: "c1" })
    ];

    const tree = buildFolderTree(folders);

    const subtree = getFolderSubtreeIdSet(tree.nodeMap, "c1");
    expect([...subtree].sort()).toEqual(["c1", "g1"]);

    const crumbs = getFolderBreadcrumb(tree.nodeMap, "g1");
    expect(crumbs.map((n) => n.folder.name)).toEqual(["商品素材", "东南亚", "Shopee TH"]);

    expect(formatFolderSelectOption(tree.nodeMap.get("r")!)).toBe("商品素材");
    expect(formatFolderSelectOption(tree.nodeMap.get("c1")!)).toBe("\u00A0\u00A0└ 东南亚");
    expect(formatFolderSelectOption(tree.nodeMap.get("g1")!)).toBe("\u00A0\u00A0\u00A0\u00A0└ Shopee TH");

    expect(collectExpandableFolderIds(tree.roots)).toEqual(["r", "c1"]);
  });

  it("safely promotes orphaned and cyclic folder references to roots without crashing", () => {
    const folders: FolderRecord[] = [
      makeFolder("orphan", "孤儿目录", { parentId: "missing-parent", assetCount: 1 }),
      makeFolder("cyc-a", "循环A", { parentId: "cyc-b", assetCount: 2 }),
      makeFolder("cyc-b", "循环B", { parentId: "cyc-a", assetCount: 3 })
    ];

    const tree = buildFolderTree(folders);
    expect(tree.roots.length).toBe(3);
    expect(tree.flatNodes.length).toBe(3);
    expect(tree.nodeMap.get("orphan")?.depth).toBe(0);
    expect(tree.nodeMap.get("cyc-a")?.depth).toBe(0);
    expect(tree.nodeMap.get("cyc-b")?.depth).toBe(0);
  });
});
