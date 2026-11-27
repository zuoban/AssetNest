import {
  calculateProductCosts,
  parseProductCostDraft,
  productCostFields,
  productCostKeys,
  type ProductCostDraft
} from "../utils/productCosts";

const amountFormat = new Intl.NumberFormat("zh-CN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});
const volumeFormat = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 9 });

function formatVolume(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const formatted = value > 0 && value < 1e-9 ? value.toExponential(3) : volumeFormat.format(value);
  return `${formatted} m³`;
}

function formatAmount(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "—" : `${amountFormat.format(value)} 元/件`;
}

export function ProductCostFields({
  draft,
  onChange
}: {
  draft: ProductCostDraft;
  onChange: (draft: ProductCostDraft) => void;
}) {
  const { values, errors } = parseProductCostDraft(draft);
  const { unitVolume, unitSeaFreight, unitTotalCost } = calculateProductCosts(values);
  const results = [
    { label: "单件体积", value: formatVolume(unitVolume) },
    { label: "单件海运费", value: formatAmount(unitSeaFreight) },
    { label: "单件总成本", value: formatAmount(unitTotalCost) }
  ];

  return (
    <div className="space-y-3.5">
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
        {productCostKeys.map((key) => {
          const { label, kind } = productCostFields[key];
          const error = errors[key];
          return (
            <div key={key}>
              <label className="block font-medium text-gray-700">
                <span className="mb-1 block">{label}</span>
                <input
                  type="number"
                  name={key}
                  inputMode={kind === "count" ? "numeric" : "decimal"}
                  min={kind === "count" ? 1 : 0}
                  step={kind === "count" ? 1 : "any"}
                  value={draft[key]}
                  onChange={(event) => onChange({ ...draft, [key]: event.target.value })}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? `${key}-error` : undefined}
                  className="font-mono-tabular w-full rounded-lg border border-gray-200 px-3 py-2 focus:border-blue-500 focus:outline-none aria-invalid:border-rose-500"
                />
              </label>
              {error && <p id={`${key}-error`} className="mt-1 text-rose-700">{error}</p>}
            </div>
          );
        })}
      </div>
      <dl className="grid grid-cols-1 gap-3 rounded-lg bg-blue-50 px-3 py-3 sm:grid-cols-3" aria-live="polite">
        {results.map(({ label, value }) => (
          <div key={label}>
            <dt className="text-gray-700">{label}</dt>
            <dd className="font-mono-tabular mt-1 text-sm font-semibold text-gray-900">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
