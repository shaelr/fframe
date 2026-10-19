// library.js — "Biblioteca": pastas que JA existem no NAS (ex.: um share SMB
// montado read-only em LIBRARY_DIR) vinculadas a projetos do Fframe.
// Os videos NAO sao copiados: o asset aponta para o arquivo original e o
// painel faz streaming direto dele. Remover/desvincular nunca apaga o arquivo.
//
// data/library.json: [{ id, path, project_id, recursive, hidden[], added_at, last_scan, count, error }]
// `path` e relativo a LIBRARY_DIR (ex.: "Clientes/2026/Shoot A").

const fs = require("fs");
const path = require("path");
const store = require("./store");
const transcript = require("./transcript");

const LIBRARY_DIR = path.resolve(process.env.LIBRARY_DIR || "/library");
const LINKS_FILE = path.join(store.DATA_DIR, "library.json");

// Extensoes indexadas. O navegador so toca bem MP4/MOV(H.264/HEVC)/WebM;
// os demais aparecem para download/organizacao.
const MIME = {
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime",
  ".webm": "video/webm", ".mkv": "video/x-matroska", ".avi": "video/x-msvideo",
  ".mxf": "application/mxf", ".mts": "video/mp2t", ".m2ts": "video/mp2t",
};
// Transcricoes "irmas" do video (mesmo nome) sao anexadas automaticamente.
const TRANSCRIPT_EXT = new Set([".json", ".srt", ".vtt", ".txt"]);
const LIB_TRANSCRIPT_FPS = Number(process.env.TRANSCRIPT_FPS) || 24;
// Pastas de sistema do TrueNAS/SMB/macOS que nunca devem aparecer.
const SKIP_DIRS = new Set([".zfs", ".recycle", "@eaDir", ".Trashes", ".Spotlight-V100", ".fseventsd", ".TemporaryItems"]);
const MAX_FILES_PER_LINK = 20000;

function enabled() {
  try { return fs.statSync(LIBRARY_DIR).isDirectory(); } catch { return false; }
}

