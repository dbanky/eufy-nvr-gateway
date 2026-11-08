// Two checks for the web page and its API against attacks through a browser on the LAN. Neither
// affects scripts, NVRs or the Homebridge plugin: they send no browser headers.
//
// Cross-site requests: any website the user opens could otherwise make their browser POST to the
// gateway (wake a camera, send a 2FA code). Browsers say where a request comes from
// (Sec-Fetch-Site, or Origin in older ones); a change from another site is refused.
//
// DNS rebinding: a website can point its own host name at the gateway's IP address, and then
// read the API as if it were that site. It can't sign in, so this matters only without a web
// login: then requests must name the gateway by an address or a local host name, or one listed
// in "web.allowedHosts".

import { isIP } from 'node:net';

const READING = new Set(['GET', 'HEAD', 'OPTIONS']);

// True for a browser request that changes something and comes from another site.
export function crossSite(req) {
  if (READING.has(req.method)) return false;
  const site = req.headers['sec-fetch-site'];
  if (site) return site !== 'same-origin' && site !== 'none';   // "none": typed into the address bar
  const origin = req.headers.origin;
  if (!origin) return false;   // not from a browser
  if (origin === 'null') return true;
  try {
    return new URL(origin).host !== req.headers.host;
  } catch {
    return true;
  }
}

// Names that only resolve inside a home network.
const LOCAL_SUFFIXES = ['.local', '.lan', '.home', '.home.arpa', '.internal', '.localdomain', '.intranet', '.fritz.box'];

// The host name of a Host header: "Nas.local:8099" -> "nas.local", "[fd00::1]:8099" -> "fd00::1".
export function hostName(header) {
  const text = String(header ?? '').trim().toLowerCase();
  const ipv6 = /^\[([^\]]+)\](?::\d+)?$/.exec(text);
  if (ipv6) return ipv6[1];
  return text.replace(/:\d+$/, '').replace(/\.$/, '');
}

// Whether a request may name the gateway this way (Host header). allowed: "web.allowedHosts",
// exact names or "*.example.com".
export function allowedHost(header, allowed = []) {
  const name = hostName(header);
  if (!name) return true;   // HTTP/1.0 clients send none; browsers always do
  if (isIP(name) || name === 'localhost' || !name.includes('.')) return true;
  if (LOCAL_SUFFIXES.some((suffix) => name.endsWith(suffix))) return true;
  return allowed.some((entry) => {
    const rule = String(entry).trim().toLowerCase();
    return rule.startsWith('*.') ? name.endsWith(rule.slice(1)) : name === rule;
  });
}
