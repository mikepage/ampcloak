# cloakscan

Detect **cloaking**: content served to search-engine crawlers or the Google AMP cache that a normal
browser never receives.

> **What it detects, precisely:** cloakscan reports when a bot/cache request receives external
> (cross-domain) links, scripts or iframes that a browser request to the same URL does not. That is
> a behavioral signal — a strong indicator of SEO-spam or malware injection — not a malware verdict.
> It does not fingerprint payloads or check host reputation; confirming maliciousness is your step.

## Why

A common class of website malware (rogue WordPress plugins, compromised themes, injected rewrite
rules) serves its payload only to requests that look like Google's crawler or the Google AMP cache,
and often hides it in the **AMP version** of pages. Security scanners that fetch the canonical page
with a normal browser user agent see a perfectly clean site — while search-engine visitors get spam
links, redirects or phishing content.

This tool closes that blind spot. For every crawled page it fetches up to four views:

| Fetch | URL            | Disguise                                                       |
| ----- | -------------- | -------------------------------------------------------------- |
| 1     | canonical page | regular Chrome browser                                         |
| 2     | canonical page | Googlebot smartphone                                           |
| 3     | AMP variant    | regular Chrome browser                                         |
| 4     | AMP variant    | Google AMP cache (`AMP-Cache-Transform` header + Googlebot UA) |

…then diffs what each view receives and validates the AMP documents themselves.

## What it detects

| Finding                                                 | Severity    | Meaning                                                                                       |
| ------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------- |
| `amp-cloaked-injection`                                 | high        | The AMP cache fetch receives external scripts/iframes/links a browser doesn't                 |
| `ua-cloaking`                                           | medium/high | Googlebot receives external content a browser doesn't                                         |
| `disallowed-script-in-amp`                              | high        | `<script src>` not from `cdn.ampproject.org` inside an AMP document (invalid AMP → injected)  |
| `inline-script-in-amp`                                  | high        | Executable inline JS inside an AMP document (only JSON/LD+JSON is legal)                      |
| `meta-refresh-in-amp`                                   | high        | AMP variant meta-refreshes visitors to an external site                                       |
| `amp-only-external-link`                                | medium/high | External links present only in the AMP variant, not on the canonical page                     |
| `amp-only-iframe` / `amp-only-script` / `amp-only-form` | high        | External iframes/scripts/forms present only in the AMP variant                                |
| `hidden-amp-endpoint`                                   | medium      | An AMP document answers at `/amp/` or `?amp=1` although the canonical page never declares one |

Findings with SEO-spam keywords in their URLs (casino, pills, payday, replica, …) are upgraded to
high severity.

## Web app

cloakscan is a [Deno Fresh](https://fresh.deno.dev/) web app: enter a URL, scan it in the browser,
and read the findings grouped by page and severity.

```sh
deno install     # first time only
deno task dev     # dev server with hot reload → http://localhost:5173
deno task build   # production build → _fresh/
deno task start   # serve the production build → http://localhost:8000
```

The scan runs server-side via `GET /api/scan?url=<url>&maxPages=<n>&guessAmp=<bool>`, which returns
the full JSON report. Crawl depth is capped at 15 pages per request.

## Command line

The same scanner is available as a CLI.

```sh
deno task cli https://example.com

# or the compiled binary
cloakscan https://example.com --max-pages 50 --json report.json
```

```
Options:
  -m, --max-pages <n>    Maximum pages to crawl (default: 25)
  -c, --concurrency <n>  Parallel page scans (default: 4)
      --timeout <ms>     Per-request timeout in ms (default: 15000)
      --json <file>      Also write the full report as JSON
      --no-guess         Do not probe for undeclared /amp/ and ?amp=1 endpoints
  -q, --quiet            No progress output, findings only

Exit codes: 0 clean · 1 findings detected · 2 usage/runtime error
```

The exit codes make it easy to run in CI or cron as a site-integrity monitor.

## Build a standalone CLI binary

```sh
deno task compile        # binary for this machine → dist/cloakscan
deno task compile:all    # macOS (arm64/x64), Linux x64, Windows x64
```

The result is a single self-contained executable — no Deno installation needed on the target
machine.

## Limitations

- Analyzes **server-rendered HTML** only; payloads assembled at runtime by JavaScript require a
  headless browser and are out of scope.
- Cloaking that keys on the visitor's IP (real Googlebot IP ranges, reverse-DNS checks) cannot be
  triggered from an ordinary machine — absence of findings is not proof of a clean site.
- The crawler stays on the site's registrable domain and uses an approximate eTLD+1 (no full
  public-suffix list).

## Development

```sh
deno task check   # deno fmt --check + deno lint + deno check
deno task dev     # web app with hot reload
deno task cli <url>
```

The scanner core (`src/`) is dependency-free — it extracts the artifacts it diffs directly from the
server-rendered HTML — so it runs unchanged both in the CLI and inside the Fresh server bundle.

Only scan sites you own or are authorized to test.
