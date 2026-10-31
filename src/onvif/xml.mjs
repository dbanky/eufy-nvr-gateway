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

const NAMESPACES = [
  'xmlns:s="http://www.w3.org/2003/05/soap-envelope"',
  'xmlns:tt="http://www.onvif.org/ver10/schema"',
  'xmlns:tds="http://www.onvif.org/ver10/device/wsdl"',
  'xmlns:trt="http://www.onvif.org/ver10/media/wsdl"',
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

// code: an ONVIF subcode such as ter:ActionNotSupported or ter:NotAuthorized.
export function fault(code, reason, { sender = true } = {}) {
  return envelope(`<s:Fault><s:Code><s:Value>${sender ? 's:Sender' : 's:Receiver'}</s:Value>`
    + `<s:Subcode><s:Value>${code}</s:Value></s:Subcode></s:Code>`
    + `<s:Reason><s:Text xml:lang="en">${xmlEscape(reason)}</s:Text></s:Reason></s:Fault>`);
}
