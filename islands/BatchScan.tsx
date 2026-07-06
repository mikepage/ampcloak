import { useSignal } from "@preact/signals";

type Severity = "high" | "medium" | "low";

interface Finding {
  type: string;
  severity: Severity;
  page: string;
  ampUrl?: string;
  detail: string;
  evidence: string[];
}

interface ScanReport {
  site: string;
  startedAt: string;
  finishedAt: string;
  pagesScanned: number;
  ampPagesFound: number;
  findings: Finding[];
}

type RowStatus = "pending" | "scanning" | "done" | "error" | "cancelled";

interface BatchRow {
  domain: string;
  status: RowStatus;
  report: ScanReport | null;
  error: string | null;
}

const MAX_DOMAINS = 50;

const PLACEHOLDER = "example.com\nexample.org\nexample.net";

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

const severityClasses: Record<Severity, string> = {
  high: "bg-red-50 text-red-700 border-red-200",
  medium: "bg-yellow-50 text-yellow-700 border-yellow-200",
  low: "bg-gray-100 text-gray-600 border-gray-200",
};

const statusBadges: Record<RowStatus, { label: string; class: string }> = {
  pending: { label: "pending", class: "bg-gray-100 text-gray-500 border-gray-200" },
  scanning: { label: "scanning…", class: "bg-blue-50 text-blue-700 border-blue-200" },
  done: { label: "done", class: "bg-green-50 text-green-700 border-green-200" },
  error: { label: "error", class: "bg-red-50 text-red-700 border-red-200" },
  cancelled: { label: "cancelled", class: "bg-gray-100 text-gray-500 border-gray-200" },
};

function parseDomains(raw: string): string[] {
  const seen = new Set<string>();
  const domains: string[] = [];
  for (const line of raw.split(/[\n,]+/)) {
    const domain = line.trim();
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    domains.push(domain);
  }
  return domains;
}

function severityCounts(report: ScanReport) {
  return {
    high: report.findings.filter((f) => f.severity === "high").length,
    medium: report.findings.filter((f) => f.severity === "medium").length,
    low: report.findings.filter((f) => f.severity === "low").length,
  };
}

