// The header's connection pill: how the gateway's eufy login is doing, in one short phrase.

import { esc } from './escape.js';

export function connectionHtml(bridge) {
  const [kind, text] = !bridge.connected ? ['wait', 'Connecting to eufy…']
    : bridge.login === 'ok' ? ['ok', 'Connected to eufy']
    : bridge.login === 'require_2fa' ? ['attention', 'Login needs a code']
    : bridge.login === 'require_captcha' ? ['attention', 'Login needs a captcha']
    : ['attention', `eufy login: ${bridge.login}`];
  return `<span class="pill ${kind}"><span class="dot"></span>${esc(text)}</span>`;
}