// Resolve um caminho relativo garantindo que fica DENTRO de LIBRARY_DIR
// (bloqueia "..", caminhos absolutos e symlinks que escapam do share).
function resolveSafe(rel) {
  const clean = String(rel || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const abs = path.resolve(LIBRARY_DIR, clean);
  let real;
  try { real = fs.realpathSync(abs); } catch { return null; }
  const root = fs.realpathSync(LIBRARY_DIR);
  if (real !== root && !real.startsWith(root + path.sep)) return null;
  return { abs: real, rel: path.relative(root, real).split(path.sep).join("/") };
}

const hiddenName = (n) => n.startsWith(".") || SKIP_DIRS.has(n);

// ---- Vinculos ---------------------------------------------------------------
let links = [];
try { links = JSON.parse(fs.readFileSync(LINKS_FILE, "utf8")); } catch { links = []; }
if (!Array.isArray(links)) links = [];
const persist = () => fs.writeFileSync(LINKS_FILE, JSON.stringify(links, null, 2));

const listLinks = () => links.map((l) => {
  const p = store.getProject(l.project_id);
  return { ...l, project_name: p ? p.name : null };
});
const getLink = (id) => links.find((l) => l.id === id);

// Navegar: subpastas + quantos videos ha DIRETAMENTE nesta pasta.
function browse(rel) {
  const r = resolveSafe(rel);
  if (!r) return null;
  let entries;
  try { entries = fs.readdirSync(r.abs, { withFileTypes: true }); } catch (e) { return { path: r.rel, error: e.code || e.message, dirs: [], videos: 0 }; }
  const dirs = [];
  let videos = 0;
  for (const e of entries) {
    if (hiddenName(e.name)) continue;
    let isDir = e.isDirectory(), isFile = e.isFile();
    if (e.isSymbolicLink()) {
      if (!resolveSafe((r.rel ? r.rel + "/" : "") + e.name)) continue; // aponta pra fora do share
      try { const st = fs.statSync(path.join(r.abs, e.name)); isDir = st.isDirectory(); isFile = st.isFile(); } catch { continue; }
    }
    if (isDir) {
      const childRel = r.rel ? r.rel + "/" + e.name : e.name;
      dirs.push({ name: e.name, path: childRel, links: links.filter((l) => l.path === childRel).map((l) => l.id) });
    } else if (isFile && MIME[path.extname(e.name).toLowerCase()]) videos++;
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  return { path: r.rel, name: r.rel ? path.basename(r.rel) : "", dirs, videos, links: links.filter((l) => l.path === r.rel).map((l) => l.id) };
}

// Lista os videos de uma pasta (recursivo opcional), com limite de seguranca.
async function walk(absDir, recursive, out) {
  let entries;
  try { entries = await fs.promises.readdir(absDir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (out.length >= MAX_FILES_PER_LINK) return;
    if (hiddenName(e.name)) continue;
    const full = path.join(absDir, e.name);
    let st;
    try { st = await fs.promises.stat(full); } catch { continue; }
    if (st.isDirectory()) { if (recursive) await walk(full, recursive, out); }
    else if (st.isFile() && MIME[path.extname(e.name).toLowerCase()]) out.push({ full, st });
    else if (st.isFile() && TRANSCRIPT_EXT.has(path.extname(e.name).toLowerCase()) && st.size < 20 * 1024 * 1024) {
      (out.transcripts || (out.transcripts = new Map())).set(full, st);
    }
  }
}

// (Re)indexa um vinculo: adiciona videos novos, atualiza tamanho/data e tira
// do indice os que sumiram do disco. IDs existentes sao mantidos (comentarios
// continuam valendo depois de um rescan).
const scanning = new Set();
async function scan(linkId) {
  const link = getLink(linkId);
  if (!link || scanning.has(linkId)) return link;
  scanning.add(linkId);
  try {
    const r = resolveSafe(link.path);
    // Pasta sumiu ou sem permissao (share desmontado, ACL...): NAO apaga o
    // indice — senao os comentarios se perderiam. So registra o erro.
    let readErr = r ? null : "pasta nao encontrada";
    if (r) { try { await fs.promises.readdir(r.abs); } catch (e) { readErr = e.code || e.message; } }
    if (readErr) { link.error = readErr; link.last_scan = new Date().toISOString(); persist(); return link; }
    link.error = null;
    const proj = store.getProject(link.project_id) || store.getConnectedProject();
    const found = [];
    await walk(r.abs, link.recursive !== false, found);

    const all = store.assets();
    const byPath = new Map();
    for (const a of Object.values(all)) if (a.library_link_id === link.id) byPath.set(a.stored_path, a);
    const hidden = new Set(link.hidden || []);
    const seen = new Set();
    for (const { full, st } of found) {
      if (hidden.has(full)) continue;
      seen.add(full);
      const relDir = path.relative(r.abs, path.dirname(full)).split(path.sep).join("/");
      const fields = {
        project_id: proj.id, project_name: proj.name, parent_id: proj.root_asset_id,
        name: path.basename(full), filetype: MIME[path.extname(full).toLowerCase()],
        filesize: st.size, uploaded_at: st.mtime.toISOString(),
        library_folder: [link.path, relDir].filter(Boolean).join("/"),
      };
      const existing = byPath.get(full);
      const asset = existing ? Object.assign(existing, fields)
        : store.addLibraryAsset({ ...fields, stored_path: full, library_link_id: link.id });
      attachSiblingTranscript(asset, full, found.transcripts);
    }
    for (const [p, a] of byPath) if (!seen.has(p)) store.forgetAsset(a.id);
    store.saveAssets();

    link.count = seen.size;
    link.truncated = found.length >= MAX_FILES_PER_LINK;
    link.last_scan = new Date().toISOString();
    persist();
    return link;
  } finally { scanning.delete(linkId); }
}

// Procura "<nome>.srt/.vtt/.txt/.json" na mesma pasta do video. Upload manual
// pelo painel tem prioridade e nunca e sobrescrito pela biblioteca.
function attachSiblingTranscript(asset, videoPath, transcripts) {
  if (!transcripts) return;
  const dir = path.dirname(videoPath), key = transcript.matchKey(videoPath);
  let pick = null;
  for (const [p, st] of transcripts) {
    if (path.dirname(p) !== dir || transcript.matchKey(p) !== key) continue;
    // prefere o JSON por palavra do script do Resolve
    if (!pick || path.extname(p).toLowerCase() === ".json") pick = { p, st };
  }
  if (!pick) return;
  const cur = transcript.load(asset.id);
  if (cur && cur.source !== "library") return;
  const mtime = pick.st.mtime.toISOString();
  if (cur && cur.source_path === pick.p && cur.source_mtime === mtime) return;
  let content;
  try { content = fs.readFileSync(pick.p, "utf8"); } catch { return; }
  const r = transcript.parse(content, { filename: pick.p, fps: cur ? cur.fps : LIB_TRANSCRIPT_FPS });
  if (r.error) return;
  if (cur && cur.offset != null && cur.source_path === pick.p) r.offset = cur.offset;
  transcript.apply(asset.id, r, { source: "library", source_path: pick.p, source_mtime: mtime });
}

async function addLink({ relPath, projectId, recursive }) {
  const r = resolveSafe(relPath);
  if (!r) return { error: "pasta invalida" };
  try { if (!fs.statSync(r.abs).isDirectory()) return { error: "nao e uma pasta" }; } catch { return { error: "pasta invalida" }; }
  if (!store.getProject(projectId)) return { error: "projeto inexistente" };
  if (links.some((l) => l.path === r.rel && l.project_id === projectId)) return { error: "pasta ja vinculada a este projeto" };
  const link = {
    id: store.uuid(), path: r.rel, project_id: projectId, recursive: recursive !== false,
    hidden: [], added_at: new Date().toISOString(), last_scan: null, count: 0, error: null,
  };
  links.push(link);
  persist();
  await scan(link.id);
  return { link };
}

// Desvincular: tira os videos do Fframe (e seus comentarios). Arquivos ficam intactos.
function removeLink(id) {
  const i = links.findIndex((l) => l.id === id);
  if (i < 0) return false;
  for (const a of Object.values(store.assets())) if (a.library_link_id === id) store.forgetAsset(a.id);
  store.saveAssets();
  links.splice(i, 1);
  persist();
  return true;
}

// "Remover" um video da biblioteca: esconde (rescan nao traz de volta).
function hideAsset(asset) {
  const link = getLink(asset.library_link_id);
  if (link) {
    link.hidden = Array.from(new Set([...(link.hidden || []), asset.stored_path]));
    link.count = Math.max(0, (link.count || 1) - 1);
    persist();
  }
  store.forgetAsset(asset.id);
  store.saveAssets();
}

// Projeto apagado -> seus vinculos somem tambem.
function dropLinksForProject(projectId) {
  links.filter((l) => l.project_id === projectId).forEach((l) => removeLink(l.id));
}

async function scanAll() { for (const l of links.slice()) { try { await scan(l.id); } catch {} } }

module.exports = {
  LIBRARY_DIR, enabled, browse, listLinks, getLink, addLink, removeLink, scan, scanAll,
  hideAsset, dropLinksForProject, isScanning: (id) => scanning.has(id),
};