export default function BatchScan() {
  const input = useSignal("");
  const maxPages = useSignal(8);
  const guessAmp = useSignal(true);
  const rows = useSignal<BatchRow[]>([]);
  const isRunning = useSignal(false);
  const cancelRequested = useSignal(false);
  const error = useSignal<string | null>(null);
  const expanded = useSignal<number | null>(null);

  const domainCount = parseDomains(input.value).length;

  const updateRow = (index: number, patch: Partial<BatchRow>) => {
    rows.value = rows.value.map((row, i) => (i === index ? { ...row, ...patch } : row));
  };

  const handleRun = async () => {
    error.value = null;
    expanded.value = null;

    const domains = parseDomains(input.value);
    if (domains.length === 0) {
      error.value = "Please enter at least one domain (one per line).";
      return;
    }
    if (domains.length > MAX_DOMAINS) {
      error.value =
        `Too many domains: ${domains.length}. The batch limit is ${MAX_DOMAINS} per run.`;
      return;
    }

    rows.value = domains.map((domain) => ({
      domain,
      status: "pending",
      report: null,
      error: null,
    }));
    isRunning.value = true;
    cancelRequested.value = false;

    // Strictly sequential: one scan in flight at a time, so the server only
    // ever runs a single crawl per batch client.
    for (let i = 0; i < domains.length; i++) {
      if (cancelRequested.value) {
        rows.value = rows.value.map((row) =>
          row.status === "pending" ? { ...row, status: "cancelled" } : row
        );
        break;
      }

      updateRow(i, { status: "scanning" });
      try {
        const params = new URLSearchParams({
          url: domains[i],
          maxPages: String(maxPages.value),
          guessAmp: guessAmp.value ? "true" : "false",
        });
        const response = await fetch(`/api/scan?${params}`);
        const data = await response.json();
        if (!data.success) {
          updateRow(i, { status: "error", error: data.error || "Scan failed" });
        } else {
          updateRow(i, { status: "done", report: data.report });
        }
      } catch {
        updateRow(i, { status: "error", error: "Failed to run scan" });
      }
    }

    isRunning.value = false;
    cancelRequested.value = false;
  };

  const handleCancel = () => {
    cancelRequested.value = true;
  };

  const handleClear = () => {
    input.value = "";
    rows.value = [];
    error.value = null;
    expanded.value = null;
  };

  const doneCount = rows.value.filter((r) => r.status === "done" || r.status === "error").length;
  const totals = rows.value.reduce(
    (acc, row) => {
      if (!row.report) return acc;
      const c = severityCounts(row.report);
      return {
        high: acc.high + c.high,
        medium: acc.medium + c.medium,
        low: acc.low + c.low,
      };
    },
    { high: 0, medium: 0, low: 0 },
  );

  return (
    <div class="w-full">
      {/* Input Section */}
      <div class="bg-white rounded-lg shadow p-6 mb-6">
        <h2 class="text-lg font-semibold text-gray-800 mb-4">Batch scan</h2>

        <div class="mb-4">
          <label class="block text-sm font-medium text-gray-700 mb-1">
            Domains — one per line, max {MAX_DOMAINS}
          </label>
          <textarea
            value={input.value}
            onInput={(e) => (input.value = (e.target as HTMLTextAreaElement).value)}
            disabled={isRunning.value}
            placeholder={PLACEHOLDER}
            rows={8}
            class="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono text-sm disabled:bg-gray-50 disabled:text-gray-400"
          />
          <p
            class={`text-xs mt-1 ${domainCount > MAX_DOMAINS ? "text-red-600" : "text-gray-500"}`}
          >
            {domainCount} domain{domainCount === 1 ? "" : "s"}
            {domainCount > MAX_DOMAINS ? ` — over the limit of ${MAX_DOMAINS}` : ""}
          </p>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mb-4">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">
              Max pages per site
            </label>
            <input
              type="number"
              min={1}
              max={15}
              value={maxPages.value}
              disabled={isRunning.value}
              onInput={(e) => {
                const n = parseInt((e.target as HTMLInputElement).value, 10);
                maxPages.value = Number.isFinite(n) ? Math.min(Math.max(n, 1), 15) : 8;
              }}
              class="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono text-sm disabled:bg-gray-50 disabled:text-gray-400"
            />
          </div>
          <div class="md:col-span-3 flex items-end pb-2">
            <label class="inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={guessAmp.value}
                disabled={isRunning.value}
                onChange={(e) => (guessAmp.value = (e.target as HTMLInputElement).checked)}
                class="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
              />
              <span class="ml-2 text-sm text-gray-700">
                Probe for undeclared <span class="font-mono">/amp/</span> and{" "}
                <span class="font-mono">?amp=1</span> endpoints
              </span>
            </label>
          </div>
        </div>

        {/* Action Buttons */}
        <div class="flex flex-wrap gap-3 items-center">
          <button
            type="button"
            onClick={handleRun}
            disabled={isRunning.value || domainCount === 0 || domainCount > MAX_DOMAINS}
            class="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
          >
            {isRunning.value ? `Scanning ${doneCount + 1}/${rows.value.length}…` : "Run batch"}
          </button>
          {isRunning.value && (
            <button
              type="button"
              onClick={handleCancel}
              disabled={cancelRequested.value}
              class="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 disabled:opacity-50 transition-colors"
            >
              {cancelRequested.value ? "Stopping after current scan…" : "Cancel"}
            </button>
          )}
          {!isRunning.value && rows.value.length > 0 && (
            <button
              type="button"
              onClick={handleClear}
              class="px-4 py-2 bg-gray-200 text-gray-700 rounded-md hover:bg-gray-300 transition-colors"
            >
              Clear
            </button>
          )}
          <p class="text-xs text-gray-500">
            Domains are scanned one at a time; a full batch of {MAX_DOMAINS}{" "}
            can take several minutes.
          </p>
        </div>
      </div>

      {/* Error */}
      {error.value && (
        <div class="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
          <p class="text-red-600">{error.value}</p>
        </div>
      )}

      {/* Results table */}
      {rows.value.length > 0 && (
        <div class="bg-white rounded-lg shadow mb-6 overflow-hidden">
          <div class="px-6 py-4 border-b border-gray-100 flex flex-wrap items-center gap-x-4 gap-y-1">
            <h3 class="text-lg font-semibold text-gray-800">Results</h3>
            <span class="text-sm text-gray-500">
              {doneCount}/{rows.value.length} scanned — {totals.high} high, {totals.medium} medium,
              {" "}
              {totals.low} low findings
            </span>
          </div>
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="text-left text-gray-500 border-b border-gray-100">
                  <th class="px-6 py-2 font-medium">Domain</th>
                  <th class="px-3 py-2 font-medium">Status</th>
                  <th class="px-3 py-2 font-medium text-right">Pages</th>
                  <th class="px-3 py-2 font-medium text-right">AMP</th>
                  <th class="px-3 py-2 font-medium text-right">High</th>
                  <th class="px-3 py-2 font-medium text-right">Med</th>
                  <th class="px-3 py-2 font-medium text-right">Low</th>
                  <th class="px-6 py-2 font-medium text-right">Details</th>
                </tr>
              </thead>
              <tbody class="text-gray-700">
                {rows.value.map((row, i) => {
                  const badge = statusBadges[row.status];
                  const counts = row.report ? severityCounts(row.report) : null;
                  const findings = row.report
                    ? [...row.report.findings].sort(
                      (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
                    )
                    : [];
                  const isExpanded = expanded.value === i;
                  return (
                    <>
                      <tr key={row.domain} class="border-t border-gray-100">
                        <td class="px-6 py-2 font-mono break-all">{row.domain}</td>
                        <td class="px-3 py-2">
                          <span
                            class={`text-xs font-semibold uppercase px-2 py-0.5 rounded border whitespace-nowrap ${badge.class}`}
                          >
                            {badge.label}
                          </span>
                        </td>
                        <td class="px-3 py-2 text-right font-mono">
                          {row.report ? row.report.pagesScanned : "—"}
                        </td>
                        <td class="px-3 py-2 text-right font-mono">
                          {row.report ? row.report.ampPagesFound : "—"}
                        </td>
                        <td
                          class={`px-3 py-2 text-right font-mono ${
                            counts && counts.high > 0 ? "text-red-700 font-semibold" : ""
                          }`}
                        >
                          {counts ? counts.high : "—"}
                        </td>
                        <td
                          class={`px-3 py-2 text-right font-mono ${
                            counts && counts.medium > 0 ? "text-yellow-700 font-semibold" : ""
                          }`}
                        >
                          {counts ? counts.medium : "—"}
                        </td>
                        <td class="px-3 py-2 text-right font-mono">
                          {counts ? counts.low : "—"}
                        </td>
                        <td class="px-6 py-2 text-right">
                          {row.status === "error" && (
                            <span class="text-xs text-red-600">{row.error}</span>
                          )}
                          {row.report && findings.length > 0 && (
                            <button
                              type="button"
                              onClick={() => (expanded.value = isExpanded ? null : i)}
                              class="text-xs text-blue-600 hover:underline"
                            >
                              {isExpanded ? "Hide" : `Show ${findings.length}`}
                            </button>
                          )}
                          {row.report && findings.length === 0 && (
                            <span class="text-xs text-green-600">✓ clean</span>
                          )}
                        </td>
                      </tr>
                      {isExpanded && row.report && (
                        <tr class="border-t border-gray-100 bg-gray-50">
                          <td colSpan={8} class="px-6 py-4">
                            <div class="space-y-4">
                              {findings.map((f, j) => (
                                <div
                                  key={j}
                                  class="border-t border-gray-200 pt-3 first:border-t-0 first:pt-0"
                                >
                                  <div class="flex items-center gap-2 mb-1 flex-wrap">
                                    <span
                                      class={`text-xs font-semibold uppercase px-2 py-0.5 rounded border ${
                                        severityClasses[f.severity]
                                      }`}
                                    >
                                      {f.severity}
                                    </span>
                                    <span class="font-mono text-sm font-medium text-gray-800">
                                      {f.type}
                                    </span>
                                    <a
                                      href={f.page}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      class="font-mono text-xs text-blue-600 hover:underline break-all"
                                    >
                                      {f.page}
                                    </a>
                                  </div>
                                  <p class="text-sm text-gray-700 mb-1">{f.detail}</p>
                                  {f.evidence.slice(0, 3).map((ev, k) => (
                                    <pre
                                      key={k}
                                      class="font-mono text-xs bg-white text-red-700 p-2 rounded break-all whitespace-pre-wrap border border-gray-200 mb-1"
                                    >
                                      {ev}
                                    </pre>
                                  ))}
                                  {f.evidence.length > 3 && (
                                    <p class="text-xs text-gray-500">
                                      … and {f.evidence.length - 3} more
                                    </p>
                                  )}
                                </div>
                              ))}
                              <a
                                href={`/#${encodeURIComponent(row.domain)}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                class="inline-block text-xs text-blue-600 hover:underline"
                              >
                                Open full report in single-scan view →
                              </a>
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
