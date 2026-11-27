import type { ProductCostInputs } from "../../shared/types";

export const productCostFields = {
  purchasePrice: { label: "进货价（元/件）", kind: "amount" },
  seaFreightRate: { label: "海运费（元/m³）", kind: "amount" },
  unitsPerCarton: { label: "每箱装箱件数（件）", kind: "count" },
  cartonLengthCm: { label: "外箱长（cm）", kind: "dimension" },
  cartonWidthCm: { label: "外箱宽（cm）", kind: "dimension" },
  cartonHeightCm: { label: "外箱高（cm）", kind: "dimension" }
} as const satisfies Record<keyof ProductCostInputs, { label: string; kind: string }>;

export type ProductCostDraft = Record<keyof ProductCostInputs, string>;

export const productCostKeys = Object.keys(productCostFields) as Array<keyof ProductCostInputs>;

export function toProductCostDraft(values: Partial<ProductCostInputs> = {}): ProductCostDraft {
  return Object.fromEntries(
    productCostKeys.map((key) => [key, values[key]?.toString() ?? ""])
  ) as ProductCostDraft;
}

export function parseProductCostDraft(draft: ProductCostDraft): {
  values: ProductCostInputs;
  errors: Partial<Record<keyof ProductCostInputs, string>>;
} {
  const errors: Partial<Record<keyof ProductCostInputs, string>> = {};
  const entries = productCostKeys.map((key) => {
    if (draft[key] === "") return [key, null];

    const value = Number(draft[key]);
    const { kind, label } = productCostFields[key];
    if (kind === "count" && (!Number.isSafeInteger(value) || value < 1)) {
      errors[key] = `${label}必须为有效的正整数`;
    } else if (kind === "dimension" && (!Number.isFinite(value) || value <= 0)) {
      errors[key] = `${label}必须大于 0`;
    } else if (kind === "amount" && (!Number.isFinite(value) || value < 0)) {
      errors[key] = `${label}必须为非负数`;
    }
    return [key, errors[key] ? null : value];
  });
  return { values: Object.fromEntries(entries) as ProductCostInputs, errors };
}

export function calculateProductCosts(values: ProductCostInputs) {
  const { cartonLengthCm, cartonWidthCm, cartonHeightCm, unitsPerCarton, seaFreightRate, purchasePrice } = values;
  const unitVolume = cartonLengthCm !== null && cartonWidthCm !== null && cartonHeightCm !== null && unitsPerCarton !== null
    ? (cartonLengthCm / 100) * (cartonWidthCm / 100) * (cartonHeightCm / 100) / unitsPerCarton
    : null;
  const unitSeaFreight = unitVolume !== null && seaFreightRate !== null ? unitVolume * seaFreightRate : null;
  const unitTotalCost = unitSeaFreight !== null && purchasePrice !== null ? purchasePrice + unitSeaFreight : null;
  return { unitVolume, unitSeaFreight, unitTotalCost };
}
