// Photo fixtures for Phase G: the spec's bracket (80 x 40 x 6 plate, one
// Ø6.6 through hole at 70, 20 from the lower-left corner) photographed from
// above on a workbench, with a steel rule beside it; and a freeform part (a
// moulded handle) that v1 must refuse. Drawn in the browser so every edge's
// pixel position is known:
//   bracket-photo.jpg   1400 x 1000, 8 px/mm, face-on
//   freeform-photo.jpg  1400 x 1000, a smooth organic part
//
//   npx tsx scripts/make-photos.ts     (writes examples/photos/)

import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const OUT = "examples/photos";
export const PHOTO = { width: 1400, height: 1000, pxPerMm: 8 };
/** The bracket's top face in the photo, pixels (y down). */
export const PLATE = { left: 300, top: 260, right: 940, bottom: 580 };
/** The hole: centre and diameter in pixels. */
export const HOLE = { x: 300 + 70 * 8, y: 580 - 20 * 8, d: 6.6 * 8 };
/** The rule's 0 and 100 mm marks, pixels. */
export const RULE = { zero: [300, 712] as [number, number], hundred: [1100, 712] as [number, number] };

const bench = `
  <filter id="grain" x="0" y="0" width="100%" height="100%">
    <feTurbulence type="fractalNoise" baseFrequency="0.004 0.09" numOctaves="4" seed="7" result="n"/>
    <feColorMatrix type="matrix" values="0 0 0 0 0.42  0 0 0 0 0.29  0 0 0 0 0.17  0.9 0 0 0 0.25" in="n"/>
    <feComposite operator="in" in2="SourceGraphic"/>
  </filter>
  <filter id="speck"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="3"/><feColorMatrix type="saturate" values="0"/>
    <feComponentTransfer><feFuncA type="linear" slope="0.08"/></feComponentTransfer></filter>
  <filter id="brushed" x="0" y="0" width="100%" height="100%">
    <feTurbulence type="fractalNoise" baseFrequency="0.002 0.6" numOctaves="3" seed="11"/>
    <feColorMatrix type="matrix" values="0 0 0 0 0.55  0 0 0 0 0.57  0 0 0 0 0.6  0 0 0 0.35 0"/>
    <feComposite operator="in" in2="SourceGraphic"/>
  </filter>
  <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="9"/></filter>
  <radialGradient id="vignette" cx="50%" cy="48%" r="75%"><stop offset="60%" stop-color="#000" stop-opacity="0"/><stop offset="100%" stop-color="#000" stop-opacity="0.45"/></radialGradient>
  <linearGradient id="steel" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#c9ccd0"/><stop offset="0.45" stop-color="#a7abb1"/><stop offset="1" stop-color="#8d9298"/></linearGradient>
  <linearGradient id="wood" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9a6b42"/><stop offset="1" stop-color="#7e5533"/></linearGradient>`;

function benchLayer(w: number, h: number): string {
  return `<rect width="${w}" height="${h}" fill="url(#wood)"/>
    <rect width="${w}" height="${h}" fill="#fff" filter="url(#grain)"/>`;
}

function finish(w: number, h: number): string {
  return `<rect width="${w}" height="${h}" filter="url(#speck)"/>
    <rect width="${w}" height="${h}" fill="url(#vignette)"/>`;
}

