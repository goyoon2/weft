/**
 * Is `host` GitHub itself (not a lookalike)? Matched as an exact host or a true subdomain — each
 * suffix check carries a leading dot so a typosquat like `rawgithubusercontent.com` or
 * `notgithub.com` can NOT match `*.githubusercontent.com` / `*.github.com`.
 */
function isGithubHost(host: string): boolean {
  return (
    host === "github.com" ||
    host === "githubusercontent.com" ||
    host.endsWith(".github.com") ||
    host.endsWith(".githubusercontent.com")
  );
}

/**
 * Headers for fetching the hosted catalog (index.json + spool .tgz) over HTTP. Public GitHub raw
 * urls need nothing; a PRIVATE weft-mill is reached by setting WEFT_GH_TOKEN / GITHUB_TOKEN /
 * GH_TOKEN, which is sent as a Bearer token ONLY over HTTPS to a real github.com /
 * githubusercontent.com host — never to a plaintext or lookalike-domain url.
 */
export function ghHeaders(url: string): Record<string, string> {
  const headers: Record<string, string> = { "User-Agent": "weft" };
  const token = process.env.WEFT_GH_TOKEN ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (token) {
    try {
      const u = new URL(url);
      if (u.protocol === "https:" && isGithubHost(u.hostname)) {
        headers.Authorization = `Bearer ${token}`;
      }
    } catch {
      /* not a parseable url — send no auth */
    }
  }
  return headers;
}
