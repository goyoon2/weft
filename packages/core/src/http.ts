/**
 * Headers for fetching the hosted catalog (index.json + spool .tgz) over HTTP. Public GitHub raw
 * urls need nothing; a PRIVATE weft-mill is reached by setting WEFT_GH_TOKEN / GITHUB_TOKEN /
 * GH_TOKEN, which is sent as a Bearer token ONLY to github.com / githubusercontent.com hosts.
 */
export function ghHeaders(url: string): Record<string, string> {
  const headers: Record<string, string> = { "User-Agent": "weft" };
  const token = process.env.WEFT_GH_TOKEN ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (token) {
    try {
      const host = new URL(url).hostname;
      if (host === "github.com" || host.endsWith(".github.com") || host.endsWith("githubusercontent.com")) {
        headers.Authorization = `Bearer ${token}`;
      }
    } catch {
      /* not a parseable url — send no auth */
    }
  }
  return headers;
}
