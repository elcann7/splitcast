// Generated placeholder footage for mock mode: small SVG "film stills" in muted tones.
import type { ShotSize } from "./types";

export function rng(seed: number) {
  let a = seed >>> 0 || 1;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const svgUrl = (svg: string) => "data:image/svg+xml;utf8," + encodeURIComponent(svg);

const skin = ["#8c6a55", "#7a5a48", "#9a7660", "#6d5040", "#a3826c"];

/** A 16:9 still. `hue` sets the grade, `size` sets how large the figure sits in frame. */
export function stillArt(seed: number, hue: number, size: ShotSize | "none", people = 1): string {
  const r = rng(seed);
  const sat = 14 + r() * 16;
  const l1 = 16 + r() * 14;
  const l2 = l1 + 8 + r() * 12;
  const bg1 = `hsl(${hue} ${sat}% ${l1}%)`;
  const bg2 = `hsl(${(hue + 18) % 360} ${sat + 6}% ${l2}%)`;
  const floorY = 112 + r() * 26;
  const win = r() > 0.4;
  const winX = 20 + r() * 220;
  const shapes: string[] = [];
  shapes.push(
    `<rect x="${winX.toFixed(0)}" y="${(14 + r() * 20).toFixed(0)}" width="${(46 + r() * 60).toFixed(0)}" height="${(48 + r() * 30).toFixed(0)}" fill="hsl(${hue + 10} ${sat + 10}% ${l2 + 14}%)" opacity="${win ? 0.55 : 0.25}" filter="url(#b)"/>`,
  );
  shapes.push(`<rect x="0" y="${floorY.toFixed(0)}" width="320" height="${(180 - floorY).toFixed(0)}" fill="hsl(${hue} ${sat}% ${l1 - 6}%)"/>`);
  const figs: string[] = [];
  const n = size === "none" ? 0 : Math.min(people, 3);
  for (let i = 0; i < n; i++) {
    const cx = n === 1 ? 120 + r() * 80 : 80 + i * 80 + r() * 30;
    const c = skin[Math.floor(r() * skin.length)];
    const cloth = `hsl(${(hue + 160 + i * 40) % 360} 12% ${14 + r() * 12}%)`;
    const k = size === "closeup" ? 1 : size === "medium" ? 0.55 : 0.24;
    const kk = n > 1 ? k * 0.8 : k;
    const hr = 40 * kk;
    const hy = size === "wide" ? floorY - 30 * kk - 8 : 96 - 20 * kk;
    figs.push(
      `<path d="M${(cx - 95 * kk).toFixed(1)} ${(hy + 160 * kk).toFixed(1)} Q${(cx - 80 * kk).toFixed(1)} ${(hy + 62 * kk).toFixed(1)} ${cx.toFixed(1)} ${(hy + 56 * kk).toFixed(1)} Q${(cx + 80 * kk).toFixed(1)} ${(hy + 62 * kk).toFixed(1)} ${(cx + 95 * kk).toFixed(1)} ${(hy + 160 * kk).toFixed(1)}Z" fill="${cloth}"/>`,
      `<ellipse cx="${cx.toFixed(1)}" cy="${hy.toFixed(1)}" rx="${(hr * 0.8).toFixed(1)}" ry="${hr.toFixed(1)}" fill="${c}"/>`,
      `<ellipse cx="${cx.toFixed(1)}" cy="${(hy - hr * 0.55).toFixed(1)}" rx="${(hr * 0.84).toFixed(1)}" ry="${(hr * 0.55).toFixed(1)}" fill="hsl(${(hue + 30) % 360} 10% ${8 + r() * 10}%)"/>`,
    );
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${bg1}"/><stop offset="1" stop-color="${bg2}"/></linearGradient>` +
    `<filter id="b"><feGaussianBlur stdDeviation="9"/></filter></defs>` +
    `<rect width="320" height="180" fill="url(#g)"/>${shapes.join("")}<g>${figs.join("")}</g></svg>`;
  return svgUrl(svg);
}

/** Square face crop for a character. */
export function faceArt(seed: number, hue: number): string {
  const r = rng(seed);
  const c = skin[Math.floor(r() * skin.length)];
  const hair = `hsl(${(hue + 20) % 360} 10% ${8 + r() * 14}%)`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">` +
    `<rect width="96" height="96" fill="hsl(${hue} ${14 + r() * 12}% ${20 + r() * 12}%)"/>` +
    `<path d="M8 100 Q12 66 48 64 Q84 66 88 100Z" fill="hsl(${(hue + 170) % 360} 12% ${16 + r() * 10}%)"/>` +
    `<ellipse cx="48" cy="42" rx="17" ry="21" fill="${c}"/>` +
    `<path d="M30 38 Q32 18 48 18 Q64 18 66 38 Q60 28 48 28 Q36 28 30 38Z" fill="${hair}"/></svg>`;
  return svgUrl(svg);
}
