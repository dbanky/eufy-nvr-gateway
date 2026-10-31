// The eufy login card: shown when eufy asks for a 2FA code or a captcha.

const $ = (id) => document.getElementById(id);
const postJson = async (url, body) => (await fetch(url, { method: 'POST',
  headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) })).json();

export function showLogin(bridge) {
  const needsInput = bridge.login === 'require_2fa' || bridge.login === 'require_captcha';
  $('login').hidden = !needsInput;
  if (!needsInput) return;
  const captcha = bridge.login === 'require_captcha';
  $('loginText').textContent = captcha ? 'Type the characters shown in the picture.'
    : 'eufy sent a verification code (usually by e-mail' + (bridge.method ? ': ' + bridge.method : '') + '). Enter it here.';
  $('captcha').hidden = !bridge.captcha;
  if (bridge.captcha) $('captcha').src = bridge.captcha;
  $('code').dataset.kind = captcha ? 'captcha' : 'code';
}

// onChange: called after a code was sent or a new one requested, to refresh the page.
export function bindLogin(onChange) {
  $('loginForm').onsubmit = async (e) => {
    e.preventDefault();
    const body = { [$('code').dataset.kind || 'code']: $('code').value.trim() };
    $('loginMsg').textContent = 'Checking…';
    const answer = await postJson('api/login', body);
    $('loginMsg').textContent = answer.ok ? 'Accepted.' : (answer.error || 'Not accepted, try again.');
    $('code').value = '';
    onChange();
  };
  $('retrigger').onclick = async () => {
    $('loginMsg').textContent = 'Requesting a new code…';
    const answer = await postJson('api/login/retrigger');
    $('loginMsg').textContent = answer.ok ? 'Requested.' : (answer.error || 'Failed.');
    onChange();
  };
}
