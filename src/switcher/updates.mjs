// Is a newer version out? Asks GitHub for the project's releases now and then, so the web page can
// tell the owner. Someone running a beta is also offered newer betas; everybody else only releases.
// "checkForUpdates": false in config.json turns it off (no request leaves the gateway).

export const PROJECT_URL = 'https://github.com/dbanky/eufy-nvr-gateway';
const RELEASES_API = 'https://api.github.com/repos/dbanky/eufy-nvr-gateway/releases?per_page=30';
const EVERY_MS = 6 * 3600 * 1000;

// "v0.4.0-beta.1" -> { core: [0, 4, 0], pre: ['beta', 1] }; null if it isn't a version.
export function parseVersion(text) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(text).trim());
  if (!m) return null;
  return { core: m.slice(1, 4).map(Number), pre: m[4] ? m[4].split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : null };
}

// Semantic Versioning order: < 0 if a is older than b, 0 if equal, > 0 if newer.
export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  if (!x.pre || !y.pre) return (x.pre ? -1 : 0) - (y.pre ? -1 : 0);   // a release beats its betas
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    if (p === q) continue;
    if (typeof p !== typeof q) return typeof p === 'number' ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

// The newest release (GitHub API objects) that is newer than `current`, or null.
export function newerRelease(releases, current) {
  const onBeta = !!parseVersion(current)?.pre;
  const candidates = releases.filter((r) => !r.draft && (onBeta || !r.prerelease) && parseVersion(r.tag_name)
    && compareVersions(r.tag_name, current) > 0);
  candidates.sort((a, b) => compareVersions(b.tag_name, a.tag_name));
  const r = candidates[0];
  return r ? { version: r.tag_name.replace(/^v/, ''), url: r.html_url, prerelease: !!r.prerelease } : null;
}

export function createUpdateCheck({ current, enabled = true, fetch = globalThis.fetch, log = () => {} }) {
  const state = { current, project: PROJECT_URL, enabled, checked: false, newer: null, error: null };
  let announced = null;

  async function check() {
    try {
      const res = await fetch(RELEASES_API, { headers: { accept: 'application/vnd.github+json', 'user-agent': `eufy-nvr-gateway/${current}` },
        signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      Object.assign(state, { checked: true, error: null, newer: newerRelease(await res.json(), current) });
      if (state.newer && state.newer.version !== announced) {
        announced = state.newer.version;
        log(`Version ${state.newer.version} is available (this is ${current}): ${state.newer.url}`);
      }
    } catch (e) {
      state.error = e.message;   // keeps the last known answer
    }
  }

  return {
    status: () => ({ ...state }),
    check,
    start() {
      if (!enabled) return;
      check();
      setInterval(check, EVERY_MS).unref();
    },
  };
}
