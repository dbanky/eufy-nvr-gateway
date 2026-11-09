// The sleeping-state design in numbers. Sizes are fractions of the frame height (H), so the overlay
// looks the same at 1080p and 3K. See the design canvas for the reasoning.

// What happens to the picture behind the overlay while the camera sleeps (built in, not an option).
export const PICTURE = {
  blurAt1080p: 10,      // Gaussian sigma in pixels at 1080p, scaled with the frame height
  brightness: 0.78,     // -22 %
  saturation: 0.4,      // -60 %
  vignette: 'PI/5',
  noPictureBackground: '0x15171C',
};

// Centre mark: a dark disc with the state icon. Reads even in a small NVR tile.
export const CENTRE = {
  disc: 0.22, icon: 0.10, spinner: 0.88,   // spinner: share of the disc
  fill: [10, 12, 16], fillAlpha: 0.38, borderAlpha: 0.18,
  iconRgb: [255, 255, 255], iconAlpha: 0.86,
  noPictureLift: 0.08,                     // "No picture yet": disc moves up to make room for text
};

// Label bottom left: a capsule with an icon chip, a title and a detail line.
export const LABEL = {
  margin: 0.035, padY: 0.016, padRight: 0.028, chip: 0.056, chipIcon: 0.56, gap: 0.018,
  title: 0.031, detail: 0.025, lineGap: 0.006, lineHeight: 1.1,
  fill: [14, 16, 20], fillAlpha: 0.62, borderAlpha: 0.12, chipAlpha: 0.2,
  titleColor: 'F4F6FA', detailColor: 'C3C9D3',
};

// "No picture yet" puts its text under the disc instead of in a label.
export const NO_PICTURE_TEXT = { top: 0.07, titleColor: 'E6E9EF', detailColor: '9AA2B1' };

// Accent colour and icon per state. Every state has its own icon shape: colour never carries
// meaning alone.
export const STATES = {
  asleep: { accent: [169, 184, 255], icon: 'moon' },
  disarmed: { accent: [134, 214, 196], icon: 'disarmed' },
  waking: { accent: [255, 196, 71], icon: 'bolt' },
  lowbattery: { accent: [255, 169, 77], icon: 'battery' },
  nowake: { accent: [255, 138, 128], icon: 'alert' },
  offline: { accent: [180, 188, 200], icon: 'offline' },
  nopicture: { accent: [140, 149, 164], icon: 'nopicture' },
};

export const SPINNER_TURN_SECONDS = 1;   // must divide the loop length, so the loop is seamless
