import {
  disallowedAmpScripts,
  extractArtifacts,
  looksLikeSpam,
  newExternalUrls,
  truncate,
} from "./analyzer.ts";
import { fetchPage, isHtmlOk } from "./fetcher.ts";
import type {
  Artifacts,
  FetchedPage,
  Finding,
  PageResult,
  ScanOptions,
  ScanReport,
  Severity,
} from "./types.ts";
import {
  guessAmpCandidates,
  hostOf,
  normalizeForVisit,
  registrableDomain,
  sameSite,
} from "./urls.ts";

type OnProgress = (message: string) => void;

export async function scanSite(opts: ScanOptions, onProgress: OnProgress): Promise<ScanReport> {
  const startedAt = new Date().toISOString();
  const start = new URL(opts.startUrl);
  const siteDomain = registrableDomain(start.hostname);

  // Always begin at the site origin (scheme://host), discarding any path the
  // caller supplied. This lets the site's own redirects run (e.g. / -> /nl/),
  // which preserves details like trailing slashes that path-keyed malware
  // triggers on — a path passed in directly is subject to normalization that
  // can strip exactly those details and silently miss the payload.
  const queue: string[] = [normalizeForVisit(start.origin)];
  const seen = new Set<string>(queue);
  const pages: PageResult[] = [];
  let ampPagesFound = 0;

  let started = 0;
  let inFlight = 0;

  const worker = async () => {
    while (started < opts.maxPages) {
      const url = queue.shift();
      if (url === undefined) {
        if (inFlight === 0) return;
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      started++;
      inFlight++;
      try {
        const { result, internalLinks } = await scanPage(url, siteDomain, opts, onProgress);
        pages.push(result);
        if (result.ampUrl) ampPagesFound++;
        if (seen.size < opts.maxPages * 5) {
          for (const link of internalLinks) {
            const key = normalizeForVisit(link);
            if (!seen.has(key)) {
              seen.add(key);
              queue.push(key);
            }
          }
        }
      } finally {
        inFlight--;
      }
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency }, () => worker()));

  return {
    site: start.origin,
    startedAt,
    finishedAt: new Date().toISOString(),
    pagesScanned: pages.length,
    ampPagesFound,
    findings: pages.flatMap((p) => p.findings),
    pages,
  };
}

