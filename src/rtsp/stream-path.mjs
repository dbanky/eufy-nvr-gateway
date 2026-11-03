// What an RTSP address asks for. Pure.
//
//   rtsp://host:port/<name>               the camera's stream: its video and, with sound, AAC
//   rtsp://host:port/<name>?video         the video only
//   rtsp://host:port/<name>~mjpeg         JPEG pictures instead of the video (ONVIF Profile S requires JPEG)
//   rtsp://host:port/<name>~g711          G.711 µ-law sound instead of AAC (ONVIF requires G.711 when there is sound)
//   rtsp://host:port/<name>~mjpeg~g711    both
//
// A SETUP adds the track's control: rtsp://host:port/garden~mjpeg?video/trackID=0.

const VARIANTS = ['mjpeg', 'g711'];

// -> { name, mjpeg, g711, videoOnly }, or null for an address without a name or with an unknown variant.
// Takes a whole URI or just the path.
export function parseStreamPath(uri) {
  const [path, query = ''] = withoutHost(uri).split('?');
  const [name, ...variants] = decodeURIComponent(path.split('/')[0] ?? '').split('~');
  if (!name || variants.some((v) => !VARIANTS.includes(v))) return null;
  const params = query.split('/')[0].split('&').filter(Boolean).map((p) => p.split('=')[0]);
  return {
    name,
    mjpeg: variants.includes('mjpeg'),
    g711: variants.includes('g711'),
    videoOnly: params.includes('video') && !params.includes('audio'),
  };
}

// The stream's address without a track's control: rtsp://host/garden/trackID=1 -> rtsp://host/garden
export const streamUri = (uri) => String(uri).replace(/\/trackID=\d+$/, '');

const withoutHost = (uri) => String(uri).replace(/^rtsp:\/\/[^/]*\/?/i, '');
