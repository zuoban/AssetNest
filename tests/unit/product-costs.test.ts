import { describe, expect, it } from "vitest";
import { calculateProductCosts, parseProductCostDraft, toProductCostDraft } from "../../src/web/utils/productCosts.js";

describe("product cost calculations", () => {
  const completeDraft = {
    purchasePrice: "4.125",
    cartonLengthCm: "13.1",
    cartonWidthCm: "7.25",
    cartonHeightCm: "9.05",
    unitsPerCarton: "11",
    seaFreightRate: "1850.125"
  };

  it("calculates from full precision until display", () => {
    const { values, errors } = parseProductCostDraft(completeDraft);
    const result = calculateProductCosts(values);
    const volume = 13.1 * 7.25 * 9.05 / 1_000_000 / 11;
    const freight = volume * 1850.125;

    expect(errors).toEqual({});
    expect(toProductCostDraft(values)).toEqual(completeDraft);
    expect(result.unitVolume).toBeCloseTo(volume, 15);
    expect(result.unitSeaFreight).toBeCloseTo(freight, 14);
    expect(result.unitTotalCost).toBeCloseTo(4.125 + freight, 14);
  });

  it("calculates only results with all their inputs and treats zero as explicit", () => {
    const calculate = (changes: Partial<typeof completeDraft>) =>
      calculateProductCosts(parseProductCostDraft({ ...completeDraft, ...changes }).values);

    expect(calculate({ purchasePrice: "0", seaFreightRate: "0" })).toEqual({
      unitVolume: expect.any(Number), unitSeaFreight: 0, unitTotalCost: 0
    });
    expect(calculate({ purchasePrice: "" })).toEqual({
      unitVolume: expect.any(Number), unitSeaFreight: expect.any(Number), unitTotalCost: null
    });
    expect(calculate({ seaFreightRate: "" })).toEqual({
      unitVolume: expect.any(Number), unitSeaFreight: null, unitTotalCost: null
    });
    expect(calculate({ cartonWidthCm: "", seaFreightRate: "0" })).toEqual({
      unitVolume: null, unitSeaFreight: null, unitTotalCost: null
    });
  });

  it("distinguishes invalid input from a valid empty field", () => {
    const { values, errors } = parseProductCostDraft({
      ...completeDraft, cartonHeightCm: "0", unitsPerCarton: "1.5", seaFreightRate: ""
    });
    expect(errors).toEqual({ cartonHeightCm: expect.any(String), unitsPerCarton: expect.any(String) });
    expect(values.seaFreightRate).toBeNull();
    expect(calculateProductCosts(values).unitVolume).toBeNull();
  });
});
