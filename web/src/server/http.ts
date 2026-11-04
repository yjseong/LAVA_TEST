// HTTP helpers for the collectors.
//
// The Python app disabled TLS verification globally (VERIFY_SSL = False) because the institute network re-signs
// HTTPS. On Vercel there is no such proxy, so verification stays ON everywhere. The one exception is the explicit,
// per-host opt-in the Python code already had for magma.esdm.go.id (VOLCANO_PVMBG_ALLOW_UNVERIFIED=1).
import https from "node:https";

export const BROWSER_UA = "Mozilla/5.0";
export const OFFICIAL_UA = "Mozilla/5.0 (compatible; VolcanoAlertDashboard/1.0)";

export interface FetchTextOptions {
  /** total time allowed for ONE attempt */
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** attempts on timeouts / connection errors (a TLS error is never retried) */
  tries?: number;
  /** reject suspiciously short bodies (an error page, an empty reply) */
  minBytes?: number;
}

/** Walks error.cause: Node's fetch wraps the real reason (code ECONNRESET, CERT_HAS_EXPIRED ...) in `fetch failed`. */
export function errorCode(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur && typeof cur === "object"; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string") return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

const TLS_ERROR_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_UNTRUSTED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "HOSTNAME_MISMATCH",
]);

export const isTlsError = (err: unknown): boolean => TLS_ERROR_CODES.has(errorCode(err) ?? "");

function charsetOf(contentType: string | null, head: string): string {
  const fromHeader = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType ?? "");
  const fromMeta = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head);
  return (fromHeader?.[1] ?? fromMeta?.[1] ?? "utf-8").toLowerCase();
}

/** Decodes with the declared charset (JMA / old Japanese pages may not be UTF-8); falls back to UTF-8. */
export function decodeBody(buf: Uint8Array, contentType: string | null): string {
  const head = new TextDecoder("latin1").decode(buf.subarray(0, 2048));
  const charset = charsetOf(contentType, head);
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}

export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`HTTP ${status} for ${url}`);
    this.name = "HttpStatusError";
  }
}

/** GET a URL as text. Throws on HTTP errors, timeouts (after `tries`), TLS problems and too-short bodies. */
export async function fetchText(url: string, opts: FetchTextOptions = {}): Promise<string> {
  const { timeoutMs = 15_000, headers = {}, tries = 1, minBytes = 0 } = opts;
  let lastError: unknown;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": BROWSER_UA, ...headers },
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
        redirect: "follow",
      });
      if (!res.ok) throw new HttpStatusError(res.status, url);
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength < minBytes) throw new Error("Unexpectedly short response from " + url);
      return decodeBody(buf, res.headers.get("content-type"));
    } catch (err) {
      lastError = err;
      // A certificate problem or an HTTP error answer: retrying does not help.
      if (isTlsError(err) || err instanceof HttpStatusError) throw err;
    }
  }
  throw lastError;
}

/** GET that skips certificate verification. Only reachable through the PVMBG opt-in below. */
function insecureGet(url: string, timeoutMs: number, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, rejectUnauthorized: false, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        if (!res.statusCode || res.statusCode >= 400) return reject(new HttpStatusError(res.statusCode ?? 0, url));
        resolve(decodeBody(Buffer.concat(chunks), res.headers["content-type"] ?? null));
      });
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

const SLOW_HOST = "magma.esdm.go.id";

/**
 * Fetch for the official-alert sources (port of _fetch in volcano_official_collectors.py).
 *
 * magma.esdm.go.id (PVMBG) is slow at times: the TLS handshake alone can take more than 7 s. A generous timeout and
 * one retry keep a slow minute from becoming a failed refresh. The other sources get a normal timeout, one try.
 * (Per attempt: 20 s / 2 tries and 12 s / 1 try - shorter than the Python 15+25 s because a serverless function has a
 * hard time limit; the whole refresh must fit in it.)
 */
export async function fetchOfficial(url: string, opts: { timeoutMs?: number; tries?: number } = {}): Promise<string> {
  const slow = new URL(url).hostname === SLOW_HOST;
  const timeoutMs = opts.timeoutMs ?? (slow ? 20_000 : 12_000);
  const tries = opts.tries ?? (slow ? 2 : 1);
  const headers = { "User-Agent": OFFICIAL_UA };
  try {
    return await fetchText(url, { timeoutMs, tries, headers, minBytes: 100 });
  } catch (err) {
    if (!isTlsError(err)) throw err;
    if (!slow || process.env.VOLCANO_PVMBG_ALLOW_UNVERIFIED !== "1") {
      throw new Error(
        "PVMBG TLS certificate verification failed. Check proxy/CA trust, " +
          "or explicitly set VOLCANO_PVMBG_ALLOW_UNVERIFIED=1 for a temporary, unverified fallback.",
      );
    }
    console.warn("PVMBG TLS verification DISABLED by explicit opt-in; data integrity not guaranteed");
    const text = await insecureGet(url, 18_000, headers);
    if (Buffer.byteLength(text) < 100) throw new Error("Unexpectedly short response from " + url);
    return text;
  }
}
