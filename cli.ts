import { parseArgs } from "@std/cli/parse-args";
import { dim } from "@std/fmt/colors";
import { printReport } from "./src/report.ts";
import { scanSite } from "./src/scanner.ts";
import type { ScanOptions } from "./src/types.ts";

const VERSION = "0.1.0";

const HELP = `cloakscan ${VERSION}
Detect cloaking: content (links, scripts, iframes) served to search-engine
crawlers or the Google AMP cache that a normal browser never receives.

Usage:
  cloakscan <url> [options]

Options:
  -m, --max-pages <n>    Maximum pages to crawl (default: 25)
  -c, --concurrency <n>  Parallel page scans (default: 4)
      --timeout <ms>     Per-request timeout in ms (default: 15000)
      --json <file>      Also write the full report as JSON
      --no-guess         Do not probe for undeclared /amp/ and ?amp=1 endpoints
  -q, --quiet            No progress output, findings only
  -h, --help             Show this help
  -v, --version          Show version

Exit codes:
  0  clean, 1  findings detected, 2  usage or runtime error

Each page is fetched as a regular browser, as Googlebot, and (for the AMP
variant) as the Google AMP cache; differences between what those requests
receive are reported as cloaking.`;

function fail(message: string): never {
  console.error(`error: ${message}`);
  console.error(`Run with --help for usage.`);
  Deno.exit(2);
}

const args = parseArgs(Deno.args, {
  boolean: ["help", "version", "quiet", "guess"],
  string: ["json", "max-pages", "concurrency", "timeout"],
  alias: { h: "help", v: "version", m: "max-pages", c: "concurrency", q: "quiet" },
  default: { guess: true },
  negatable: ["guess"],
  unknown: (arg, key) => {
    if (key) fail(`unknown option: ${arg}`);
    return true;
  },
});

if (args.help) {
  console.log(HELP);
  Deno.exit(0);
}
if (args.version) {
  console.log(`cloakscan ${VERSION}`);
  Deno.exit(0);
}

const target = String(args._[0] ?? "");
if (!target) fail("missing <url>");

let startUrl: URL;
try {
  startUrl = new URL(target.includes("://") ? target : `https://${target}`);
} catch {
  fail(`invalid URL: ${target}`);
}
if (startUrl.protocol !== "http:" && startUrl.protocol !== "https:") {
  fail(`unsupported protocol: ${startUrl.protocol}`);
}

const parsePositiveInt = (value: string | undefined, name: string, fallback: number): number => {
  if (value === undefined) return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) fail(`--${name} must be a positive integer`);
  return n;
};

const options: ScanOptions = {
  startUrl: startUrl.href,
  maxPages: parsePositiveInt(args["max-pages"], "max-pages", 25),
  concurrency: parsePositiveInt(args.concurrency, "concurrency", 4),
  timeoutMs: parsePositiveInt(args.timeout, "timeout", 15000),
  guessAmp: args.guess,
  quiet: args.quiet,
};

const onProgress = options.quiet ? () => {} : (msg: string) => console.error(dim(msg));

try {
  const report = await scanSite(options, onProgress);
  printReport(report);
  if (args.json) {
    await Deno.writeTextFile(args.json, JSON.stringify(report, null, 2));
    console.log(dim(`\nJSON report written to ${args.json}`));
  }
  Deno.exit(report.findings.length > 0 ? 1 : 0);
} catch (err) {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  Deno.exit(2);
}
