/**
 * Dark-theme-safe rendering of Pixera cue colors.
 *
 * Text always stays the standard light UI color; the cue color is expressed
 * as an accent (edge stripe / swatch, lightness clamped so it's visible on
 * dark) and a heavily darkened background tint (hue preserved, lightness
 * forced low) so even #FFFF00 never becomes a bright wall.
 *
 * Pixera's default cue color is #000000 — treated as "no color".
 */

function parseHex(hex) {
  if (typeof hex !== 'string') return null;
  const m = hex.trim().match(/^#?([0-9a-fA-F]{6})$/);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHsl([r, g, b]) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  switch (max) {
    case r:
      h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      break;
    case g:
      h = ((b - r) / d + 2) / 6;
      break;
    default:
      h = ((r - g) / d + 4) / 6;
  }
  return [h, s, l];
}

const hsl = (h, s, l) => `hsl(${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Returns { accent, bg } CSS colors for a cue color, or null when the cue has
 * no usable color (missing, invalid, or near-black default).
 */
export function cueColorStyles(hex) {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const [h, s, l] = rgbToHsl(rgb);
  if (l < 0.08) return null; // #000000-ish: Pixera's default, i.e. uncolored
  return {
    accent: hsl(h, Math.min(s, 0.85), clamp(l, 0.45, 0.65)),
    bg: hsl(h, Math.min(s, 0.45), 0.16),
  };
}
