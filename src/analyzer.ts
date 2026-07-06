import type { Artifacts } from "./types.ts";
import { hostOf, registrableDomain, resolveHttpUrl } from "./urls.ts";

/** The only script host allowed in a valid AMP document. */
export const AMP_RUNTIME_HOST = "cdn.ampproject.org";

/** Hosts that are benign noise in diffs (AMP runtime, fonts, consent, analytics loaders). */
const BENIGN_DIFF_HOSTS = new Set([
  "cdn.ampproject.org",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "www.gstatic.com",
  "www.google.com",
  "www.googletagmanager.com",
  "www.google-analytics.com",
  "schema.org",
]);

/**
 * Keywords typical of SEO-spam payloads injected via AMP cloaking.
 * A hit upgrades a finding's severity; it never creates one on its own.
 */
const SPAM_KEYWORDS = [
  "casino",
  "poker",
  "slot",
  "betting",
  "gambl",
  "togel",
  "judi",
  "viagra",
  "cialis",
  "pharma",
  "pills",
  "porn",
  "xxx",
  "escort",
  "adult",
  "payday",
  "loan",
  "forex",
  "crypto-invest",
  "replica",
  "essay",
  "jersey",
  "oakley",
  "vuitton",
];

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
  nbsp: " ",
};

/** Minimal HTML-entity decode, enough to normalize attribute values (esp. &amp; in URLs). */
function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X"
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? m;
  });
}

/** Parse the attributes out of a start-tag's inner text into a lowercased-key map. */
function parseAttrs(attrText: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const re = /([^\s=/>"']+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrText)) !== null) {
    const name = m[1].toLowerCase();
    let value = m[2] ?? "";
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'")) {
      value = value.slice(1, -1);
    }
    if (!attrs.has(name)) attrs.set(name, decodeEntities(value));
  }
  return attrs;
}

/** Iterate the start tags of a given tag name, yielding parsed attribute maps. */
function* startTags(html: string, tag: string): Generator<Map<string, string>> {
  const re = new RegExp(`<${tag}\\b([^>]*)>`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    yield parseAttrs(m[1]);
  }
}

function hasToken(value: string | undefined, token: string): boolean {
  if (!value) return false;
  return value.toLowerCase().split(/\s+/).includes(token);
}

function isJsonScriptType(type: string): boolean {
  const t = type.trim().toLowerCase();
  return t === "application/json" || t === "application/ld+json";
}

/**
 * Extract the artifacts we diff across fetches (links, scripts, iframes, forms,
 * AMP markers) directly from HTML. Intentionally dependency-free: every DOM
 * library carries native/wasm/CJS baggage that breaks under Fresh's SSR bundler,
 * and this scanner only needs attributes off a fixed set of tags.
 */
export function extractArtifacts(rawHtml: string, baseUrl: string): Artifacts {
  const result: Artifacts = {
    links: [],
    scripts: [],
    inlineScripts: [],
    iframes: [],
    forms: [],
    metaRefresh: null,
    isAmp: false,
    ampUrl: null,
    canonicalUrl: null,
  };

  // Drop comments so we never extract tags that are commented out (matching
  // DOM-parser behavior and avoiding spurious diffs from commented markup).
  const html = rawHtml.replace(/<!--[\s\S]*?-->/g, "");

  const htmlTag = /<html\b([^>]*)>/i.exec(html);
  if (htmlTag) {
    const attrs = parseAttrs(htmlTag[1]);
    result.isAmp = attrs.has("amp") || attrs.has("⚡") || attrs.has("⚡️");
  }

  const collect = (tag: string, attr: string, into: string[]) => {
    for (const attrs of startTags(html, tag)) {
      const raw = attrs.get(attr);
      if (!raw) continue;
      const abs = resolveHttpUrl(raw, baseUrl);
      if (abs) into.push(abs);
    }
  };

  collect("a", "href", result.links);
  collect("iframe", "src", result.iframes);
  collect("form", "action", result.forms);

  // External <script src>.
  for (const attrs of startTags(html, "script")) {
    const src = attrs.get("src");
    if (!src) continue;
    const abs = resolveHttpUrl(src, baseUrl);
    if (abs) result.scripts.push(abs);
  }

  // Inline (executable) <script> bodies.
  const scriptEl = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let sm: RegExpExecArray | null;
  while ((sm = scriptEl.exec(html)) !== null) {
    const attrs = parseAttrs(sm[1]);
    if (attrs.has("src")) continue;
    if (isJsonScriptType(attrs.get("type") ?? "text/javascript")) continue;
    const body = sm[2].trim();
    if (body.length > 0) result.inlineScripts.push(body);
  }

  for (const attrs of startTags(html, "link")) {
    const href = attrs.get("href");
    if (!href) continue;
    const rel = attrs.get("rel");
    if (!result.ampUrl && hasToken(rel, "amphtml")) {
      result.ampUrl = resolveHttpUrl(href, baseUrl);
    }
    if (!result.canonicalUrl && hasToken(rel, "canonical")) {
      result.canonicalUrl = resolveHttpUrl(href, baseUrl);
    }
  }

  for (const attrs of startTags(html, "meta")) {
    if ((attrs.get("http-equiv") ?? "").toLowerCase() !== "refresh") continue;
    const content = attrs.get("content");
    if (!content) continue;
    const m = content.match(/url\s*=\s*['"]?([^'";]+)/i);
    if (m) result.metaRefresh = resolveHttpUrl(m[1], baseUrl);
    break;
  }

  return result;
}

/** URLs in `candidate` whose host is external to the site and absent from `reference`. */
export function newExternalUrls(
  candidate: string[],
  reference: string[],
  siteDomain: string,
): string[] {
  const refHosts = new Set(reference.map(hostOf).filter(Boolean));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of candidate) {
    const host = hostOf(url);
    if (!host || refHosts.has(host) || BENIGN_DIFF_HOSTS.has(host)) continue;
    if (registrableDomain(host) === siteDomain) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

export function looksLikeSpam(urls: string[]): boolean {
  return urls.some((u) => {
    const s = u.toLowerCase();
    return SPAM_KEYWORDS.some((k) => s.includes(k));
  });
}

/** Script srcs in an AMP document that are not the AMP runtime/extensions. */
export function disallowedAmpScripts(scripts: string[]): string[] {
  return scripts.filter((s) => hostOf(s) !== AMP_RUNTIME_HOST);
}

export function truncate(s: string, max = 200): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : oneLine.slice(0, max) + "…";
}
