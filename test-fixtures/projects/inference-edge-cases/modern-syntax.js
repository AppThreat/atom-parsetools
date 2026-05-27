const config = {
  mode: "prod",
  retries: 3,
  features: {
    tracing: true,
    sampling: 0.25
  }
};

const mode = config.mode;
const tracingEnabled = config.features.tracing;
const samplingRate = config.features?.sampling ?? 1;
const mergedConfig = { ...config, region: "us-east-1" };

const records = [
  { kind: "ok", value: 1 },
  { kind: "error", message: "failed" }
];

const okRecords = records.filter(record => record.kind === "ok");
const recordKinds = records.map(record => record.kind);
const totalValue = records.reduce((sum, record) => sum + ("value" in record ? record.value : 0), 0);

const matrix = [[1, 2], [3, 4]];
const flattenedMatrix = matrix.flat();
const matrixFirst = matrix.at(0)?.at(1);

const formatter = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const formattedTotal = formatter.format(totalValue);

const url = new URL("https://example.com/path?debug=true");
const debugParam = url.searchParams.get("debug");
const urlParts = [url.protocol, url.hostname, url.pathname];

const uniqueKinds = new Set(recordKinds);
const kindArray = Array.from(uniqueKinds);
const kindSummary = kindArray.join(",");

const dynamicKey = "mode";
const dynamicValue = config[dynamicKey];
const optionalMissing = config.missing?.value;

void [
  mode,
  tracingEnabled,
  samplingRate,
  okRecords,
  flattenedMatrix,
  matrixFirst,
  debugParam,
  urlParts,
  dynamicValue,
  optionalMissing
];

export { formattedTotal, kindSummary, mergedConfig };