async function scanPage(
  url: string,
  siteDomain: string,
  opts: ScanOptions,
  onProgress: OnProgress,
): Promise<{ result: PageResult; internalLinks: string[] }> {
  const result: PageResult = { url, ampUrl: null, ampDiscovery: "none", findings: [], errors: [] };
  const add = (f: Finding) => result.findings.push(f);

  onProgress(`scanning ${url}`);
  const canonicalBrowser = await fetchPage(url, "browser", opts.timeoutMs);
  if (!isHtmlOk(canonicalBrowser)) {
    if (canonicalBrowser.error) result.errors.push(`fetch failed: ${canonicalBrowser.error}`);
    else if (canonicalBrowser.status >= 300) {
      result.errors.push(`HTTP ${canonicalBrowser.status}`);
    }
    return { result, internalLinks: [] };
  }

  const baseUrl = canonicalBrowser.finalUrl;
  const canonicalArt = extractArtifacts(canonicalBrowser.html, baseUrl);
  const internalLinks = canonicalArt.links.filter((l) => sameSite(l, siteDomain));

  // 1. UA cloaking on the canonical URL: does Googlebot get extra external content?
  const canonicalBot = await fetchPage(url, "googlebot", opts.timeoutMs);
  if (isHtmlOk(canonicalBot)) {
    const botArt = extractArtifacts(canonicalBot.html, canonicalBot.finalUrl);
    reportCloakingDiff(add, url, canonicalArt, botArt, siteDomain, "ua-cloaking", {
      what: "Googlebot",
    });
  }

  // 2. Locate the AMP variant.
  let ampUrl = canonicalArt.ampUrl;
  if (ampUrl) {
    result.ampDiscovery = normalizeForVisit(ampUrl) === normalizeForVisit(url)
      ? "self"
      : "declared";
  } else if (canonicalArt.isAmp) {
    ampUrl = url;
    result.ampDiscovery = "self";
  }

  let ampBrowser: FetchedPage | null = null;
  let ampArt: Artifacts | null = null;

  if (ampUrl && result.ampDiscovery === "declared") {
    ampBrowser = await fetchPage(ampUrl, "browser", opts.timeoutMs);
    if (!isHtmlOk(ampBrowser)) {
      result.errors.push(`AMP variant fetch failed (${ampBrowser.status || ampBrowser.error})`);
      ampBrowser = null;
    }
  } else if (ampUrl) {
    ampBrowser = canonicalBrowser;
  }

  // 3. No declared AMP variant: probe for hidden AMP endpoints malware registers
  //    (e.g. rogue /amp/ rewrites or ?amp=1 handlers invisible from the page itself).
  if (!ampUrl && opts.guessAmp) {
    for (const candidate of guessAmpCandidates(baseUrl)) {
      const probe = await fetchPage(candidate, "browser", opts.timeoutMs);
      if (!isHtmlOk(probe)) continue;
      if (normalizeForVisit(probe.finalUrl) === normalizeForVisit(baseUrl)) continue;
      const art = extractArtifacts(probe.html, probe.finalUrl);
      if (!art.isAmp) continue;
      ampUrl = candidate;
      ampBrowser = probe;
      ampArt = art;
      result.ampDiscovery = "guessed";
      add({
        type: "hidden-amp-endpoint",
        severity: "medium",
        page: url,
        ampUrl: candidate,
        detail:
          "An AMP document is served at a guessed URL that the canonical page does not declare via <link rel=amphtml>. Legitimate AMP setups declare their AMP variant; hidden endpoints are a common malware pattern.",
        evidence: [candidate],
      });
      break;
    }
  }

  result.ampUrl = ampUrl ?? null;
  if (!ampUrl || !ampBrowser) return { result, internalLinks };

  ampArt ??= extractArtifacts(ampBrowser.html, ampBrowser.finalUrl);

  // 4. AMP validity checks — any real JS in an AMP page is a red flag by definition.
  if (ampArt.isAmp) {
    const badScripts = disallowedAmpScripts(ampArt.scripts);
    if (badScripts.length > 0) {
      add({
        type: "disallowed-script-in-amp",
        severity: "high",
        page: url,
        ampUrl,
        detail:
          "AMP documents may only load scripts from cdn.ampproject.org. Third-party script sources in an AMP page indicate injected code.",
        evidence: badScripts,
      });
    }
    if (ampArt.inlineScripts.length > 0) {
      add({
        type: "inline-script-in-amp",
        severity: "high",
        page: url,
        ampUrl,
        detail:
          "AMP documents must not contain executable inline <script> tags (only JSON/LD+JSON). Inline JS in an AMP page is invalid AMP and a common injection vector.",
        evidence: ampArt.inlineScripts.map((s) => truncate(s)),
      });
    }
  }

  if (ampArt.metaRefresh && !sameSite(ampArt.metaRefresh, siteDomain)) {
    add({
      type: "meta-refresh-in-amp",
      severity: "high",
      page: url,
      ampUrl,
      detail: "The AMP variant meta-refreshes visitors to an external site.",
      evidence: [ampArt.metaRefresh],
    });
  }

  // 5. Content only present in the AMP variant, not on the canonical page.
  if (result.ampDiscovery !== "self") {
    const onlyInAmp = (kind: "links" | "iframes" | "forms") =>
      newExternalUrls(ampArt![kind], canonicalArt[kind].concat(canonicalArt.links), siteDomain);

    const ampOnlyLinks = onlyInAmp("links");
    if (ampOnlyLinks.length > 0) {
      add({
        type: "amp-only-external-link",
        severity: looksLikeSpam(ampOnlyLinks) ? "high" : "medium",
        page: url,
        ampUrl,
        detail:
          "External links present in the AMP variant but absent from the canonical page. Regular scans of the canonical page never see these.",
        evidence: ampOnlyLinks,
      });
    }
    const ampOnlyIframes = onlyInAmp("iframes");
    if (ampOnlyIframes.length > 0) {
      add({
        type: "amp-only-iframe",
        severity: "high",
        page: url,
        ampUrl,
        detail: "External iframes present only in the AMP variant.",
        evidence: ampOnlyIframes,
      });
    }
    const ampOnlyForms = onlyInAmp("forms");
    if (ampOnlyForms.length > 0) {
      add({
        type: "amp-only-form",
        severity: "high",
        page: url,
        ampUrl,
        detail:
          "Forms posting to external hosts present only in the AMP variant (possible phishing).",
        evidence: ampOnlyForms,
      });
    }
    const ampOnlyScripts = newExternalUrls(ampArt.scripts, canonicalArt.scripts, siteDomain)
      .filter((s) => hostOf(s) !== "cdn.ampproject.org");
    if (ampOnlyScripts.length > 0 && !ampArt.isAmp) {
      // Non-AMP doc served at the AMP URL — script diff is still meaningful.
      add({
        type: "amp-only-script",
        severity: "high",
        page: url,
        ampUrl,
        detail: "External scripts loaded only by the AMP variant.",
        evidence: ampOnlyScripts,
      });
    }
  }

  // 6. Cloaking on the AMP URL itself: serve clean AMP to browsers,
  //    payload to the Google AMP cache fetch.
  const ampAsCache = await fetchPage(ampUrl, "amp-cache", opts.timeoutMs);
  if (isHtmlOk(ampAsCache)) {
    const cacheArt = extractArtifacts(ampAsCache.html, ampAsCache.finalUrl);
    reportCloakingDiff(add, url, ampArt, cacheArt, siteDomain, "amp-cloaked-injection", {
      what: "the Google AMP cache",
      ampUrl,
    });
  }

  return { result, internalLinks };
}

/** Compare a bot/cache fetch against the browser fetch of the same URL. */
function reportCloakingDiff(
  add: (f: Finding) => void,
  page: string,
  browserArt: Artifacts,
  botArt: Artifacts,
  siteDomain: string,
  type: "ua-cloaking" | "amp-cloaked-injection",
  ctx: { what: string; ampUrl?: string },
) {
  const extraLinks = newExternalUrls(botArt.links, browserArt.links, siteDomain);
  const extraScripts = newExternalUrls(botArt.scripts, browserArt.scripts, siteDomain);
  const extraIframes = newExternalUrls(botArt.iframes, browserArt.iframes, siteDomain);
  const evidence = [...extraScripts, ...extraIframes, ...extraLinks];
  if (evidence.length === 0) return;

  const severity: Severity = extraScripts.length > 0 || extraIframes.length > 0 ||
      looksLikeSpam(evidence)
    ? "high"
    : "medium";
  add({
    type,
    severity,
    page,
    ampUrl: ctx.ampUrl,
    detail:
      `Content served to ${ctx.what} contains external references that a normal browser request does not receive — classic cloaking. Extra: ${extraScripts.length} script(s), ${extraIframes.length} iframe(s), ${extraLinks.length} link(s).`,
    evidence,
  });
}
