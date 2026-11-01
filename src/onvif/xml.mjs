// Just enough SOAP for ONVIF, without an XML library: ONVIF clients send small, predictable
// requests, so reading a few element values by name is enough.

export const xmlEscape = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// The operation: the first element inside the SOAP Body, without its namespace prefix.
export function operation(xml) {
  const match = /<(?:[\w-]+:)?Body[^>]*>\s*<(?:[\w-]+:)?([\w-]+)/.exec(xml);
  return match ? match[1] : null;
}

// The text of the first element with this name (any namespace prefix), or null.
export function valueOf(xml, name) {
  const match = new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`).exec(xml);
  return match ? match[1].trim() : null;
}

// The inner XML of every element with this name (any prefix), in order. Elements of the same name
// must not nest (true for the ONVIF requests read here).
export function elementsOf(xml, name) {
  const re = new RegExp(`<(?:[\\w-]+:)?${name}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>)`, 'g');
  return [...String(xml ?? '').matchAll(re)].map((m) => m[2] ?? '');
}

// All values of elements with this name.
export const valuesOf = (xml, name) => elementsOf(xml, name).map((v) => v.trim());

// An attribute of the first element with this name, or null.
export function attributeOf(xml, name, attribute) {
  const tag = new RegExp(`<(?:[\\w-]+:)?${name}\\b([^>]*)>`).exec(String(xml ?? ''));
  if (!tag) return null;
  const m = new RegExp(`(?:^|\\s)(?:[\\w-]+:)?${attribute}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(tag[1]);
  return m ? (m[2] ?? m[3]) : null;
}

// A SOAP fault with ONVIF codes. code: "ter:InvalidArgVal/ter:NoProfile" (subcode/subcode).
// Errors from ter:Action and ter:ActionNotSupported are the receiver's (the device can't); the
// rest are the sender's (the request is wrong).
export class OnvifFault extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const isReceiverFault = (code) => /^ter:(Action|ActionNotSupported)(\/|$)/.test(code);

const NAMESPACES = [
  'xmlns:s="http://www.w3.org/2003/05/soap-envelope"',
  'xmlns:tt="http://www.onvif.org/ver10/schema"',
  'xmlns:tds="http://www.onvif.org/ver10/device/wsdl"',
  'xmlns:trt="http://www.onvif.org/ver10/media/wsdl"',
  'xmlns:tr2="http://www.onvif.org/ver20/media/wsdl"',
  'xmlns:tev="http://www.onvif.org/ver10/events/wsdl"',
  'xmlns:ter="http://www.onvif.org/ver10/error"',
  'xmlns:wsa="http://www.w3.org/2005/08/addressing"',
  'xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2"',
  'xmlns:wstop="http://docs.oasis-open.org/wsn/t-1"',
  'xmlns:tns1="http://www.onvif.org/ver10/topics"',
  'xmlns:xs="http://www.w3.org/2001/XMLSchema"',
].join(' ');

export function envelope(body, { action } = {}) {
  const header = action ? `<s:Header><wsa:Action>${action}</wsa:Action></s:Header>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?><s:Envelope ${NAMESPACES}>${header}<s:Body>${body}</s:Body></s:Envelope>`;
}

// code: one ONVIF subcode or a chain of them, "ter:InvalidArgVal/ter:NoProfile".
export function fault(code, reason, { sender = !isReceiverFault(code) } = {}) {
  const subcodes = code.split('/');
  const nested = subcodes.reduceRight((inner, c) => `<s:Subcode><s:Value>${c}</s:Value>${inner}</s:Subcode>`, '');
  return envelope(`<s:Fault><s:Code><s:Value>${sender ? 's:Sender' : 's:Receiver'}</s:Value>${nested}</s:Code>`
    + `<s:Reason><s:Text xml:lang="en">${xmlEscape(reason)}</s:Text></s:Reason></s:Fault>`);
}
