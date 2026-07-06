import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";

type Severity = "high" | "medium" | "low";

interface Finding {
  type: string;
  severity: Severity;
  page: string;
  ampUrl?: string;
  detail: string;
  evidence: string[];
}

interface PageResult {
  url: string;
  ampUrl: string | null;
  ampDiscovery: "declared" | "guessed" | "self" | "none";
  findings: Finding[];
  errors: string[];
}

interface ScanReport {
  site: string;
  startedAt: string;
  finishedAt: string;
  pagesScanned: number;
  ampPagesFound: number;
  findings: Finding[];
  pages: PageResult[];
}

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

const severityClasses: Record<Severity, string> = {
  high: "bg-red-50 text-red-700 border-red-200",
  medium: "bg-yellow-50 text-yellow-700 border-yellow-200",
  low: "bg-gray-100 text-gray-600 border-gray-200",
};

function parseHash(hash: string): string | null {
  const raw = hash.replace(/^#/, "").trim();
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function updateHash(url: string) {
  if (url) {
    globalThis.history.replaceState(null, "", `#${encodeURIComponent(url)}`);
  } else {
    globalThis.history.replaceState(null, "", globalThis.location.pathname);
  }
}

export default function CloakScan() {
  const url = useSignal("");
  const maxPages = useSignal(8);
  const guessAmp = useSignal(true);
  const isLoading = useSignal(false);
  const report = useSignal<ScanReport | null>(null);
  const error = useSignal<string | null>(null);
  const initialLoadDone = useSignal(false);

  const handleScan = async () => {
    error.value = null;
    report.value = null;

    const target = url.value.trim();
    if (!target) {
      error.value = "Please enter a URL to scan";
      return;
    }

    isLoading.value = true;
    try {
      const params = new URLSearchParams({
        url: target,
        maxPages: String(maxPages.value),
        guessAmp: guessAmp.value ? "true" : "false",
      });
      const response = await fetch(`/api/scan?${params}`);
      const data = await response.json();
      if (!data.success) {
        error.value = data.error || "Scan failed";
        return;
      }
      report.value = data.report;
    } catch {
      error.value = "Failed to run scan";
    } finally {
      isLoading.value = false;
    }
  };

  const handleClear = () => {
    url.value = "";
    maxPages.value = 8;
    guessAmp.value = true;
    report.value = null;
    error.value = null;
    updateHash("");
  };

  // Parse URL hash on mount and auto-scan.
  useEffect(() => {
    const handleHashChange = () => {
      const parsed = parseHash(globalThis.location.hash);
      if (parsed) {
        url.value = parsed;
        if (!initialLoadDone.value) {
          initialLoadDone.value = true;
          handleScan();
        }
      } else {
        initialLoadDone.value = true;
      }
    };
    handleHashChange();
    globalThis.addEventListener("hashchange", handleHashChange);
    return () => globalThis.removeEventListener("hashchange", handleHashChange);
  }, []);

  // Keep the hash in sync with the URL input.
  useEffect(() => {
    if (initialLoadDone.value) updateHash(url.value.trim());
  }, [url.value]);

  const sortedFindings = report.value
    ? [...report.value.findings].sort(
      (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
    )
    : [];

  const byPage = new Map<string, Finding[]>();
  for (const f of sortedFindings) {
    const list = byPage.get(f.page) ?? [];
    list.push(f);
    byPage.set(f.page, list);
  }

  const counts = {
    high: sortedFindings.filter((f) => f.severity === "high").length,
    medium: sortedFindings.filter((f) => f.severity === "medium").length,
    low: sortedFindings.filter((f) => f.severity === "low").length,
  };

  return (
    <div class="w-full">
      {/* Input Section */}
      <div class="bg-white rounded-lg shadow p-6 mb-6">
        <h2 class="text-lg font-semibold text-gray-800 mb-4">Scan a site</h2>

        <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mb-4">
          <div class="md:col-span-3">
            <label class="block text-sm font-medium text-gray-700 mb-1">
              URL
            </label>
            <input
              type="text"
              value={url.value}
              onInput={(e) => (url.value = (e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleScan();
              }}
              placeholder="example.com"
              class="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono text-sm"
            />
          </div>

          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">
              Max pages
            </label>
            <input
              type="number"
              min={1}
              max={15}
              value={maxPages.value}
              onInput={(e) => {
                const n = parseInt((e.target as HTMLInputElement).value, 10);
                maxPages.value = Number.isFinite(n) ? Math.min(Math.max(n, 1), 15) : 8;
              }}
              class="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono text-sm"
            />
          </div>
        </div>

        <div class="mb-4">
          <label class="inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={guessAmp.value}
              onChange={(e) => (guessAmp.value = (e.target as HTMLInputElement).checked)}
              class="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
            />
            <span class="ml-2 text-sm text-gray-700">
              Probe for undeclared <span class="font-mono">/amp/</span> and{" "}
              <span class="font-mono">?amp=1</span> endpoints
            </span>
          </label>
        </div>

        {/* Action Buttons */}
        <div class="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={handleScan}
            disabled={!url.value.trim() || isLoading.value}
            class="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
          >
            {isLoading.value ? "Scanning..." : "Scan"}
          </button>
          <button
            type="button"
            onClick={handleClear}
            class="px-4 py-2 bg-gray-200 text-gray-700 rounded-md hover:bg-gray-300 transition-colors"
          >
            Clear
          </button>
        </div>
      </div>

      {/* Error */}
      {error.value && (
        <div class="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
          <p class="text-red-600">{error.value}</p>
        </div>
      )}

      {/* Results */}
      {report.value && (
        <>
          <div class="bg-white rounded-lg shadow p-6 mb-6">
            <h3 class="text-lg font-semibold text-gray-800 mb-4">
              Scan of {report.value.site}
            </h3>
            <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <span class="text-sm text-gray-500">Pages scanned</span>
                <p class="font-mono text-sm bg-gray-50 p-2 rounded mt-1">
                  {report.value.pagesScanned}
                </p>
              </div>
              <div>
                <span class="text-sm text-gray-500">AMP variants</span>
                <p class="font-mono text-sm bg-gray-50 p-2 rounded mt-1">
                  {report.value.ampPagesFound}
                </p>
              </div>
              <div>
                <span class="text-sm text-gray-500">Findings</span>
                <p class="font-mono text-sm bg-gray-50 p-2 rounded mt-1">
                  {sortedFindings.length}
                </p>
              </div>
              <div>
                <span class="text-sm text-gray-500">Severity</span>
                <p class="font-mono text-sm bg-gray-50 p-2 rounded mt-1">
                  {counts.high} high, {counts.medium} med, {counts.low} low
                </p>
              </div>
            </div>
          </div>

          {sortedFindings.length === 0
            ? (
              <div class="bg-green-50 border border-green-200 rounded-lg p-4 mb-6">
                <p class="text-green-700 font-medium">
                  ✓ No AMP-specific injections or cloaking detected.
                </p>
                <p class="text-green-600 text-xs mt-1">
                  This checks server-rendered HTML. Payloads injected at runtime by JS are out of
                  scope.
                </p>
              </div>
            )
            : (
              Array.from(byPage.entries()).map(([page, findings]) => (
                <div key={page} class="bg-white rounded-lg shadow p-6 mb-6">
                  <a
                    href={page}
                    target="_blank"
                    rel="noopener noreferrer"
                    class="text-sm font-mono text-blue-600 hover:underline break-all"
                  >
                    {page}
                  </a>
                  <div class="mt-4 space-y-4">
                    {findings.map((f, i) => (
                      <div
                        key={i}
                        class="border-t border-gray-100 pt-4 first:border-t-0 first:pt-0"
                      >
                        <div class="flex items-center gap-2 mb-2">
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
                        </div>
                        {f.ampUrl && f.ampUrl !== page && (
                          <p class="text-xs text-gray-500 mb-1 break-all">
                            AMP variant: {f.ampUrl}
                          </p>
                        )}
                        <p class="text-sm text-gray-700 mb-2">{f.detail}</p>
                        {f.evidence.length > 0 && (
                          <div class="space-y-1">
                            {f.evidence.slice(0, 8).map((ev, j) => (
                              <pre
                                key={j}
                                class="font-mono text-xs bg-gray-50 text-red-700 p-2 rounded break-all whitespace-pre-wrap"
                              >
                                {ev}
                              </pre>
                            ))}
                            {f.evidence.length > 8 && (
                              <p class="text-xs text-gray-500">
                                … and {f.evidence.length - 8} more
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
        </>
      )}

      {/* Reference Section */}
      <details class="bg-white rounded-lg shadow">
        <summary class="p-4 cursor-pointer font-medium text-gray-800 hover:bg-gray-50">
          What cloakscan checks
        </summary>
        <div class="p-4 pt-0 border-t">
          <table class="w-full text-sm">
            <thead>
              <tr class="text-left text-gray-500">
                <th class="pb-2">Finding</th>
                <th class="pb-2">Meaning</th>
              </tr>
            </thead>
            <tbody class="text-gray-700">
              <tr class="border-t border-gray-100">
                <td class="py-2 font-mono">ua-cloaking</td>
                <td class="py-2">
                  Googlebot receives external references a browser does not.
                </td>
              </tr>
              <tr class="border-t border-gray-100">
                <td class="py-2 font-mono">amp-cloaked-injection</td>
                <td class="py-2">
                  The Google AMP cache fetch receives content a browser does not.
                </td>
              </tr>
              <tr class="border-t border-gray-100">
                <td class="py-2 font-mono">disallowed-script-in-amp</td>
                <td class="py-2">
                  AMP page loads scripts from outside cdn.ampproject.org.
                </td>
              </tr>
              <tr class="border-t border-gray-100">
                <td class="py-2 font-mono">inline-script-in-amp</td>
                <td class="py-2">Executable inline JS in an AMP document (invalid AMP).</td>
              </tr>
              <tr class="border-t border-gray-100">
                <td class="py-2 font-mono">meta-refresh-in-amp</td>
                <td class="py-2">AMP variant meta-refreshes visitors to an external site.</td>
              </tr>
              <tr class="border-t border-gray-100">
                <td class="py-2 font-mono">amp-only-external-link</td>
                <td class="py-2">External links present only in the AMP variant.</td>
              </tr>
              <tr class="border-t border-gray-100">
                <td class="py-2 font-mono">amp-only-iframe / -form / -script</td>
                <td class="py-2">
                  External iframe, form or script present only in the AMP variant.
                </td>
              </tr>
              <tr class="border-t border-gray-100">
                <td class="py-2 font-mono">hidden-amp-endpoint</td>
                <td class="py-2">
                  An AMP document served at a URL the page never declares.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
