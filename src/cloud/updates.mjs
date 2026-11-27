export function parseReleaseTagFromUrl(url) {
  const m = String(url || "").match(/\/releases\/tag\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]).replace(/^v/i, "") : "";
}

export function compareSemver(a, b) {
  const pa = String(a || "0").replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b || "0").replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < len; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

export async function checkForUpdates(currentVersion = "0.8.1") {
  const repo = "CalicoX/colab-desk";
  const latestWebUrl = `https://github.com/${repo}/releases/latest`;
  const releasesFallbackUrl = `https://github.com/${repo}/releases`;

  // Primary: use github.com/releases/latest 302 redirect (no 60/hr GitHub REST API rate limit)
  try {
    const res = await fetch(latestWebUrl, {
      method: "GET",
      redirect: "manual",
      headers: { "User-Agent": "colab-desk" },
      signal: AbortSignal.timeout(6000),
    });
    const loc = res.headers.get("location") || "";
    const tagFromLoc = parseReleaseTagFromUrl(loc);
    if (tagFromLoc) {
      return {
        ok: true,
        currentVersion,
        latestVersion: tagFromLoc,
        hasUpdate: compareSemver(tagFromLoc, currentVersion) > 0,
        releaseUrl: loc.startsWith("http") ? loc : `https://github.com${loc}`,
        publishedAt: null,
        source: "github-redirect",
      };
    }
    if (res.ok) {
      const tagFromFinalUrl = parseReleaseTagFromUrl(res.url);
      if (tagFromFinalUrl) {
        return {
          ok: true,
          currentVersion,
          latestVersion: tagFromFinalUrl,
          hasUpdate: compareSemver(tagFromFinalUrl, currentVersion) > 0,
          releaseUrl: res.url || releasesFallbackUrl,
          publishedAt: null,
          source: "github-web",
        };
      }
    }
  } catch {
    // Fall through to GitHub API fallback
  }

  // Fallback: GitHub REST API (uses optional GITHUB_TOKEN / GH_TOKEN when available)
  try {
    const headers = { Accept: "application/vnd.github+json", "User-Agent": "colab-desk" };
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers,
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return { ok: false, currentVersion, error: `HTTP ${res.status}` };
    const data = await res.json();
    const latest = String(data.tag_name || "").replace(/^v/i, "");
    const hasUpdate = Boolean(latest && compareSemver(latest, currentVersion) > 0);
    return {
      ok: true,
      currentVersion,
      latestVersion: latest || currentVersion,
      hasUpdate,
      releaseUrl: data.html_url || releasesFallbackUrl,
      publishedAt: data.published_at || null,
      source: "github-api",
    };
  } catch (err) {
    return { ok: false, currentVersion, error: err.message || String(err) };
  }
}
