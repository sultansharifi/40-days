// Copies vendor binary assets (KTX2/Basis transcoder + Vazirmatn font files)
// from node_modules into public/ so they can be served locally with no
// external network requests at runtime.
import { existsSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function ensureDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

function copyDir(src, dest) {
  if (!existsSync(src)) return false;
  ensureDir(dest);
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name);
    const d = join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else copyFileSync(s, d);
  }
  return true;
}

// 1) Basis/KTX2 transcoder (needed by KTX2Loader to decode the face texture)
const basisSrc = join(root, "node_modules/three/examples/jsm/libs/basis");
const basisDest = join(root, "public/assets/basis");
const okBasis = copyDir(basisSrc, basisDest);
console.log(okBasis ? `[vendor] copied basis transcoder -> public/assets/basis` : "[vendor] basis transcoder not found (skipped)");

// 2) Draco decoder (needed by GLTFLoader to decode the compressed car mesh).
// Use the smaller glTF-only decoder build, not the combined encoder+decoder one.
const dracoSrc = join(root, "node_modules/three/examples/jsm/libs/draco/gltf");
const dracoDest = join(root, "public/assets/draco");
const okDraco = copyDir(dracoSrc, dracoDest);
console.log(okDraco ? `[vendor] copied draco decoder -> public/assets/draco` : "[vendor] draco decoder not found (skipped)");

// 3) Vazirmatn variable font (Persian UI typeface)
const fontCandidates = [
  "node_modules/vazirmatn/fonts/webfonts/Vazirmatn[wght].woff2",
  "node_modules/vazirmatn/fonts/webfonts/Vazirmatn-Regular.woff2",
  "node_modules/vazirmatn/dist/Vazirmatn[wght].woff2",
];
const fontDestDir = join(root, "public/assets/fonts");
ensureDir(fontDestDir);
let copiedFont = false;
for (const rel of fontCandidates) {
  const src = join(root, rel);
  if (existsSync(src)) {
    copyFileSync(src, join(fontDestDir, "Vazirmatn.woff2"));
    console.log(`[vendor] copied font ${rel} -> public/assets/fonts/Vazirmatn.woff2`);
    copiedFont = true;
    break;
  }
}
if (!copiedFont) {
  console.warn("[vendor] Vazirmatn woff2 not found in node_modules — UI will fall back to system fonts");
}
