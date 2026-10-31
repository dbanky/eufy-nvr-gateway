// Stands in for the WebSocket to the bridge: the test plays the bridge's side.
export class FakeWebSocket {
  static last;

  constructor(url) {
    Object.assign(this, { url, readyState: 0, sent: [] });
    FakeWebSocket.last = this;
  }

  send(text) { this.sent.push(JSON.parse(text)); }
  open() { this.readyState = 1; this.onopen(); }
  receive(message) { this.onmessage({ data: JSON.stringify(message) }); }
}
