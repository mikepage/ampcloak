import { define } from "../../utils.ts";
import { scanSite } from "../../src/scanner.ts";
import type { ScanOptions } from "../../src/types.ts";

// Server-side limits so a single request can't crawl unbounded or hang forever.
const MAX_PAGES_CAP = 15;
const CONCURRENCY = 4;
const TIMEOUT_MS = 12000;

function normalizeTarget(raw: string): URL | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

export const handler = define.handlers({
  async GET(ctx) {
    const params = ctx.url.searchParams;
    const target = normalizeTarget(params.get("url") ?? "");
    if (!target) {
      return Response.json(
        { success: false, error: "Please enter a valid http(s) URL." },
        { status: 400 },
      );
    }

    const requested = Number.parseInt(params.get("maxPages") ?? "", 10);
    const maxPages = Number.isFinite(requested) && requested > 0
      ? Math.min(requested, MAX_PAGES_CAP)
      : 8;
    const guessAmp = params.get("guessAmp") !== "false";

    const options: ScanOptions = {
      startUrl: target.href,
      maxPages,
      concurrency: CONCURRENCY,
      timeoutMs: TIMEOUT_MS,
      guessAmp,
      quiet: true,
    };

    try {
      const report = await scanSite(options, () => {});
      return Response.json({ success: true, report });
    } catch (err) {
      return Response.json(
        { success: false, error: err instanceof Error ? err.message : String(err) },
        { status: 500 },
      );
    }
  },
});
