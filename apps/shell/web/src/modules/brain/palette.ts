// The map draws on a canvas / WebGL, so it can't use CSS variables directly. This reads the dashboard's
// colour tokens once per theme and hands the graph plain numbers. Change a token in styles/app.css and the map follows.


export interface RGB { r: number; g: number; b: number }

export interface Palette {
  dark: boolean;
  /** Canvas background (the card the map sits on). */
  bg: string;
  font: string;
  /** One colour per person number (index 1-6) and one for shared roots (index 0). A note takes its root's colour,
   *  blended towards the roots it links into. */
  tint: RGB[];
  /** Neutral ink for edges, particles and the brief white/black flash. */
  ink: RGB;
  muted: RGB;
  followed: RGB;
  causedBy: RGB;
  about: RGB;
}

const probe = (() => {
  let ctx: CanvasRenderingContext2D | null = null;
  return (css: string): RGB => {
    ctx ??= Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d", { willReadFrequently: true });
    if (!ctx) return { r: 128, g: 128, b: 128 };
    // Painting a pixel resolves any CSS colour syntax (hex, rgb, hsl, oklch ...) to sRGB.
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "#808080";
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return { r, g, b };
  };
})();

/** Which colour a root gets: a person's number (1-6, the same colour they have everywhere), 0 for a shared root. */
let whoByRoot = new Map<string, number>();
export function setRoots(roots: string[], people: { name: string; n: number }[]): void {
  whoByRoot = new Map(roots.map((r) => [r, people.find((p) => p.name.toLowerCase() === r.toLowerCase())?.n ?? 0]));
}
export const whoOf = (root: string): number => whoByRoot.get(root) ?? 0;
/** A small dot in the root's colour (styles/brain-map.css .bm-sw). Safe in innerHTML: only a digit goes in. */
export const swatch = (root: string): string => `<i class="bm-sw" data-who="${whoOf(root)}"></i>`;

export const mix = (a: RGB, b: RGB, t: number): RGB => ({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t });

/** Hue 0-360, saturation and lightness 0-100. */
export function hsl({ r, g, b }: RGB): { h: number; s: number; l: number } {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B), d = max - min, l = (max + min) / 2;
  const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
  return { h: hueOf({ r, g, b }), s: Math.round(s * 100), l: Math.round(l * 100) };
}

export function hueOf({ r, g, b }: RGB): number {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B), d = max - min;
  if (!d) return 0;
  const h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return Math.round((h * 60 + 360) % 360);
}

export const rgba = (c: RGB, a: number) => `rgba(${c.r},${c.g},${c.b},${+a.toFixed(3)})`;
export const hex = (c: RGB) => `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;

/** Everything comes from the dashboard's tokens (styles/app.css): --who-1 … --who-6 for people, --slate for shared. */
export function readPalette(el: Element, dark: boolean): Palette {
  const cs = getComputedStyle(el);
  const tok = (names: string[], fallback: string) => {
    for (const n of names) { const v = cs.getPropertyValue(n).trim(); if (v) return probe(v); }
    return probe(fallback);
  };
  return {
    dark,
    bg: hex(tok(["--bm-canvas"], dark ? "#14161c" : "#f4f5f8")),
    font: cs.getPropertyValue("--font").trim() || "ui-monospace, monospace",
    tint: [tok(["--slate"], "#808080"), ...[1, 2, 3, 4, 5, 6].map((n) => tok([`--who-${n}`], "#808080"))],
    ink: tok(["--ink"], dark ? "#f2f2f2" : "#0a0a0a"),
    muted: tok(["--muted"], "#8e8e94"),
    followed: tok(["--green"], "#16a34a"),
    causedBy: tok(["--rose"], "#f0506e"),
    about: tok(["--amber"], "#e08a00"),
  };
}
