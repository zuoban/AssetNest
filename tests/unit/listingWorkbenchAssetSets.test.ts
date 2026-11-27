import { describe, expect, it } from "vitest";
import type { AssetSetItemRecord, ListingSkuRecord } from "../../src/shared/types";
import { mergeUploadBatch, reuseSkuImages, setItemInput } from "../../src/web/components/listingWorkbenchAssetSets";

const image = (assetVersionId: string, listingSkuId: string | null = null) => ({ assetVersionId, listingSkuId });

function sku(id: string, skuId: string): ListingSkuRecord {
  return { id, skuId, channelCode: id, skuCode: skuId } as ListingSkuRecord;
}

function skuImage(version: string, listingSkuId: string, options: Partial<AssetSetItemRecord> = {}): AssetSetItemRecord {
  return { ...image(version, listingSkuId), assetDeleted: false, assetType: "image", ...options } as AssetSetItemRecord;
}

describe("mergeUploadBatch", () => {
  it("restores batch order after a partial failure and keeps the selected main image", () => {
    const first = mergeUploadBatch([image("old")], ["second", "main"], new Set(), "main");
    expect(first).toEqual([image("main"), image("old"), image("second")]);
    expect(mergeUploadBatch(first, ["first", "second", "main"], new Set(["second", "main"]), "main"))
      .toEqual([image("main"), image("first"), image("old"), image("second")]);
  });

  it("preserves pre-existing and duplicate references and skips a batch item removed elsewhere", () => {
    const current = [image("old"), image("old"), image("batch"), image("batch")];
    expect(mergeUploadBatch(current, ["old", "removed", "new", "batch", "new"], new Set(["removed", "batch"])))
      .toEqual([image("old"), image("old"), image("new"), image("batch"), image("batch")]);
  });
});

describe("reuseSkuImages", () => {
  const sourceSkus = [sku("source-a", "a"), sku("source-b", "b"), sku("source-d", "d")];
  const targetSkus = [sku("target-a", "a"), sku("target-b", "b"), sku("target-c", "c"), sku("target-d", "d")];
  const source = [
    skuImage("deleted", "source-a", { assetDeleted: true }),
    skuImage("first-a", "source-a"),
    skuImage("second-a", "source-a"),
    skuImage("fixed-b", "source-b"),
    skuImage("video-d", "source-d", { assetType: "video" })
  ];
  const current = [skuImage("current-a", "target-a"), skuImage("removed-b", "target-b", { assetDeleted: true }), skuImage("current-c", "target-c")];

  it("matches product SKU IDs, retaining usable and unmatched target references by default", () => {
    expect(reuseSkuImages(sourceSkus, source, targetSkus, current)).toEqual([
      setItemInput(current[0]!), setItemInput(current[2]!), image("fixed-b", "target-b")
    ]);
  });

  it("overwrites matched SKUs with the first usable fixed version when requested", () => {
    expect(reuseSkuImages(sourceSkus, source, targetSkus, current, true)).toEqual([
      image("current-c", "target-c"), image("first-a", "target-a"), image("fixed-b", "target-b")
    ]);
  });
});