function rule(): string {
  const [x0, y0] = RULE.zero;
  const s = PHOTO.pxPerMm;
  const out: string[] = [
    `<rect x="${x0 - 40 + 10}" y="${y0 - 14 + 10}" width="${115 * s}" height="${82}" rx="4" fill="#000" opacity="0.45" filter="url(#shadow)"/>`,
    `<rect x="${x0 - 40}" y="${y0 - 14}" width="${115 * s}" height="${82}" rx="4" fill="url(#steel)"/>`,
    `<rect x="${x0 - 40}" y="${y0 - 14}" width="${115 * s}" height="${82}" rx="4" fill="#fff" filter="url(#brushed)"/>`,
  ];
  for (let mm = 0; mm <= 110; mm++) {
    const x = x0 + mm * s;
    const len = mm % 10 === 0 ? 30 : mm % 5 === 0 ? 20 : 12;
    out.push(`<line x1="${x}" y1="${y0 - 14}" x2="${x}" y2="${y0 - 14 + len}" stroke="#1d1f22" stroke-width="1.6"/>`);
    if (mm % 10 === 0) out.push(`<text x="${x}" y="${y0 + 36}" font-size="17" font-family="Arial" text-anchor="middle" fill="#1d1f22">${mm / 10}</text>`);
  }
  out.push(`<text x="${x0 + 104 * s}" y="${y0 + 58}" font-size="11" font-family="Arial" fill="#2a2c30">mm</text>`);
  return out.join("\n");
}

export function bracketPhotoSvg(): string {
  const { width: w, height: h } = PHOTO;
  const { left, top, right, bottom } = PLATE;
  const pw = right - left;
  const ph = bottom - top;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>${bench}
    <mask id="holed"><rect x="${left}" y="${top}" width="${pw}" height="${ph}" fill="#fff"/><circle cx="${HOLE.x}" cy="${HOLE.y}" r="${HOLE.d / 2}" fill="#000"/></mask>
  </defs>
  ${benchLayer(w, h)}
  <rect x="${left + 14}" y="${top + 16}" width="${pw}" height="${ph}" fill="#000" opacity="0.5" filter="url(#shadow)"/>
  <g mask="url(#holed)">
    <rect x="${left}" y="${top}" width="${pw}" height="${ph}" fill="url(#steel)"/>
    <rect x="${left}" y="${top}" width="${pw}" height="${ph}" fill="#fff" filter="url(#brushed)"/>
    <rect x="${left + 1.5}" y="${top + 1.5}" width="${pw - 3}" height="${ph - 3}" fill="none" stroke="#e4e6e9" stroke-width="3" opacity="0.8"/>
  </g>
  <circle cx="${HOLE.x}" cy="${HOLE.y}" r="${HOLE.d / 2 - 1}" fill="none" stroke="#3b3f45" stroke-width="2.5" opacity="0.7"/>
  ${rule()}
  ${finish(w, h)}
</svg>`;
}

export function freeformPhotoSvg(): string {
  const { width: w, height: h } = PHOTO;
  const body = "M380,520 C380,360 560,300 720,330 C900,365 1040,330 1080,450 C1120,580 980,690 820,670 C690,655 600,720 480,690 C400,670 380,600 380,520 Z";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>${bench}
    <radialGradient id="moulded" cx="42%" cy="38%" r="70%"><stop offset="0" stop-color="#5f8fd0"/><stop offset="0.55" stop-color="#2d5d9e"/><stop offset="1" stop-color="#163259"/></radialGradient>
    <radialGradient id="gloss" cx="40%" cy="32%" r="30%"><stop offset="0" stop-color="#fff" stop-opacity="0.55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
  </defs>
  ${benchLayer(w, h)}
  <path d="${body}" transform="translate(18 22)" fill="#000" opacity="0.5" filter="url(#shadow)"/>
  <path d="${body}" fill="url(#moulded)"/>
  <path d="${body}" fill="url(#gloss)"/>
  <path d="M520,470 C600,430 700,440 760,480" fill="none" stroke="#0f2441" stroke-width="10" stroke-linecap="round" opacity="0.5"/>
  ${finish(w, h)}
</svg>`;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: PHOTO.width, height: PHOTO.height }, deviceScaleFactor: 1 });
    for (const [file, svg] of [
      ["bracket-photo.jpg", bracketPhotoSvg()],
      ["freeform-photo.jpg", freeformPhotoSvg()],
    ] as const) {
      await page.setContent(`<html><body style="margin:0">${svg}</body></html>`);
      writeFileSync(`${OUT}/${file}`, await page.screenshot({ type: "jpeg", quality: 88 }));
    }
  } finally {
    await browser.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
