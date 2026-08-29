import { VIEWPORT_W, VIEWPORT_X } from "./theme.js";

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const xmlEscape = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]);

/** Approximate rendered width for a proportional sans/mono mix at the given px size. */
export function approxWidth(text: string, fontSize: number): number {
  // Tuned for Segoe UI / system fonts at our weights; close enough for overflow detection.
  return text.length * fontSize * 0.58;
}

/** Whether `text` is too wide for the key's text band. Single source of truth —
 *  `fitText` asks the same question, so the two can't disagree. */
export const overflows = (text: string, fontSize: number) =>
  approxWidth(text, fontSize) > VIEWPORT_W;

const ELLIPSIS = "…";

/** Where we aim when cutting — deliberately under the band. `overflows` keeps
 *  the old marquee threshold so nothing that rendered statically before starts
 *  getting cut, but once we've decided to cut there's no reason to stop flush
 *  against the border: `approxWidth` underestimates wide glyphs, and a truncated
 *  line touching the edge reads as broken rather than shortened. */
const CUT_TARGET = VIEWPORT_W * 0.9;

/** Cuts `text` down to what fits, appending an ellipsis when anything was
 *  dropped. Deliberately static: a key is glanced at, not read, and a scrolling
 *  line makes you wait for the part you need. A stable truncated string is
 *  legible in the half-second you actually look at the deck. */
export function fitText(text: string, fontSize: number): string {
  if (!overflows(text, fontSize)) return text;
  let n = text.length;
  while (n > 0 && approxWidth(text.slice(0, n) + ELLIPSIS, fontSize) > CUT_TARGET) n--;
  return text.slice(0, n) + ELLIPSIS;
}

/** Returns the SVG fragment for one centered line, truncated to fit and clipped
 *  to the text band. The clip is the backstop for `approxWidth` being a per-char
 *  estimate: a string of unusually wide glyphs measures narrower than it renders,
 *  and would otherwise spill past the border. When it fires the text is cut at
 *  both ends (the line is centered) and the ellipsis goes off-screen — that is
 *  the intended degradation, not a bug.
 *
 *  `clipId` must be unique within the SVG this fragment lands in. Each key is its
 *  own standalone document, so plain `ct`/`cb` are enough. */
export function textLine(opts: {
  text: string;
  baseline: number;
  fontSize: number;
  weight: string;
  color: string;
  clipId: string;
}): string {
  const { baseline, fontSize, weight, color, clipId } = opts;
  const text = fitText(opts.text, fontSize);
  if (!text) return "";
  const fontFamily = "-apple-system,Segoe UI,Roboto,sans-serif";
  // Box covers cap-top to descender.
  const clipY = baseline - Math.round(fontSize * 0.85);
  const clipH = Math.round(fontSize * 1.2);
  return `<defs><clipPath id="${clipId}"><rect x="${VIEWPORT_X}" y="${clipY}" width="${VIEWPORT_W}" height="${clipH}"/></clipPath></defs>
<text clip-path="url(#${clipId})" x="72" y="${baseline}" font-family="${fontFamily}" font-size="${fontSize}" font-weight="${weight}" fill="${color}" text-anchor="middle">${xmlEscape(text)}</text>`;
}
