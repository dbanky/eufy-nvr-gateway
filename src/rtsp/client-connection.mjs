// The requests of one client connection: the login, then each request to its session.
// The bytes come from a plain RTSP connection, or from the POSTs of an HTTP tunnel; answers and
// media go to `peer` (the RTSP connection, or the tunnel's GET connection).
//
// The login is RTSP Digest (or Basic) with the RTSP/ONVIF login. OPTIONS is open; once a request on
// a connection has logged in, the connection stays logged in. Wrong logins count towards the
// gateway's login guard (security/login-guard.mjs); a blocked address gets 403 for any login.

import { RtspReader, header, requestLine, response } from './messages.mjs';
import { noGuard } from '../security/login-guard.mjs';

export class ClientConnection {
  // sessions: SessionRegistry   auth: { check(req), challenges() } | null   log(...)
  // guard: the login guard (createLoginGuard), shared with the web page and ONVIF
  constructor(peer, { sessions, auth, log, guard = noGuard }) {
    Object.assign(this, { peer, sessions, auth, log, guard });
    this.reader = new RtspReader();
    this.session = null;
    this.loggedIn = !auth;
    this.queue = Promise.resolve();   // requests run in order, even when a SETUP waits for UDP ports
  }

  push(chunk) {
    let items;
    try {
      items = this.reader.push(chunk);
    } catch (e) {
      this.log?.(`RTSP: ${e.message} from ${this.peer.remoteAddress}`);
      return this.peer.destroy();
    }
    for (const item of items) {
      this.queue = this.queue.then(() => (item.frame ? this.session?.fromClientFrame(item.frame) : this.request(item.message)))
        .catch((e) => this.log?.(`RTSP: ${e.message}`));
    }
  }

  async request(message) {
    const line = requestLine(message.startLine);
    if (!line) return;   // a response from the client: nothing asks for one
    const cseq = header(message.headers, 'cseq');
    if (!this.loggedIn && line.method !== 'OPTIONS') {
      const verdict = this.auth.check({ method: line.method, headers: { authorization: header(message.headers, 'authorization') ?? '' } });
      const address = this.peer.remoteAddress;
      if (verdict !== 'none' && this.guard.blocked(address)) return this.peer.write(response(403, 'Forbidden', cseq));
      if (verdict !== 'ok') {
        if (verdict === 'wrong') this.guard.failed(address, 'RTSP');
        return this.peer.write(response(401, 'Unauthorized', cseq, this.auth.challenges().map((c) => ['WWW-Authenticate', c])));
      }
      this.loggedIn = true;
    }
    if (line.method === 'OPTIONS' && !header(message.headers, 'session')) {
      return this.peer.write(response(200, 'OK', cseq, [['Public', 'OPTIONS, DESCRIBE, SETUP, PLAY, PAUSE, TEARDOWN, GET_PARAMETER, SET_PARAMETER']]));
    }
    const session = this.sessionFor(header(message.headers, 'session'));
    if (!session) return this.peer.write(response(454, 'Session Not Found', cseq));
    await session.fromClient(message);
  }

  // The session a request belongs to: the one it names (maybe from an earlier connection), else this
  // connection's own, made on first use.
  sessionFor(named) {
    const id = named?.split(';')[0].trim();
    if (id) {
      const session = this.sessions.get(id);
      if (!session) return null;
      if (session.client !== this.peer) session.attach(this.peer);
      this.session = session;
      return session;
    }
    if (!this.session || this.session.closed) {
      this.session = this.sessions.create();
      this.session.attach(this.peer);
    }
    return this.session;
  }

  // The connection ended.
  end() {
    this.session?.detach(this.peer);
  }
}
