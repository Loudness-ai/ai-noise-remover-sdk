import { brand, wordmark } from "./brand.js";
/** Portable outlines of the canonical mark; no font downloads or local font dependency. */
export function brandSvg(dark = false): string {
  const bars = brand.bars
    .map(
      (b) =>
        `<line x1="${b.x}" x2="${b.x}" y1="${brand.centerY - b.height / 2}" y2="${brand.centerY + b.height / 2}"/>`,
    )
    .join("");
  const words = wordmark.glyphs
    .map(
      (g) =>
        `<path d="${g.d}" transform="translate(${g.x} 0)" fill="${dark && g.color === "#000000" ? "#ffffff" : g.color}"/>`,
    )
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 226 32" role="img" aria-label="Loudness.ai"><g transform="translate(0 3)"><rect x="1" y="1" width="24" height="24" rx="7" fill="#000000"/><g stroke="${brand.color}" stroke-width="${brand.strokeWidth}" stroke-linecap="round">${bars}</g></g><g transform="translate(35 27) scale(${191 / wordmark.advance} ${-191 / wordmark.advance})">${words}</g></svg>`;
}
