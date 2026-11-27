import type { AssetSetItemRecord, ListingSkuRecord } from "../../shared/types";

export type SetItemInput = Pick<AssetSetItemRecord, "assetVersionId" | "listingSkuId">;

export function setItemInput({ assetVersionId, listingSkuId }: SetItemInput): SetItemInput {
  return { assetVersionId, listingSkuId };
}

export function isUsableSkuImage(item: Pick<AssetSetItemRecord, "assetDeleted" | "assetType">): boolean {
  return !item.assetDeleted && item.assetType === "image";
}

export function reuseSkuImages(
  sourceSkus: ListingSkuRecord[],
  sourceItems: AssetSetItemRecord[],
  targetSkus: ListingSkuRecord[],
  currentItems: AssetSetItemRecord[],
  overwrite = false
): SetItemInput[] {
  const sourceSkuIds = new Map(sourceSkus.map((sku) => [sku.id, sku.skuId]));
  const images = new Map<string, string>();
  for (const item of sourceItems) {
    const productSkuId = item.listingSkuId && sourceSkuIds.get(item.listingSkuId);
    if (productSkuId && isUsableSkuImage(item) && !images.has(productSkuId)) {
      images.set(productSkuId, item.assetVersionId);
    }
  }
  const occupied = new Set(currentItems.filter(isUsableSkuImage).map((item) => item.listingSkuId));
  const changes = targetSkus.flatMap(({ id, skuId }) => {
    const assetVersionId = images.get(skuId);
    return assetVersionId && (overwrite || !occupied.has(id)) ? [{ listingSkuId: id, assetVersionId }] : [];
  });
  const changed = new Set(changes.map((item) => item.listingSkuId));
  return [...currentItems.filter((item) => !item.listingSkuId || !changed.has(item.listingSkuId)).map(setItemInput), ...changes];
}

export function mergeUploadBatch(
  currentItems: SetItemInput[],
  orderedVersions: string[],
  previousBatchVersions: ReadonlySet<string>,
  mainVersion?: string
): SetItemInput[] {
  const currentVersions = new Set(currentItems.map((item) => item.assetVersionId));
  // A retry may reorder this batch's surviving entries, but must leave pre-existing or removed references alone.
  const batch = [...new Set(orderedVersions)].filter((version) => previousBatchVersions.has(version)
    ? currentVersions.has(version) : !currentVersions.has(version));
  const batchSet = new Set(batch);
  const pending = batch.map((assetVersionId) => ({ assetVersionId, listingSkuId: null }));
  const next: SetItemInput[] = [];
  // Fill previously appended slots before appending the rest, preserving unrelated entries.
  for (const item of currentItems) {
    if (batchSet.delete(item.assetVersionId)) {
      const replacement = pending.shift();
      if (replacement) next.push(replacement);
    } else {
      next.push(setItemInput(item));
    }
  }
  next.push(...pending);
  if (mainVersion) {
    const index = next.findIndex((item) => item.assetVersionId === mainVersion);
    if (index > 0) next.unshift(...next.splice(index, 1));
  }
  return next;
}
