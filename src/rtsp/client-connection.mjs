// The requests of one client connection: the login, then each request to its session.
// The bytes come from a plain RTSP connection, or from the POSTs of an HTTP tunnel; answers and
// media go to `peer` (the RTSP connection, or the tunnel's GET connection).
//
// The login is RTSP Digest (or Basic) with the RTSP/ONVIF login. OPTIONS is open; once a request on
// a connection has logged in, the connection stays logged in.

import { RtspReader, header, requestLine, response } from './messages.mjs';

export class ClientConnection {
  // sessions: SessionRegistry   auth: { allows(req), challenges() } | null   log(...)
  constructor(peer, { sessions, auth, log }) {
    Object.assign(this, { peer, sessions, auth, log });
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
      if (!this.auth.allows({ method: line.method, headers: { authorization: header(message.headers, 'authorization') ?? '' } })) {
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
