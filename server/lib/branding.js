// branding.js — identidade visual do painel (nome, cor de destaque, logo, favicon).
//
// data/branding.json  -> { name, accent, logo, favicon, v }
// data/branding/      -> os arquivos de imagem enviados (logo.*, favicon.*)
// O servidor injeta isso na pagina (titulo, favicon, tema) antes de enviar,
// entao ninguem ve o visual padrao piscar antes do da empresa.

const fs = require("fs");
const path = require("path");
const store = require("./store");

const FILE = path.join(store.DATA_DIR, "branding.json");
const DIR = path.join(store.DATA_DIR, "branding");
const DEFAULT_ACCENT = "#1A4DFF";
const IMAGE_TYPES = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/svg+xml": "svg",
  "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico", "image/gif": "gif",
};
const MAX_BYTES = 3 * 1024 * 1024;

let b = {};
try { b = JSON.parse(fs.readFileSync(FILE, "utf8")) || {}; } catch { b = {}; }
const save = () => { b.v = Date.now().toString(36); fs.writeFileSync(FILE, JSON.stringify(b, null, 2)); };

const name = () => (b.name && String(b.name).trim()) || "Fframe";
const accent = () => (/^#[0-9a-f]{6}$/i.test(b.accent || "") ? b.accent.toUpperCase() : DEFAULT_ACCENT);
const version = () => b.v || "0";

// Texto sobre a cor de destaque: preto em cores claras, branco nas escuras.
function onAccent(hex) {
  const c = hex.slice(1).match(/../g).map((x) => parseInt(x, 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const L = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return L > 0.4 ? "#0A0A0B" : "#FFFFFF";
}

function imagePath(kind) {
  const f = b[kind];
  if (!f || !/^(logo|favicon)\.[a-z]+$/.test(f)) return null;
  const p = path.join(DIR, f);
  return fs.existsSync(p) ? p : null;
}
const urlFor = (kind) => (imagePath(kind) ? `/_brand/${kind}?v=${version()}` : null);

/** O que o navegador precisa (publico: os clientes do link tambem usam). */
function publicInfo() {
  return {
    name: name(), accent: accent(), on_accent: onAccent(accent()),
    logo: urlFor("logo"), favicon: urlFor("favicon"), default_accent: DEFAULT_ACCENT, v: version(),
  };
}

function update(patch) {
  patch = patch || {};
  if ("name" in patch) b.name = String(patch.name || "").replace(/\s+/g, " ").trim().slice(0, 60) || null;
  if ("accent" in patch) {
    const a = String(patch.accent || "").trim();
    if (a && !/^#[0-9a-f]{6}$/i.test(a)) throw new Error("the accent color must look like #1A4DFF");
    b.accent = a || null;
  }
  save();
  return publicInfo();
}

function setImage(kind, buf, mime) {
  const ext = IMAGE_TYPES[String(mime || "").split(";")[0].trim().toLowerCase()];
  if (!ext) throw new Error("use a PNG, JPG, WebP, SVG, GIF or ICO image");
  if (!buf || !buf.length) throw new Error("the file is empty");
  if (buf.length > MAX_BYTES) throw new Error("the image is larger than 3 MB");
  if (ext === "svg" && !/<svg[\s>]/i.test(buf.slice(0, 4096).toString("utf8"))) throw new Error("that file isn't an SVG image");
  fs.mkdirSync(DIR, { recursive: true });
  const old = imagePath(kind);
  if (old) { try { fs.unlinkSync(old); } catch {} }
  const f = `${kind}.${ext}`;
  fs.writeFileSync(path.join(DIR, f), buf);
  b[kind] = f;
  save();
  return publicInfo();
}
function clearImage(kind) {
  const old = imagePath(kind);
  if (old) { try { fs.unlinkSync(old); } catch {} }
  b[kind] = null;
  save();
  return publicInfo();
}
function reset() {
  for (const k of ["logo", "favicon"]) { const p = imagePath(k); if (p) { try { fs.unlinkSync(p); } catch {} } }
  b = {};
  save();
  return publicInfo();
}

const themeCss = () => `/* tema da empresa (gerado) */\n:root{--royal:${accent()};--on-accent:${onAccent(accent())}}\n`;

// ---- Pagina com a marca aplicada ---------------------------------------------
const attr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
let shellCache = null;
function shellHtml(file) {
  if (!shellCache || shellCache.mtime !== fs.statSync(file).mtimeMs) {
    shellCache = { mtime: fs.statSync(file).mtimeMs, html: fs.readFileSync(file, "utf8") };
  }
  const info = publicInfo(), v = version();
  const icon = info.favicon || "/icon.svg";
  return shellCache.html
    .replace(/<html lang="en">/, `<html lang="en" data-brand-name="${attr(info.name)}" data-brand-logo="${attr(info.logo || "")}" data-brand-icon="${attr(icon)}">`)
    .replace(/<title>[^<]*<\/title>/, `<title>${attr(info.name)}</title>`)
    .replace(/(<meta name="apple-mobile-web-app-title" content=")[^"]*"/, `$1${attr(info.name)}"`)
    .replace(/<link rel="icon" href="[^"]*" type="[^"]*" \/>/, `<link rel="icon" href="${attr(icon)}" />`)
    .replace(/(<link rel="apple-touch-icon" href=")[^"]*"/, `$1${attr(info.favicon || "/icon-192.png")}"`)
    .replace(/(<link rel="stylesheet" href="\/app\.css" \/>)/, `$1\n<link rel="stylesheet" href="/_brand/theme.css?v=${v}" />`);
}

function manifest() {
  const info = publicInfo();
  const icons = info.favicon
    ? [{ src: info.favicon, sizes: "any", type: mimeOf("favicon") || "image/png" }]
    : [{ src: "/icon-192.png", sizes: "192x192", type: "image/png" }, { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
       { src: "/icon.svg", sizes: "any", type: "image/svg+xml" }];
  return { name: info.name, short_name: info.name.slice(0, 12), start_url: "/", display: "standalone",
    background_color: "#0A0A0B", theme_color: "#0A0A0B", icons };
}
function mimeOf(kind) {
  const p = imagePath(kind);
  if (!p) return null;
  const ext = path.extname(p).slice(1);
  return Object.keys(IMAGE_TYPES).find((m) => IMAGE_TYPES[m] === ext) || "application/octet-stream";
}

module.exports = { name, accent, onAccent, publicInfo, update, setImage, clearImage, reset, imagePath, mimeOf, themeCss, shellHtml, manifest, version };
