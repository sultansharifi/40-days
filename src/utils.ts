import * as THREE from "three";

/**
 * Resolves a path under public/ against the app's actual base URL, so asset
 * requests keep working when the site is served from a subpath (e.g. a
 * GitHub Pages project site at /40-days/) instead of the domain root.
 */
export function assetUrl(path: string): string {
  return import.meta.env.BASE_URL + path.replace(/^\/+/, "");
}

/** Declares the Vazirmatn @font-face at runtime, base-path safe (see assetUrl). */
export function injectFontFace() {
  const url = assetUrl("assets/fonts/Vazirmatn.woff2");
  const style = document.createElement("style");
  style.textContent = `
    @font-face {
      font-family: "Vazirmatn";
      src: url("${url}") format("woff2-variations"), url("${url}") format("woff2");
      font-weight: 100 900;
      font-style: normal;
      font-display: swap;
    }
  `;
  document.head.appendChild(style);
}

export function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/** Remaps t from [a,b] into [0,1] and clamps. */
export function segment(t: number, a: number, b: number): number {
  if (b === a) return t >= b ? 1 : 0;
  return clamp01((t - a) / (b - a));
}

export function smoothstep(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

export function easeOutCubic(t: number): number {
  const x = clamp01(t);
  return 1 - Math.pow(1 - x, 3);
}

export function easeOutBack(t: number): number {
  const x = clamp01(t);
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

/** A billboard sprite carrying a canvas-rendered label, e.g. "(blueprint)". */
export function makeLabelSprite(text: string, color = "#bfe7ff"): THREE.Sprite {
  const canvas = document.createElement("canvas");
  const scale = 2;
  canvas.width = 512 * scale;
  canvas.height = 128 * scale;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(scale, scale);
  ctx.font = "600 44px 'Vazirmatn', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = color;
  ctx.shadowBlur = 18;
  ctx.fillStyle = color;
  ctx.fillText(text, 256, 64);
  ctx.shadowBlur = 0;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(1.35, 0.34, 1);
  return sprite;
}

export function setLabelOpacity(sprite: THREE.Sprite, opacity: number) {
  (sprite.material as THREE.SpriteMaterial).opacity = opacity;
  sprite.visible = opacity > 0.01;
}

/** Simple deterministic pseudo-random generator so scatter/collapse motion is repeatable. */
export function mulberry32(seed: number) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
