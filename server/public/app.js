"use strict";
// Frontend do painel. NENHUM segredo aqui: a autenticacao e feita por cookie de
// sessao (httpOnly) e TODA autorizacao e validada no servidor.
// Textos visiveis vem do i18n.js (t("chave")) — nunca escreva texto fixo aqui.

let projects = [], current = null, configured = false;
const DEVICES_VIEW = "__devices__"; // valor especial de `current` p/ tela Dispositivos
const NOTIFY_VIEW = "__notify__";   // tela de configuracao das notificacoes
const BRAND_VIEW = "__brand__";     // tela da marca (nome, cor, logo, favicon)
const LIBRARY_VIEW = "__library__"; // tela Biblioteca (pastas do NAS)
let libraryPath = "";               // pasta aberta no navegador da Biblioteca

const $ = (id) => document.getElementById(id);

// Marca da empresa (o servidor ja injeta no <html>): nome, logo e icone.
const Brand = {
  get name() { return document.documentElement.dataset.brandName || "Fframe"; },
  get logo() { return document.documentElement.dataset.brandLogo || ""; },
  get icon() { return document.documentElement.dataset.brandIcon || "/icon-192.png"; },
};
// Logo (se houver) ou o ponto + nome. `sub` = linha pequena embaixo do nome.
function brandMark(sub, big) {
  if (Brand.logo) return `<img class="brand-logo${big ? " big" : ""}" src="${escapeHtml(Brand.logo)}" alt="${escapeHtml(Brand.name)}" />`;
  return `<span class="dot"></span><div class="brand-txt"><b>${escapeHtml(Brand.name)}</b>${sub ? `<span>${escapeHtml(sub)}</span>` : ""}</div>`;
}
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtSize = (b) => b >= 1073741824 ? (b / 1073741824).toFixed(2) + " GB"
  : b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB";
const fmtTime = (s) => { try { return new Date(s).toLocaleString(I18n.locale(), { hour: "2-digit", minute: "2-digit" }); } catch { return ""; } };
const fmtDate = (d) => { try { return new Date(d + "T00:00:00").toLocaleDateString(I18n.locale(), { weekday: "long", day: "2-digit", month: "long" }); } catch { return d; } };
const fmtDay = (s) => { try { return new Date(s).toLocaleDateString(I18n.locale(), { day: "2-digit", month: "2-digit", year: "numeric" }); } catch { return ""; } };

async function api(method, url, body) {
  const opt = { method, headers: {} };
  if (body !== undefined) { opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(body); }
  const r = await fetch(url, opt);
  if (r.status === 401) { showAuth(); throw new Error("nao autenticado"); }
  return r;
}

// ---- Avisos (toast) e modais — dentro do site, sem popups do navegador ------
function toast(msg, type) {
  const el = document.createElement("div");
  el.className = "toast" + (type === "err" ? " err" : type === "ok" ? " ok" : "");
  el.textContent = msg;
  $("toasts").appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => { el.classList.remove("show"); setTimeout(() => el.remove(), 250); }, 3400);
}
function dialog({ title, message, input, placeholder, okText, danger }) {
  return new Promise((resolve) => {
    const back = $("modal");
    back.innerHTML =
      `<div class="modal-card">
        <h3>${escapeHtml(title || "")}</h3>
        ${message ? `<p class="modal-msg">${escapeHtml(message)}</p>` : ""}
        ${input ? `<input id="modal-input" class="fld" type="text" placeholder="${escapeHtml(placeholder || "")}" />` : ""}
        <div class="modal-acts">
          <button class="btn-ghost" data-act="cancel" type="button">${escapeHtml(t("modal.cancel"))}</button>
          <button class="btn-primary${danger ? " danger" : ""}" data-act="ok" type="button">${escapeHtml(okText || t("modal.ok"))}</button>
        </div>
      </div>`;
    back.classList.add("show");
    const inp = back.querySelector("#modal-input");
    if (inp) setTimeout(() => inp.focus(), 60);
    const close = (val) => { back.classList.remove("show"); setTimeout(() => (back.innerHTML = ""), 180); resolve(val); };
    back.querySelector('[data-act="cancel"]').addEventListener("click", () => close(input ? null : false));
    back.querySelector('[data-act="ok"]').addEventListener("click", () => close(input ? (inp ? inp.value : "") : true));
    back.addEventListener("click", (e) => { if (e.target === back) close(input ? null : false); });
    if (inp) inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); close(inp.value); } });
  });
}
// Menu suspenso (ex.: Download -> Video / Transcricao). items: [{ label, sub, href }]
function openMenu(anchor, items) {
  closeMenu();
  const m = document.createElement("div");
  m.className = "menu-pop"; m.id = "menu-pop"; m.setAttribute("role", "menu");
  m.innerHTML = items.map((it, i) => `<a class="menu-item" role="menuitem" href="${escapeHtml(it.href)}" data-i="${i}" download>
      <span class="menu-l">${escapeHtml(it.label)}</span>${it.sub ? `<span class="menu-s">${escapeHtml(it.sub)}</span>` : ""}</a>`).join("");
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect(), w = m.offsetWidth;
  m.style.top = Math.min(window.innerHeight - m.offsetHeight - 8, r.bottom + 6) + "px";
  m.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w)) + "px";
  m.addEventListener("click", () => setTimeout(closeMenu, 0));
  setTimeout(() => {
    document.addEventListener("pointerdown", menuOutside, true);
    document.addEventListener("keydown", menuEsc, true);
  }, 0);
  const first = m.querySelector("a"); if (first) first.focus();
}
const menuOutside = (e) => { const m = $("menu-pop"); if (m && !m.contains(e.target)) closeMenu(); };
const menuEsc = (e) => { if (e.key === "Escape") { e.stopPropagation(); closeMenu(); } };
function closeMenu() {
  const m = $("menu-pop"); if (m) m.remove();
  document.removeEventListener("pointerdown", menuOutside, true);
  document.removeEventListener("keydown", menuEsc, true);
}
function startDownload(href) {
  const a = document.createElement("a"); a.href = href; a.download = "";
  document.body.appendChild(a); a.click(); a.remove();
}
// Download de um card: um item so = baixa direto; dois = abre o menu.
function downloadItems(a, urls) {
  const items = [];
  if (urls.video) items.push({ label: t("dl.video"), sub: a.name, href: urls.video });
  if (urls.transcript && a.has_transcript) items.push({ label: t("dl.transcript"), sub: t("dl.transcriptSub"), href: urls.transcript });
  return items;
}
function wireDownloads(root, list, urlsFor) {
  root.querySelectorAll("[data-dl]").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    const a = list.find((x) => x.id === b.dataset.dl);
    const items = a ? downloadItems(a, urlsFor(a)) : [];
    if (items.length === 1) startDownload(items[0].href); else if (items.length) openMenu(b, items);
  }));
}
// Modal so de leitura (ex.: atalhos de teclado). `html` ja vem escapado.
function infoModal(title, html) {
  const back = $("modal");
  back.innerHTML = `<div class="modal-card info-card"><h3>${escapeHtml(title)}</h3>${html}
    <div class="modal-acts"><button class="btn-primary" data-act="ok" type="button">${escapeHtml(t("modal.ok"))}</button></div></div>`;
  back.classList.add("show");
  const close = () => { back.classList.remove("show"); setTimeout(() => (back.innerHTML = ""), 180); document.removeEventListener("keydown", onEsc, true); };
  const onEsc = (e) => { if (e.key === "Escape" || e.key === "?") { e.preventDefault(); e.stopPropagation(); close(); } };
  back.querySelector('[data-act="ok"]').addEventListener("click", close);
  back.onclick = (e) => { if (e.target === back) close(); };
  // so depois da tecla que abriu (senao o "?" que abriu ja fecharia)
  setTimeout(() => document.addEventListener("keydown", onEsc, true), 0);
  back.querySelector('[data-act="ok"]').focus();
}

const confirmModal = (message, okText, danger) =>
  dialog({ title: t("modal.confirmTitle"), message, okText: okText || t("modal.confirm"), danger });
const promptModal = (title, placeholder) => dialog({ title, input: true, placeholder, okText: t("modal.create") });

// ---- Autenticacao -----------------------------------------------------------
function applyBrandShell() {
  const side = document.querySelector("#side .brand");
  if (side) {
    const bell = $("bell");
    side.innerHTML = brandMark(location.host);
    if (bell) side.appendChild(bell);
    const host = side.querySelector(".brand-txt span"); if (host) host.id = "host";
  }
  const auth = document.querySelector("#auth-card .auth-brand");
  if (auth) auth.innerHTML = brandMark("", true);
}
async function init() {
  I18n.init();
  applyBrandShell();
  if (isSharePath()) return route();                 // link do cliente: sem login
  const st = await (await fetch("/_auth/status")).json();
  configured = st.configured;
  if (st.authed) showApp(); else showAuth();
}
function showAuth() {
  $("app").classList.add("hidden");
  $("auth").classList.remove("hidden");
  const setup = !configured;
  $("auth-title").textContent = setup ? t("auth.title.setup") : t("auth.title.signin");
  $("auth-sub").textContent = setup ? t("auth.sub.setup") : "";
  $("auth-pass2").classList.toggle("hidden", !setup);
  $("auth-pass").setAttribute("autocomplete", setup ? "new-password" : "current-password");
  $("auth-btn").textContent = setup ? t("auth.btn.setup") : t("auth.btn.signin");
  $("auth-err").textContent = "";
}
function showApp() {
  $("auth").classList.add("hidden");
  $("app").classList.remove("hidden");
  if ($("host")) $("host").textContent = location.host;
  route();
  Notifs.start();
  // Biblioteca so aparece se o share estiver montado (e so p/ sessao de admin).
  fetch("/_api/library/status").then((r) => r.ok ? r.json() : null)
    .then((s) => $("nav-library").classList.toggle("hidden", !(s && s.enabled))).catch(() => {});
}
async function submitAuth(ev) {
  ev.preventDefault();
  const setup = !configured;
  const user = $("auth-user").value.trim();
  const pass = $("auth-pass").value;
  const err = $("auth-err");
  err.textContent = "";
  if (setup && pass !== $("auth-pass2").value) { err.textContent = t("auth.err.mismatch"); return; }
  $("auth-btn").disabled = true;
  try {
    const remember = $("auth-remember").checked;
    const r = await fetch(setup ? "/_auth/setup" : "/_auth/login",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user, password: pass, remember }) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { err.textContent = data.error === "invalid credentials" ? t("auth.err.invalid") : (data.error || t("auth.err.generic")); return; }
    configured = true;
    $("auth-pass").value = ""; $("auth-pass2").value = "";
    showApp();
  } finally { $("auth-btn").disabled = false; }
}
async function logout() {
  // Sair para de mandar push para este navegador (volta sozinho no proximo login).
  if (Notifs.push) await Notifs.pushDisable().catch(() => {});
  await api("POST", "/_auth/logout"); location.reload();
}

// ---- Projetos + videos ------------------------------------------------------
async function loadProjects() {
  projects = await (await api("GET", "/_api/projects")).json();
  const box = $("projects");
  box.innerHTML = "";
  const total = projects.reduce((s, p) => s + p.video_count, 0);
  box.appendChild(projRow({ id: null, name: t("title.allVideos"), video_count: total }, true));
  projects.forEach((p) => box.appendChild(projRow(p, false)));
  $("total").textContent = t("side.stats", { projects: projects.length, videos: total });
}
function projRow(p, isAll) {
  const el = document.createElement("div");
  el.className = "proj" + (current === p.id ? " active" : "");
  el.innerHTML =
    (p.connected ? `<span class="conn" title="${escapeHtml(t("proj.connected"))}"></span>` : "") +
    `<span class="nm">${escapeHtml(p.name)}</span><span class="ct">${p.video_count}</span>` +
    (!isAll ? `<span class="del" role="button" title="${escapeHtml(t("proj.deleteTitle"))}" data-del="${p.id}" data-name="${escapeHtml(p.name)}">×</span>` : "");
  el.addEventListener("click", (e) => {
    if (e.target.dataset.del) return;
    current = p.id; closeDrawer(); render();
  });
  const del = el.querySelector(".del");
  if (del) del.addEventListener("click", (e) => { e.stopPropagation(); apagarProjeto(del.dataset.del, del.dataset.name); });
  return el;
}
async function render() {
  await loadProjects();
  $("nav-devices").classList.toggle("active", current === DEVICES_VIEW);
  $("nav-library").classList.toggle("active", current === LIBRARY_VIEW);
  $("nav-notify").classList.toggle("active", current === NOTIFY_VIEW);
  $("nav-brand").classList.toggle("active", current === BRAND_VIEW);
  $("tr-import").classList.add("hidden");
  $("share-btn").classList.add("hidden");
  $("settings-btn").classList.add("hidden");
  if (current === DEVICES_VIEW) return renderDevices();
  if (current === NOTIFY_VIEW) return renderNotifySettings();
  if (current === BRAND_VIEW) return renderBranding();
  if (current === LIBRARY_VIEW) return renderLibrary();
  const proj = projects.find((p) => p.id === current);
  $("title").textContent = proj ? proj.name : t("title.allVideos");
  const url = current ? "/_api/assets?project=" + encodeURIComponent(current) : "/_api/assets";
  const assets = await (await api("GET", url)).json();
  $("count").textContent = t("count.videos", { n: assets.length });
  const imp = $("tr-import");
  imp.classList.toggle("hidden", !proj || !assets.length);
  $("share-btn").classList.toggle("hidden", !proj);
  $("settings-btn").classList.toggle("hidden", !proj);
  $("share-btn").classList.toggle("on", !!(proj && proj.shared));
  const content = $("content");
  if (!assets.length) {
    content.innerHTML = `<div class="empty"><div class="big">🎬</div>${escapeHtml(t("empty.videos.title"))}<br>${escapeHtml(t("empty.videos.hint"))}</div>`;
    return;
  }
  const byDate = {};
  assets.forEach((a) => { (byDate[a.date] = byDate[a.date] || []).push(a); });
  content.innerHTML = Object.keys(byDate).sort().reverse().map((date) =>
    `<div class="date-h">${fmtDate(date)}</div><div class="grid">${byDate[date].map(cardHtml).join("")}</div>`).join("");
  content.querySelectorAll("[data-delv]").forEach((b) =>
    b.addEventListener("click", () => excluirVideo(b.dataset.delv, b.dataset.name, b.dataset.lib === "1")));
  wireDownloads(content, assets, (a) => ({ video: `/_download/${a.id}`,
    transcript: projectFeatures(a.project_id).transcript ? `/_api/assets/${a.id}/transcript.doc` : null }));
  content.querySelectorAll("[data-play]").forEach((b) =>
    b.addEventListener("click", () => navigate("/v/" + encodeURIComponent(b.dataset.play))));
}
function cardHtml(a) {
  const lib = a.source === "library";
  return `<div class="card${lib ? " lib" : ""}">
    <button class="thumb" type="button" data-play="${a.id}" data-name="${escapeHtml(a.name)}">
      <video preload="metadata" muted playsinline src="/_media/${a.id}#t=0.5"></video>
      <span class="playbtn">▶</span>
      ${a.comment_count ? `<span class="cmt-badge">💬 ${a.comment_count}</span>` : ""}
      ${a.has_transcript && projectFeatures(a.project_id).transcript ? `<span class="tr-badge" title="${escapeHtml(t("tr.title"))}">📝</span>` : ""}
      ${a.chapter_count && projectFeatures(a.project_id).chapters ? `<span class="ch-badge" title="${escapeHtml(t("ch.title"))}">🔖 ${a.chapter_count}</span>` : ""}
    </button>
    <div class="meta">
      <div class="nm" title="${escapeHtml(lib ? "/" + (a.library_folder ? a.library_folder + "/" : "") + a.name : a.name)}">${escapeHtml(a.name)}</div>
      <div class="row"><span>${fmtSize(a.filesize)} · ${fmtTime(a.uploaded_at)}</span>
        <span class="acts">
          <button class="act" type="button" data-dl="${a.id}">${escapeHtml(t("card.download"))}${a.has_transcript && projectFeatures(a.project_id).transcript ? " ▾" : ""}</button>
          <button class="act danger" type="button" data-delv="${a.id}" data-lib="${lib ? 1 : 0}" data-name="${escapeHtml(a.name)}">${escapeHtml(lib ? t("card.remove") : t("card.delete"))}</button>
        </span></div>
    </div></div>`;
}

// Formata segundos como M:SS (ou H:MM:SS em videos longos) — rotulos compactos.
function fmtClock(s) {
  s = Math.max(0, Math.floor(Number(s) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return (h ? h + ":" : "") + mm + ":" + String(ss).padStart(2, "0");
}
// Timecode HH:MM:SS:FF (frame) estilo Frame.io. fps = quadros por segundo.
function fmtTC(s, fps) {
  s = Math.max(0, Number(s) || 0);
  const total = Math.floor(s);
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), ss = total % 60;
  let ff = Math.round((s - total) * fps); if (ff >= fps) ff = fps - 1;
  const p = (n) => String(n).padStart(2, "0");
  return `${p(h)}:${p(m)}:${p(ss)}:${p(ff)}`;
}
// Autor "device:Celular do Ciro" -> "Celular do Ciro".
const authorLabel = (a) => (a ? String(a).replace(/^device:/, "") : "—");

// Recursos do projeto (capitulos / transcricao) — padrao: ligados.
const projectFeatures = (id) => {
  const p = projects.find((x) => x.id === id);
  return { chapters: true, transcript: true, ...((p && p.settings) || {}) };
};

// =============================================================================
// ROTAS: "/" painel, "/v/<id>" pagina de revisao do admin,
// "/s/<token>" e "/s/<token>/v/<id>" link de compartilhamento (cliente).
// =============================================================================
let reviewHandle = null;
function navigate(path, replace) {
  if (location.pathname === path) return route();
  if (replace) history.replaceState({ app: true }, "", path); else history.pushState({ app: true }, "", path);
  route();
}
function closeReview() {
  if (reviewHandle) { reviewHandle.close(); reviewHandle = null; }
  $("review").classList.add("hidden");
}
async function route() {
  const path = location.pathname;
  let m;
  if ((m = /^\/s\/([^/]+)(?:\/v\/([^/]+))?\/?$/.exec(path))) return Share.route(decodeURIComponent(m[1]), m[2] && decodeURIComponent(m[2]));
  if ((m = /^\/v\/([^/]+)\/?$/.exec(path))) return openAdminReview(decodeURIComponent(m[1]));
  closeReview();
  $("app").classList.remove("hidden");
  render();
}
window.addEventListener("popstate", () => { if (!$("auth").classList.contains("hidden") && !isSharePath()) return; route(); });
const isSharePath = () => /^\/s\//.test(location.pathname);

// Pagina de revisao do admin: pagina inteira (nao e mais um popup).
async function openAdminReview(id) {
  closeReview();
  let a = null;
  try { a = (await (await api("GET", "/_api/assets")).json()).find((x) => x.id === id); } catch {}
  if (!projects.length) { try { projects = await (await api("GET", "/_api/projects")).json(); } catch {} }
  if (!a) { toast(t("rv.notFound"), "err"); return navigate("/", true); }
  if (a.project_id) current = a.project_id;           // Voltar cai no projeto do video
  $("app").classList.add("hidden");
  const box = $("review");
  box.classList.remove("hidden");
  document.title = a.name + " · " + Brand.name;
  const base = `/_api/assets/${encodeURIComponent(id)}`;
  reviewHandle = Review.open(box, {
    id, name: a.name, admin: true, call: api,
    urls: { media: `/_media/${id}`, download: `/_download/${id}`, comments: `${base}/comments`,
      chapters: `${base}/chapters`, transcript: `${base}/transcript`, transcriptDoc: `${base}/transcript.doc`, edl: `${base}/markers.edl` },
    features: projectFeatures(a.project_id),
    canComment: true,
    startAt: (() => { const v = parseFloat(new URLSearchParams(location.search).get("t")); return Number.isFinite(v) ? v : undefined; })(),
    focusComment: new URLSearchParams(location.search).get("c") || null,
    backLabel: a.project_name || t("title.allVideos"),
    onBack: () => { document.title = Brand.name; if (history.state && history.state.app) history.back(); else navigate("/"); },
  });
}

async function novoProjeto() {
  const name = await promptModal(t("proj.new.title"), t("proj.new.placeholder"));
  if (!name || !name.trim()) return;
  await api("POST", "/_api/projects", { name: name.trim() });
  toast(t("proj.created"), "ok");
  render();
}
async function apagarProjeto(id, name) {
  const ok = await confirmModal(t("proj.delete.confirm", { name }), t("proj.delete.btn"), true);
  if (!ok) return;
  const r = await api("DELETE", "/_api/projects/" + id);
  const data = await r.json().catch(() => ({}));
  if (!data.ok) { toast(data.error || t("proj.delete.fail"), "err"); return; }
  if (current === id) current = null;
  toast(t("proj.deleted"), "ok");
  render();
}
async function excluirVideo(id, name, lib) {
  const ok = lib
    ? await confirmModal(t("lib.removeVideo.confirm", { name }), t("card.remove"), true)
    : await confirmModal(t("video.delete.confirm", { name }), t("video.delete.btn"), true);
  if (!ok) return;
  const r = await api("DELETE", "/_api/assets/" + id);
  if (!r.ok) { toast(t("video.delete.fail"), "err"); return; }
  toast(lib ? t("lib.removeVideo.done") : t("video.deleted"), "ok");
  render();
}

// ---- Transcricoes: modais e importacao em lote -------------------------------
const TR_FPS = ["23.976", "24", "25", "29.97", "30", "48", "50", "59.94", "60"];
function lastFps() { try { return localStorage.getItem("fframe.trFps") || "24"; } catch { return "24"; } }
function fpsSelectHtml(sel) {
  return `<select id="tr-fps" class="fld">${TR_FPS.map((f) => `<option value="${f}"${f === String(sel) ? " selected" : ""}>${f} fps</option>`).join("")}</select>`;
}
// Frame rate do timecode do arquivo (HH:MM:SS:FF). Resolve: a do projeto/timeline.
function fpsModal() {
  return new Promise((resolve) => {
    const back = $("modal");
    back.innerHTML = `<div class="modal-card">
      <h3>${escapeHtml(t("tr.fps.title"))}</h3>
      <p class="modal-msg">${escapeHtml(t("tr.fps.msg"))}</p>
      ${fpsSelectHtml(lastFps())}
      <div class="modal-acts">
        <button class="btn-ghost" data-act="cancel" type="button">${escapeHtml(t("modal.cancel"))}</button>
        <button class="btn-primary" data-act="ok" type="button">${escapeHtml(t("modal.ok"))}</button>
      </div></div>`;
    back.classList.add("show");
    const close = (v) => { back.classList.remove("show"); setTimeout(() => (back.innerHTML = ""), 180); resolve(v); };
    back.querySelector('[data-act="cancel"]').addEventListener("click", () => close(null));
    back.querySelector('[data-act="ok"]').addEventListener("click", () => {
      const v = back.querySelector("#tr-fps").value;
      try { localStorage.setItem("fframe.trFps", v); } catch {}
      close(Number(v));
    });
    back.addEventListener("click", (e) => { if (e.target === back) close(null); });
  });
}
// Opcoes do EDL de marcadores: fps e timecode inicial da timeline no Resolve.
function edlModal() {
  return new Promise((resolve) => {
    const back = $("modal");
    let start = "01:00:00:00"; try { start = localStorage.getItem("fframe.edlStart") || start; } catch {}
    back.innerHTML = `<div class="modal-card">
      <h3>${escapeHtml(t("edl.title"))}</h3>
      <p class="modal-msg">${escapeHtml(t("edl.msg"))}</p>
      <label class="lib-lbl">${escapeHtml(t("tr.fps.label"))}</label>${fpsSelectHtml(lastFps())}
      <label class="lib-lbl">${escapeHtml(t("edl.start"))}</label>
      <input id="edl-start" class="fld" type="text" value="${escapeHtml(start)}" />
      <p class="dev-note">${escapeHtml(t("edl.hint"))}</p>
      <div class="modal-acts">
        <button class="btn-ghost" data-act="cancel" type="button">${escapeHtml(t("modal.cancel"))}</button>
        <button class="btn-primary" data-act="ok" type="button">${escapeHtml(t("edl.download"))}</button>
      </div></div>`;
    back.classList.add("show");
    const close = (v) => { back.classList.remove("show"); setTimeout(() => (back.innerHTML = ""), 180); resolve(v); };
    back.querySelector('[data-act="cancel"]').addEventListener("click", () => close(null));
    back.addEventListener("click", (e) => { if (e.target === back) close(null); });
    back.querySelector('[data-act="ok"]').addEventListener("click", () => {
      const s = back.querySelector("#edl-start").value.trim(), fps = back.querySelector("#tr-fps").value;
      if (!/^\d{1,2}:\d{2}:\d{2}[:;]\d{2}$/.test(s)) { toast(t("tr.offset.bad"), "err"); return; }
      try { localStorage.setItem("fframe.edlStart", s); localStorage.setItem("fframe.trFps", fps); } catch {}
      close({ fps, start: s });
    });
  });
}
// "HH:MM:SS:FF" <-> segundos de timecode (para o inicio/offset).
const tcToSec = (s, fps) => {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})(?:[:;.](\d{1,2}))?$/.exec(String(s).trim());
  return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (m[4] ? (+m[4]) / Math.round(fps || 24) : 0) : null;
};
// Menu ⋯ da transcricao: trocar arquivo, fps, inicio, remover.
function trMenuModal(tr) {
  return new Promise((resolve) => {
    const back = $("modal");
    const info = tr ? t("tr.info", { name: tr.source_name || "—", kind: (tr.kind || "").toUpperCase(), src: tr.source === "library" ? t("tr.fromLibrary") : t("tr.fromUpload") }) : "";
    back.innerHTML = `<div class="modal-card">
      <h3>${escapeHtml(t("tr.title"))}</h3>
      ${tr ? `<p class="modal-msg">${escapeHtml(info)}</p>
        ${!tr.realtime ? `<label class="lib-lbl">${escapeHtml(t("tr.fps.label"))}</label>${fpsSelectHtml(tr.fps)}` : ""}
        <label class="lib-lbl">${escapeHtml(t("tr.offset.label"))}</label>
        <input id="tr-off" class="fld" type="text" value="${escapeHtml(fmtTC(tr.offset || 0, Math.round(tr.fps || 24)))}" />
        <p class="dev-note">${escapeHtml(t("tr.offset.hint"))}</p>` : `<p class="modal-msg">${escapeHtml(t("tr.empty"))}</p>`}
      <div class="modal-acts tr-menu-acts">
        ${tr ? `<button class="btn-ghost danger-txt" data-act="remove" type="button">${escapeHtml(t("tr.remove"))}</button>` : ""}
        <button class="btn-ghost" data-act="upload" type="button">${escapeHtml(tr ? t("tr.replace") : t("tr.upload"))}</button>
        ${tr ? `<button class="btn-primary" data-act="save" type="button">${escapeHtml(t("tr.save"))}</button>` : ""}
      </div></div>`;
    back.classList.add("show");
    const close = (v) => { back.classList.remove("show"); setTimeout(() => (back.innerHTML = ""), 180); resolve(v); };
    back.addEventListener("click", (e) => { if (e.target === back) close(null); });
    back.querySelector('[data-act="upload"]').addEventListener("click", () => close("upload"));
    const rm = back.querySelector('[data-act="remove"]'); if (rm) rm.addEventListener("click", () => close("remove"));
    const sv = back.querySelector('[data-act="save"]');
    if (sv) sv.addEventListener("click", () => {
      const fpsEl = back.querySelector("#tr-fps");
      const fps = fpsEl ? Number(fpsEl.value) : tr.fps;
      const off = tcToSec(back.querySelector("#tr-off").value, fps);
      if (off == null) { toast(t("tr.offset.bad"), "err"); return; }
      close({ fps: fpsEl ? fps : undefined, offset: off });
    });
  });
}
// Varios arquivos de uma vez no projeto: casa pelo nome do video.
async function importarTranscricoes(files) {
  files = Array.from(files || []);
  if (!files.length || !current) return;
  let fps = null;
  if (files.some((f) => /\.(txt|json)$/i.test(f.name))) { fps = await fpsModal(); if (fps == null) return; }
  const payload = [];
  for (const f of files) {
    if (f.size > 30 * 1024 * 1024) continue;
    payload.push({ filename: f.name, content: await f.text() });
  }
  toast(t("tr.importing"));
  const r = await api("POST", `/_api/projects/${current}/transcripts`, { fps, files: payload });
  const d = await r.json().catch(() => null);
  if (!r.ok || !d) { toast(t("tr.uploadFail"), "err"); return; }
  const ok = d.results.filter((x) => x.ok), bad = d.results.filter((x) => !x.ok);
  const nTr = ok.filter((x) => x.transcript).length, nMk = ok.reduce((n, x) => n + (x.markers || 0), 0);
  const okMsg = t("tr.imported", { n: nTr }) + (nMk ? " " + t("tr.markersImported", { n: nMk }) : "");
  if (!bad.length) toast(okMsg, "ok");
  else await dialog({
    title: t("tr.importDone"),
    message: okMsg + "\n" + t("tr.importSummary", { ok: ok.length, bad: bad.length }) + "\n\n" +
      bad.map((x) => `• ${x.filename}: ${x.error === "no video with that name" ? t("tr.noMatch") : x.error}`).join("\n"),
    okText: t("modal.ok"),
  });
  render();
}

// ---- Biblioteca: vincular pastas que ja existem no NAS (share SMB) ----------
// Os videos ficam onde estao; o Fframe so indexa e faz streaming deles.
async function renderLibrary() {
  $("title").textContent = t("title.library");
  const content = $("content");
  const [linksR, dirR] = await Promise.all([
    api("GET", "/_api/library/links"),
    api("GET", "/_api/library/browse?path=" + encodeURIComponent(libraryPath)),
  ]);
  const links = linksR.ok ? await linksR.json() : [];
  let dir = dirR.ok ? await dirR.json() : null;
  if (!dir && libraryPath) { libraryPath = ""; return renderLibrary(); } // pasta sumiu: volta a raiz
  $("count").textContent = t("count.folders", { n: links.length });
  const projName = (id) => (projects.find((p) => p.id === id) || {}).name || "—";

  const linkRows = links.slice().sort((a, b) => a.path.localeCompare(b.path)).map((l) => {
    const sub = [
      t("lib.videos", { n: l.count || 0 }),
      l.recursive ? t("lib.withSub") : t("lib.noSub"),
      l.last_scan ? t("lib.scanned", { date: fmtDay(l.last_scan) + " " + fmtTime(l.last_scan) }) : "",
      l.hidden_count ? t("lib.hiddenCount", { n: l.hidden_count }) : "",
    ].filter(Boolean).join(" · ");
    return `<div class="dev-row">
      <div class="dev-info">
        <div class="dev-nm" title="/${escapeHtml(l.path)}">📁 /${escapeHtml(l.path)}</div>
        <div class="dev-sub">${escapeHtml(sub)}</div>
        ${l.error ? `<div class="dev-sub err">${escapeHtml(t("lib.error", { err: l.error }))}</div>` : ""}
        ${l.truncated ? `<div class="dev-sub err">${escapeHtml(t("lib.truncated"))}</div>` : ""}
      </div>
      <span class="badge on" title="${escapeHtml(t("lib.project"))}">${escapeHtml(projName(l.project_id))}</span>
      <span class="acts">
        <button class="act" type="button" data-rescan="${l.id}">${escapeHtml(t("lib.act.rescan"))}</button>
        <button class="act danger" type="button" data-unlink="${l.id}" data-name="${escapeHtml(l.path)}">${escapeHtml(t("lib.act.unlink"))}</button>
      </span>
    </div>`;
  }).join("");

  let browser;
  if (!dir) {
    browser = `<div class="empty">${escapeHtml(t("lib.unavailable"))}</div>`;
  } else {
    const parts = dir.path ? dir.path.split("/") : [];
    const crumbs = [`<button class="crumb" type="button" data-go="">${escapeHtml(t("lib.root"))}</button>`]
      .concat(parts.map((p, i) => `<button class="crumb" type="button" data-go="${escapeHtml(parts.slice(0, i + 1).join("/"))}">${escapeHtml(p)}</button>`))
      .join(`<span class="crumb-sep">/</span>`);
    const rows = dir.dirs.map((d) => `<div class="lib-row">
        <button class="lib-open" type="button" data-go="${escapeHtml(d.path)}">📁 <span>${escapeHtml(d.name)}</span></button>
        ${d.links.length ? `<span class="badge on">${escapeHtml(t("lib.linked"))}</span>` : ""}
        <button class="act" type="button" data-add="${escapeHtml(d.path)}" data-name="${escapeHtml(d.name)}">${escapeHtml(t("lib.act.add"))}</button>
      </div>`).join("");
    browser = `<div class="lib-browser">
      <div class="lib-bar">
        <div class="crumbs">${crumbs}</div>
        <button class="btn-primary" type="button" data-add="${escapeHtml(dir.path)}" data-name="${escapeHtml(dir.name || t("lib.root"))}">${escapeHtml(t("lib.addThis"))}</button>
      </div>
      <div class="lib-here">${escapeHtml(dir.error ? t("lib.error", { err: dir.error }) : t("lib.here", { n: dir.videos }))}</div>
      ${rows ? `<div class="lib-rows">${rows}</div>` : `<div class="lib-here">${escapeHtml(t("lib.noSubfolders"))}</div>`}
    </div>`;
  }

  content.innerHTML =
    `<div class="dev-head"><div class="dev-hint-wrap"><p class="dev-hint">${escapeHtml(t("lib.hint"))}</p></div></div>
    <div class="side-h lib-h">${escapeHtml(t("lib.linkedTitle"))}</div>
    ${links.length ? `<div class="dev-list">${linkRows}</div>` : `<p class="dev-hint">${escapeHtml(t("lib.noLinks"))}</p>`}
    <div class="side-h lib-h">${escapeHtml(t("lib.browseTitle"))}</div>
    ${browser}`;

  content.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => { libraryPath = b.dataset.go; renderLibrary(); }));
  content.querySelectorAll("[data-add]").forEach((b) => b.addEventListener("click", () => vincularPasta(b.dataset.add, b.dataset.name)));
  content.querySelectorAll("[data-rescan]").forEach((b) => b.addEventListener("click", async () => {
    b.disabled = true; b.textContent = t("lib.scanning");
    const r = await api("POST", `/_api/library/links/${b.dataset.rescan}/rescan`);
    const l = await r.json().catch(() => null);
    if (r.ok && l) toast(t("lib.rescanned", { n: l.count || 0 }), "ok"); else toast(t("lib.fail"), "err");
    render();
  }));
  content.querySelectorAll("[data-unlink]").forEach((b) => b.addEventListener("click", async () => {
    const ok = await confirmModal(t("lib.unlink.confirm", { name: "/" + b.dataset.name }), t("lib.act.unlink"), true);
    if (!ok) return;
    const r = await api("DELETE", `/_api/library/links/${b.dataset.unlink}`);
    toast(r.ok ? t("lib.unlinked") : t("lib.fail"), r.ok ? "ok" : "err");
    render();
  }));
}

// Modal: escolher o projeto (ou criar um com o nome da pasta) + subpastas.
function linkModal(folderName) {
  return new Promise((resolve) => {
    const back = $("modal");
    const opts = projects.map((p) => `<option value="${p.id}"${p.id === current ? " selected" : ""}>${escapeHtml(p.name)}</option>`).join("");
    back.innerHTML =
      `<div class="modal-card">
        <h3>${escapeHtml(t("lib.add.title"))}</h3>
        <p class="modal-msg">📁 ${escapeHtml(folderName)}</p>
        <label class="lib-lbl">${escapeHtml(t("lib.project"))}</label>
        <select id="lib-proj" class="fld">
          <option value="__new__">${escapeHtml(t("lib.add.newProject", { name: folderName }))}</option>
          ${opts}
        </select>
        <label class="check"><input id="lib-rec" type="checkbox" checked /> <span>${escapeHtml(t("lib.add.recursive"))}</span></label>
        <p class="dev-note">${escapeHtml(t("lib.add.note"))}</p>
        <div class="modal-acts">
          <button class="btn-ghost" data-act="cancel" type="button">${escapeHtml(t("modal.cancel"))}</button>
          <button class="btn-primary" data-act="ok" type="button">${escapeHtml(t("lib.act.add"))}</button>
        </div>
      </div>`;
    back.classList.add("show");
    const close = (val) => { back.classList.remove("show"); setTimeout(() => (back.innerHTML = ""), 180); resolve(val); };
    back.querySelector('[data-act="cancel"]').addEventListener("click", () => close(null));
    back.querySelector('[data-act="ok"]').addEventListener("click", () =>
      close({ project: back.querySelector("#lib-proj").value, recursive: back.querySelector("#lib-rec").checked }));
    back.addEventListener("click", (e) => { if (e.target === back) close(null); });
  });
}
async function vincularPasta(path, name) {
  const choice = await linkModal(name);
  if (!choice) return;
  let projectId = choice.project;
  if (projectId === "__new__") {
    const r = await api("POST", "/_api/projects", { name });
    const p = await r.json().catch(() => null);
    if (!r.ok || !p || !p.id) { toast(t("lib.fail"), "err"); return; }
    projectId = p.id;
  }
  toast(t("lib.scanning"));
  const r = await api("POST", "/_api/library/links", { path, project_id: projectId, recursive: choice.recursive });
  const l = await r.json().catch(() => null);
  if (!r.ok || !l || !l.id) { toast((l && l.error) || t("lib.fail"), "err"); render(); return; }
  toast(t("lib.added", { n: l.count || 0 }), "ok");
  render();
}

// ---- Dispositivos (chaves do app Fframe Uploader) ---------------------------
async function renderDevices() {
  $("title").textContent = t("title.devices");
  const devices = await (await api("GET", "/_api/devices")).json();
  const active = devices.filter((d) => !d.revoked_at);
  $("count").textContent = t("count.devices", { n: active.length });
  const content = $("content");
  const rows = devices.slice()
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .map(devRowHtml).join("");
  const note = t("dev.appLangNote");
  content.innerHTML =
    `<div class="dev-head">
      <div class="dev-hint-wrap">
        <p class="dev-hint">${escapeHtml(t("dev.hint"))}</p>
        ${note ? `<p class="dev-note">${escapeHtml(note)}</p>` : ""}
      </div>
      <button id="add-device" class="btn-primary" type="button">${escapeHtml(t("dev.add"))}</button>
    </div>` +
    (devices.length ? `<div class="dev-list">${rows}</div>`
      : `<div class="empty"><div class="big">📱</div>${escapeHtml(t("empty.devices.title"))}<br>${escapeHtml(t("empty.devices.hint"))}</div>`);
  $("add-device").addEventListener("click", novoDispositivo);
  content.querySelectorAll("[data-revoke]").forEach((b) =>
    b.addEventListener("click", () => revogarDispositivo(b.dataset.revoke, b.dataset.name)));
  content.querySelectorAll("[data-showkey]").forEach((b) =>
    b.addEventListener("click", () => {
      const d = devices.find((x) => x.id === b.dataset.showkey);
      if (d) keyModal(d);
    }));
}
function devRowHtml(d) {
  const revoked = !!d.revoked_at;
  const sub = t("dev.createdAt", { date: fmtDay(d.created_at) })
    + (revoked ? t("dev.revokedAt", { date: fmtDay(d.revoked_at) }) : "");
  return `<div class="dev-row${revoked ? " revoked" : ""}">
    <div class="dev-info">
      <div class="dev-nm">${escapeHtml(d.name)}</div>
      <div class="dev-sub">${escapeHtml(sub)}</div>
    </div>
    <span class="badge ${revoked ? "off" : "on"}">${escapeHtml(revoked ? t("dev.badge.revoked") : t("dev.badge.active"))}</span>
    <span class="acts">${revoked ? "" :
      `<button class="act" type="button" data-showkey="${d.id}">${escapeHtml(t("dev.act.key"))}</button>
      <button class="act danger" type="button" data-revoke="${d.id}" data-name="${escapeHtml(d.name)}">${escapeHtml(t("dev.act.revoke"))}</button>`}
    </span>
  </div>`;
}
async function novoDispositivo() {
  const name = await promptModal(t("dev.new.title"), t("dev.new.placeholder"));
  if (!name || !name.trim()) return;
  const r = await api("POST", "/_api/devices", { name: name.trim() });
  const d = await r.json().catch(() => null);
  if (!r.ok || !d || !d.key) { toast((d && d.error) || t("dev.create.fail"), "err"); return; }
  toast(t("dev.created"), "ok");
  await renderDevices();
  keyModal(d);
}
async function revogarDispositivo(id, name) {
  const ok = await confirmModal(t("dev.revoke.confirm", { name }), t("dev.revoke.btn"), true);
  if (!ok) return;
  const r = await api("DELETE", "/_api/devices/" + id);
  const data = await r.json().catch(() => ({}));
  if (!data.ok) { toast(data.error || t("dev.revoke.fail"), "err"); return; }
  toast(t("dev.revoked"), "ok");
  renderDevices();
}
// Modal com QR code + chave em texto (pra configurar o app Fframe Uploader).
function keyModal(d) {
  const back = $("modal");
  back.innerHTML =
    `<div class="modal-card">
      <h3>${escapeHtml(d.name)}</h3>
      <p class="modal-msg">${escapeHtml(t("dev.key.hint"))}</p>
      <div class="qr-wrap"><div id="qr-box"></div></div>
      <code class="key-text" id="key-text">${escapeHtml(d.key)}</code>
      <div class="modal-acts">
        <button class="btn-ghost" data-act="copy" type="button">${escapeHtml(t("dev.key.copy"))}</button>
        <button class="btn-primary" data-act="ok" type="button">${escapeHtml(t("dev.key.close"))}</button>
      </div>
    </div>`;
  back.classList.add("show");
  try {
    new QRCode(back.querySelector("#qr-box"), {
      text: JSON.stringify({ url: window.location.origin, key: d.key }),
      width: 200, height: 200,
      colorDark: "#000000", colorLight: "#ffffff",
      correctLevel: QRCode.CorrectLevel.M,
    });
  } catch (e) { /* sem QR, a chave em texto resolve */ }
  const close = () => { back.classList.remove("show"); setTimeout(() => (back.innerHTML = ""), 180); };
  back.querySelector('[data-act="ok"]').addEventListener("click", close);
  back.addEventListener("click", (e) => { if (e.target === back) close(); });
  back.querySelector('[data-act="copy"]').addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(d.key); toast(t("dev.key.copied"), "ok"); }
    catch {
      const rng = document.createRange(); rng.selectNodeContents(back.querySelector("#key-text"));
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(rng);
      const ok = document.execCommand && document.execCommand("copy");
      toast(ok ? t("dev.key.copied") : t("dev.key.copyFail"), ok ? "ok" : "err");
    }
  });
}

// =============================================================================
// COMPARTILHAR (admin): link sem login por projeto + opcoes do link.
// =============================================================================
// Configuracoes do projeto (admin): recursos que o projeto usa.
function settingsModal() {
  const proj = projects.find((p) => p.id === current);
  if (!proj) return;
  const back = $("modal");
  const st = projectFeatures(proj.id);
  const opt = (k, label, hint) => `<label class="check share-opt"><input type="checkbox" data-k="${k}"${st[k] ? " checked" : ""} />
      <span><b>${escapeHtml(label)}</b><small>${escapeHtml(hint)}</small></span></label>`;
  back.innerHTML = `<div class="modal-card share-card">
    <h3>${escapeHtml(t("set.title", { name: proj.name }))}</h3>
    <p class="modal-msg">${escapeHtml(t("set.msg"))}</p>
    ${opt("chapters", t("set.chapters"), t("set.chaptersHint"))}
    ${opt("transcript", t("set.transcript"), t("set.transcriptHint"))}
    <div class="modal-acts"><button class="btn-primary" type="button" data-act="ok">${escapeHtml(t("share.done"))}</button></div></div>`;
  back.classList.add("show");
  back.querySelectorAll("[data-k]").forEach((c) => c.addEventListener("change", async () => {
    const r = await api("PATCH", `/_api/projects/${proj.id}/settings`, { [c.dataset.k]: c.checked });
    const d = await r.json().catch(() => null);
    if (!r.ok || !d) { toast(t("share.fail"), "err"); c.checked = !c.checked; return; }
    proj.settings = d;
  }));
  const close = () => { back.classList.remove("show"); setTimeout(() => (back.innerHTML = ""), 180); render(); };
  back.querySelector('[data-act="ok"]').addEventListener("click", close);
  back.onclick = (e) => { if (e.target === back) close(); };
}

async function shareModal() {
  const proj = projects.find((p) => p.id === current);
  if (!proj) return;
  const r = await api("GET", `/_api/projects/${proj.id}/share`);
  let sh = await r.json().catch(() => null);
  if (!r.ok || !sh) { toast(t("share.fail"), "err"); return; }
  const back = $("modal");
  const link = () => `${location.origin}/s/${sh.token}`;
  const opt = (k, label, hint) => `<label class="check share-opt"><input type="checkbox" data-k="${k}"${sh[k] ? " checked" : ""} />
      <span><b>${escapeHtml(label)}</b>${hint ? `<small>${escapeHtml(hint)}</small>` : ""}</span></label>`;
  const paint = () => {
    back.innerHTML = `<div class="modal-card share-card">
      <h3>${escapeHtml(t("share.title", { name: proj.name }))}</h3>
      <label class="switch-row"><input type="checkbox" id="sh-on"${sh.enabled ? " checked" : ""} />
        <span><b>${escapeHtml(t("share.enable"))}</b><small>${escapeHtml(sh.enabled ? t("share.enabledHint") : t("share.disabledHint"))}</small></span></label>
      <div class="share-link${sh.enabled ? "" : " off"}">
        <input class="fld" id="sh-link" type="text" readonly value="${escapeHtml(link())}" />
        <button class="btn-primary" type="button" id="sh-copy"${sh.enabled ? "" : " disabled"}>${escapeHtml(t("share.copy"))}</button>
      </div>
      <div class="side-h share-h">${escapeHtml(t("share.settings"))}</div>
      ${opt("allow_comments", t("share.opt.comments"), t("share.opt.commentsHint"))}
      ${opt("allow_download_video", t("share.opt.dlVideo"), t("share.opt.dlVideoHint"))}
      ${opt("allow_download_transcript", t("share.opt.dlTranscript"), projectFeatures(proj.id).transcript ? t("share.opt.dlTranscriptHint") : t("share.opt.dlTranscriptOff"))}
      <div class="modal-acts">
        <button class="btn-ghost danger-txt" type="button" id="sh-regen">${escapeHtml(t("share.regen"))}</button>
        <button class="btn-primary" type="button" data-act="ok">${escapeHtml(t("share.done"))}</button>
      </div></div>`;
    const save = async (patch) => {
      const rr = await api("PATCH", `/_api/projects/${proj.id}/share`, patch);
      const d = await rr.json().catch(() => null);
      if (!rr.ok || !d) { toast(t("share.fail"), "err"); return; }
      sh = d; paint();
    };
    back.querySelector("#sh-on").addEventListener("change", (e) => save({ enabled: e.target.checked }));
    back.querySelectorAll("[data-k]").forEach((c) => c.addEventListener("change", () => save({ [c.dataset.k]: c.checked })));
    back.querySelector("#sh-copy").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(link()); toast(t("share.copied"), "ok"); }
      catch { const i = back.querySelector("#sh-link"); i.select(); toast(document.execCommand && document.execCommand("copy") ? t("share.copied") : t("dev.key.copyFail")); }
    });
    back.querySelector("#sh-link").addEventListener("focus", (e) => e.target.select());
    back.querySelector("#sh-regen").addEventListener("click", async () => {
      back.classList.remove("show");
      const ok = await confirmModal(t("share.regen.confirm"), t("share.regen"), true);
      if (ok) await save({ regenerate: true }); else paint();
      back.classList.add("show");
      if (ok) toast(t("share.regenerated"), "ok");
    });
    back.querySelector('[data-act="ok"]').addEventListener("click", close);
  };
  const close = () => { back.classList.remove("show"); setTimeout(() => (back.innerHTML = ""), 180); render(); };
  paint();
  back.classList.add("show");
  back.onclick = (e) => { if (e.target === back) close(); };
}

// =============================================================================
// CLIENTE (link /s/<token>): galeria do projeto + pagina de revisao, sem login.
// =============================================================================
const Share = {
  token: null, info: null, assets: null,
  guestId() {
    let g = null;
    try { g = localStorage.getItem("fframe.guestId"); } catch {}
    if (!g || !/^[a-f0-9]{32}$/.test(g)) {
      g = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
      try { localStorage.setItem("fframe.guestId", g); } catch {}
    }
    return g;
  },
  guestName() { try { return (localStorage.getItem("fframe.guestName") || "").trim(); } catch { return ""; } },
  call(method, url, body) {
    const opt = { method, headers: { "X-Guest-Id": Share.guestId(), "X-Guest-Name": encodeURIComponent(Share.guestName()) } };
    if (body !== undefined) { opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(body); }
    return fetch(url, opt);
  },
  // Pede o nome (obrigatorio) — e assim que o admin sabe quem comentou.
  askName(force) {
    return new Promise((resolve) => {
      const cur = Share.guestName();
      if (cur && !force) return resolve(cur);
      const back = $("modal");
      back.innerHTML = `<form class="modal-card" id="nm-form" autocomplete="on">
        <div class="auth-brand">${brandMark("", true)}</div>
        <h3>${escapeHtml(t("share.name.title"))}</h3>
        <p class="modal-msg">${escapeHtml(t("share.name.msg", { project: (Share.info && Share.info.project) || "" }))}</p>
        <input id="nm-input" class="fld" type="text" name="name" autocomplete="name" maxlength="60" placeholder="${escapeHtml(t("share.name.ph"))}" value="${escapeHtml(cur)}" />
        <div class="modal-acts">
          ${cur ? `<button class="btn-ghost" type="button" data-act="cancel">${escapeHtml(t("modal.cancel"))}</button>` : ""}
          <button class="btn-primary" type="submit">${escapeHtml(t("share.name.ok"))}</button>
        </div></form>`;
      back.classList.add("show");
      back.onclick = null;
      const inp = back.querySelector("#nm-input");
      setTimeout(() => inp.focus(), 60);
      const done = (v) => { back.classList.remove("show"); setTimeout(() => (back.innerHTML = ""), 180); resolve(v); };
      back.querySelector("#nm-form").addEventListener("submit", (e) => {
        e.preventDefault();
        const v = inp.value.replace(/\s+/g, " ").trim().slice(0, 60);
        if (!v) { inp.focus(); return; }
        try { localStorage.setItem("fframe.guestName", v); } catch {}
        done(v);
      });
      const c = back.querySelector('[data-act="cancel"]');
      if (c) c.addEventListener("click", () => done(cur));
    });
  },
  async route(token, assetId) {
    closeReview();
    $("auth").classList.add("hidden");
    $("app").classList.add("hidden");
    const box = $("share");
    if (Share.token !== token || !Share.info) {
      Share.token = token; Share.info = null; Share.assets = null; Share.visited = false;
      const r = await fetch(`/_s/${encodeURIComponent(token)}/info`).catch(() => null);
      if (!r || !r.ok) {
        box.classList.remove("hidden");
        box.innerHTML = `<div class="share-dead"><div class="auth-brand">${brandMark("", true)}</div>
          <h2>${escapeHtml(t("share.dead.title"))}</h2><p>${escapeHtml(t("share.dead.msg"))}</p></div>`;
        return;
      }
      Share.info = await r.json();
    }
    if (!Share.guestName()) await Share.askName();
    if (!Share.visited) { Share.visited = true; Share.call("POST", `/_s/${encodeURIComponent(token)}/visit`).catch(() => {}); }
    if (!Share.assets) {
      const r = await Share.call("GET", `/_s/${encodeURIComponent(token)}/assets`);
      Share.assets = r.ok ? await r.json() : [];
    }
    if (assetId) return Share.openVideo(assetId);
    Share.gallery();
  },
  dlUrls(a) {
    const tk = encodeURIComponent(Share.token), who = "?n=" + encodeURIComponent(Share.guestName());
    return { video: Share.info.allow_download_video ? `/_s/${tk}/download/${a.id}${who}` : null,
      transcript: Share.info.allow_download_transcript ? `/_s/${tk}/transcript/${a.id}${who}` : null };
  },
  header() {
    return `<header class="share-top">
      <div class="brand">${brandMark(t("share.review"))}</div>
      <div class="share-proj">${escapeHtml(Share.info.project)}</div>
      <div class="share-me">${escapeHtml(t("share.as", { name: Share.guestName() }))} · <button class="linkbtn" type="button" id="sh-rename">${escapeHtml(t("share.change"))}</button></div>
    </header>`;
  },
  wireHeader(box) {
    const rn = box.querySelector("#sh-rename");
    if (rn) rn.addEventListener("click", async () => { await Share.askName(true); route(); });
  },
  gallery() {
    document.title = Share.info.project + " · " + Brand.name;
    const box = $("share");
    box.classList.remove("hidden");
    const tk = encodeURIComponent(Share.token);
    const list = Share.assets || [];
    const cards = list.map((a) => `<div class="card">
        <button class="thumb" type="button" data-open="${a.id}">
          <video preload="metadata" muted playsinline src="/_s/${tk}/media/${a.id}#t=0.5"></video>
          <span class="playbtn">▶</span>
          ${a.comment_count ? `<span class="cmt-badge">💬 ${a.comment_count}</span>` : ""}
          ${a.chapter_count ? `<span class="ch-badge">🔖 ${a.chapter_count}</span>` : ""}
        </button>
        <div class="meta">
          <div class="nm" title="${escapeHtml(a.name)}">${escapeHtml(a.name)}</div>
          <div class="row"><span>${fmtSize(a.filesize)} · ${fmtDay(a.uploaded_at)}</span>
            ${Share.dlUrls(a).video || (Share.dlUrls(a).transcript && a.has_transcript) ? `<span class="acts"><button class="act" type="button" data-dl="${a.id}">${escapeHtml(t("card.download"))}${Share.dlUrls(a).video && Share.dlUrls(a).transcript && a.has_transcript ? " ▾" : ""}</button></span>` : ""}
          </div>
        </div></div>`).join("");
    box.innerHTML = Share.header() + `<main class="share-main">
        <div class="top"><h1>${escapeHtml(Share.info.project)}</h1><span class="sub">${escapeHtml(t("count.videos", { n: list.length }))}</span></div>
        ${list.length ? `<div class="grid">${cards}</div>` : `<div class="empty"><div class="big">🎬</div>${escapeHtml(t("share.empty"))}</div>`}
      </main>`;
    Share.wireHeader(box);
    wireDownloads(box, list, (a) => Share.dlUrls(a));
    box.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () =>
      navigate(`/s/${tk}/v/${encodeURIComponent(b.dataset.open)}`)));
  },
  openVideo(assetId) {
    const a = (Share.assets || []).find((x) => x.id === assetId);
    const tk = encodeURIComponent(Share.token);
    if (!a) return navigate(`/s/${tk}`, true);
    $("share").classList.add("hidden");
    const box = $("review");
    box.classList.remove("hidden");
    document.title = a.name + " · " + Share.info.project;
    const base = `/_s/${tk}/assets/${encodeURIComponent(assetId)}`;
    Share.call("POST", `${base}/view`).catch(() => {});
    reviewHandle = Review.open(box, {
      id: assetId, name: a.name, admin: false, call: Share.call,
      urls: { media: `/_s/${tk}/media/${assetId}`, download: Share.dlUrls(a).video, transcriptDoc: Share.dlUrls(a).transcript,
        comments: `${base}/comments`, chapters: `${base}/chapters`, transcript: `${base}/transcript`, edl: null },
      features: { chapters: !!Share.info.chapters, transcript: !!Share.info.transcript },
      canComment: !!Share.info.allow_comments,
      guest: { name: Share.guestName() },
      backLabel: Share.info.project,
      onBack: () => { Share.assets = null; if (history.state && history.state.app) history.back(); else navigate(`/s/${tk}`); },
      onGuestRename: async () => { await Share.askName(true); route(); },
    });
  },
};

// =============================================================================
// NOTIFICACOES (admin): sino com o que os clientes fizeram, alerta do navegador
// e a tela de configuracao (no app / e-mail por tipo de evento).
// =============================================================================
const NOTIF_ICON = { comment: "💬", reply: "↩", download: "⤓", view: "▶", visit: "👋" };
const relTime = (iso) => {
  const s = Math.max(0, (Date.now() - new Date(iso)) / 1000);
  if (s < 60) return t("nt.now");
  if (s < 3600) return t("nt.min", { n: Math.floor(s / 60) });
  if (s < 86400) return t("nt.hour", { n: Math.floor(s / 3600) });
  if (s < 7 * 86400) return t("nt.day", { n: Math.floor(s / 86400) });
  return fmtDay(iso);
};
function notifLine(n) {
  const at = n.t != null ? ` ${t("nt.at", { time: fmtClock(n.t) })}` : "";
  switch (n.type) {
    case "comment": return t("nt.comment", { video: n.asset_name }) + at;
    case "reply": return t("nt.reply", { video: n.asset_name }) + at;
    case "download": return t(n.kind === "transcript" ? "nt.downloadTr" : "nt.download", { video: n.asset_name });
    case "view": return t("nt.view", { video: n.asset_name });
    case "visit": return t("nt.visit", { project: n.project_name });
    default: return "";
  }
}
// Web Push: chave publica VAPID (base64url) -> bytes, como o pushManager quer.
const b64uBytes = (s) => {
  const b = atob((s + "===".slice((s.length + 3) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};
const sameBytes = (a, b) => { if (!a || !b) return false; a = new Uint8Array(a); return a.length === b.length && a.every((x, i) => x === b[i]); };
async function swReady() {
  await navigator.serviceWorker.register("/sw.js");
  return Promise.race([navigator.serviceWorker.ready,
    new Promise((_, no) => setTimeout(() => no(new Error("service worker not ready")), 10000))]);
}

const Notifs = {
  items: [], unread: 0, seen: new Set(), primed: false, timer: null,
  push: false,   // este navegador esta inscrito no Web Push (o service worker mostra as notificacoes)
  browserOn() { try { return localStorage.getItem("fframe.browserNotify") === "1"; } catch { return false; } },
  setBrowser(on) { try { localStorage.setItem("fframe.browserNotify", on ? "1" : "0"); } catch {} },
  pushSupported() { return window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window; },
  async pushSub() {
    if (!this.pushSupported()) return null;
    try { return await (await swReady()).pushManager.getSubscription(); } catch { return null; }
  },
  /** Inscreve este navegador (ou reenvia a inscricao atual, para o servidor nao perde-la). */
  async pushEnable(test) {
    const reg = await swReady();
    const kr = await api("GET", "/_api/push/key");
    const { publicKey } = await kr.json().catch(() => ({}));
    if (!kr.ok || !publicKey) throw new Error("the server has no push key");
    const key = b64uBytes(publicKey);
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameBytes(sub.options.applicationServerKey, key)) { await sub.unsubscribe().catch(() => {}); sub = null; }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    const r = await api("POST", "/_api/push/subscription", { subscription: sub.toJSON(), test: !!test });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "the server refused the subscription");
    this.push = true;
  },
  async pushDisable() {
    const sub = await this.pushSub();
    this.push = false;
    if (!sub) return;
    await api("DELETE", "/_api/push/subscription", { endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe().catch(() => {});
  },
  start() {
    if (this.timer) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), 20000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) this.poll(); });
    if (this.browserOn() && this.pushSupported() && "Notification" in window && Notification.permission === "granted")
      this.pushEnable(false).catch(() => { this.push = false; });
    if ("serviceWorker" in navigator) navigator.serviceWorker.addEventListener("message", (e) => {
      const d = e.data || {};
      if (d.type === "fframe-push") this.poll();
      else if (d.type === "fframe-open" && typeof d.url === "string" && d.url.startsWith("/")) { closeNotifPop(); navigate(d.url); this.poll(); }
    });
  },
  async poll() {
    let d;
    try { const r = await fetch("/_api/notifications?limit=40"); if (!r.ok) return; d = await r.json(); } catch { return; }
    const fresh = d.items.filter((n) => !this.seen.has(n.id));
    d.items.forEach((n) => this.seen.add(n.id));
    this.items = d.items; this.unread = d.unread;
    this.paintBadge();
    if ($("notif-pop")) this.paintList();
    // so avisa do que chegou DEPOIS de abrir o painel (nao do historico)
    if (this.primed) fresh.filter((n) => !n.read).reverse().forEach((n) => this.alert(n));
    this.primed = true;
  },
  paintBadge() {
    const b = $("bell-n");
    b.hidden = !this.unread;
    b.textContent = this.unread > 99 ? "99+" : String(this.unread);
    $("bell").title = this.unread ? t("nt.unread", { n: this.unread }) : t("nt.title");
    document.title = document.title.replace(/^\(\d+\+?\) /, "");
    if (this.unread) document.title = `(${this.unread}) ` + document.title;
  },
  alert(n) {
    const title = `${n.actor} · ${n.project_name}`;
    const body = notifLine(n) + (n.text ? `\n“${n.text}”` : "");
    const away = document.hidden || !document.hasFocus();
    // Com Web Push quem mostra e o service worker (nao duplica aqui).
    if (this.push && away) return;
    if (this.browserOn() && away && "Notification" in window && Notification.permission === "granted") {
      try {
        const bn = new Notification(title, { body, icon: Brand.icon, tag: n.id });
        bn.onclick = () => { window.focus(); this.open(n); bn.close(); };
      } catch {}
    } else if (!away) toast(`${NOTIF_ICON[n.type] || "🔔"} ${n.actor} ${notifLine(n).replace(/^\S/, (c) => c.toLowerCase())}`);
  },
  async open(n) {
    closeNotifPop();
    if (!n.read) { n.read = true; this.unread = Math.max(0, this.unread - 1); this.paintBadge(); fetch("/_api/notifications/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: [n.id] }) }).catch(() => {}); }
    if (n.asset_id && n.type !== "visit") {
      const q = [];
      if (n.t != null) q.push("t=" + n.t.toFixed(2));
      if (n.comment_id) q.push("c=" + encodeURIComponent(n.comment_id));
      navigate(`/v/${encodeURIComponent(n.asset_id)}${q.length ? "?" + q.join("&") : ""}`);
    } else if (n.project_id) { current = n.project_id; navigate("/"); }
  },
  async readAll() {
    await fetch("/_api/notifications/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ all: true }) }).catch(() => {});
    this.items.forEach((n) => (n.read = true)); this.unread = 0; this.paintBadge(); this.paintList();
  },
  toggle() { if ($("notif-pop")) closeNotifPop(); else this.openPop(); },
  openPop() {
    const pop = document.createElement("div");
    pop.id = "notif-pop"; pop.className = "notif-pop"; pop.setAttribute("role", "dialog");
    document.body.appendChild(pop);
    this.paintList();
    const r = $("bell").getBoundingClientRect();
    pop.style.top = Math.max(8, r.top) + "px";
    pop.style.left = Math.min(window.innerWidth - pop.offsetWidth - 8, r.right + 10) + "px";
    if (window.innerWidth < 760) { pop.style.left = "8px"; pop.style.top = (r.bottom + 8) + "px"; }
    setTimeout(() => document.addEventListener("pointerdown", notifOutside, true), 0);
    document.addEventListener("keydown", notifEsc, true);
    this.poll();
  },
  paintList() {
    const pop = $("notif-pop");
    if (!pop) return;
    const rows = this.items.map((n, i) => `<button class="nt-item${n.read ? "" : " unread"}" type="button" data-i="${i}">
        <span class="nt-ic">${NOTIF_ICON[n.type] || "🔔"}</span>
        <span class="nt-main">
          <span class="nt-line"><b>${escapeHtml(n.actor)}</b> ${escapeHtml(notifLine(n))}</span>
          ${n.text ? `<span class="nt-text">“${escapeHtml(n.text)}”</span>` : ""}
          <span class="nt-meta">${escapeHtml(n.project_name)} · ${escapeHtml(relTime(n.at))}</span>
        </span>
        ${n.read ? "" : `<span class="nt-dot" aria-label="${escapeHtml(t("nt.unreadOne"))}"></span>`}
      </button>`).join("");
    pop.innerHTML = `<div class="nt-head"><b>${escapeHtml(t("nt.title"))}</b>
        <span class="nt-acts">${this.unread ? `<button class="linkbtn" type="button" id="nt-all">${escapeHtml(t("nt.readAll"))}</button>` : ""}
        <button class="linkbtn" type="button" id="nt-set">${escapeHtml(t("nt.settings"))}</button></span></div>
      <div class="nt-list">${rows || `<div class="cmt-empty">${escapeHtml(t("nt.empty"))}<br><span>${escapeHtml(t("nt.emptyHint"))}</span></div>`}</div>`;
    pop.querySelectorAll(".nt-item").forEach((b) => b.addEventListener("click", () => this.open(this.items[+b.dataset.i])));
    const all = pop.querySelector("#nt-all"); if (all) all.addEventListener("click", () => this.readAll());
    pop.querySelector("#nt-set").addEventListener("click", () => { closeNotifPop(); current = NOTIFY_VIEW; if (location.pathname !== "/") navigate("/"); else render(); });
  },
};
const notifOutside = (e) => { const p = $("notif-pop"); if (p && !p.contains(e.target) && !$("bell").contains(e.target)) closeNotifPop(); };
const notifEsc = (e) => { if (e.key === "Escape" && $("notif-pop")) { e.stopPropagation(); closeNotifPop(); } };
function closeNotifPop() {
  const p = $("notif-pop"); if (p) p.remove();
  document.removeEventListener("pointerdown", notifOutside, true);
  document.removeEventListener("keydown", notifEsc, true);
}

// Tela de configuracao.
async function renderNotifySettings() {
  $("title").textContent = t("nt.settingsTitle");
  $("count").textContent = "";
  const r = await api("GET", "/_api/notify/settings");
  const st = await r.json().catch(() => null);
  if (!r.ok || !st) { $("content").innerHTML = `<div class="empty">${escapeHtml(t("share.fail"))}</div>`; return; }
  const em = st.email, smtp = em.smtp;
  const perm = "Notification" in window ? Notification.permission : "unsupported";
  const browserState = perm === "unsupported" ? t("nt.br.unsupported") : perm === "denied" ? t("nt.br.denied")
    : perm === "granted" && Notifs.browserOn()
      ? (Notifs.push ? t("nt.br.on") : t("nt.br.onTab") + (Notifs.pushSupported() ? "" : " " + t("nt.br.needHttps")))
      : t("nt.br.off");
  const evRows = st.types.map((k) => `<tr>
      <td><span class="nt-ic">${NOTIF_ICON[k]}</span> <b>${escapeHtml(t("nt.ev." + k))}</b><small>${escapeHtml(t("nt.ev." + k + "Hint"))}</small></td>
      <td class="c"><input type="checkbox" data-ev="${k}" data-ch="app"${st.events[k].app ? " checked" : ""} aria-label="${escapeHtml(t("nt.col.app"))}" /></td>
      <td class="c"><input type="checkbox" data-ev="${k}" data-ch="email"${st.events[k].email ? " checked" : ""} aria-label="${escapeHtml(t("nt.col.email"))}" /></td>
    </tr>`).join("");
  const hours = Array.from({ length: 24 }, (_, h) => `<option value="${h}"${h === em.daily_hour ? " selected" : ""}>${String(h).padStart(2, "0")}:00</option>`).join("");
  $("content").innerHTML = `<div class="nt-settings">
    <p class="dev-hint">${escapeHtml(t("nt.intro"))}</p>

    <div class="side-h lib-h">${escapeHtml(t("nt.sec.events"))}</div>
    <table class="nt-table"><thead><tr><th></th><th class="c">${escapeHtml(t("nt.col.app"))}</th><th class="c">${escapeHtml(t("nt.col.email"))}</th></tr></thead>
      <tbody>${evRows}</tbody></table>

    <div class="side-h lib-h">${escapeHtml(t("nt.sec.browser"))}</div>
    <div class="nt-card">
      <label class="switch-row"><input type="checkbox" id="nt-br"${Notifs.browserOn() && perm === "granted" ? " checked" : ""}${perm === "unsupported" || perm === "denied" ? " disabled" : ""} />
        <span><b>${escapeHtml(t("nt.br.label"))}</b><small>${escapeHtml(t("nt.br.hint"))}</small></span></label>
      <div class="nt-status">${escapeHtml(browserState)}</div>
    </div>

    <div class="side-h lib-h">${escapeHtml(t("nt.sec.email"))}</div>
    <form class="nt-card" id="nt-email" autocomplete="off">
      <label class="switch-row"><input type="checkbox" name="enabled"${em.enabled ? " checked" : ""} />
        <span><b>${escapeHtml(t("nt.em.enable"))}</b><small>${escapeHtml(t("nt.em.enableHint"))}</small></span></label>
      <div class="nt-grid">
        <label>${escapeHtml(t("nt.em.to"))}<input class="fld" name="to" type="text" value="${escapeHtml(em.to)}" placeholder="you@example.com, editor@example.com" /></label>
        <label>${escapeHtml(t("nt.em.mode"))}<select class="fld" name="mode">
          <option value="instant"${em.mode === "instant" ? " selected" : ""}>${escapeHtml(t("nt.em.instant"))}</option>
          <option value="hourly"${em.mode === "hourly" ? " selected" : ""}>${escapeHtml(t("nt.em.hourly"))}</option>
          <option value="daily"${em.mode === "daily" ? " selected" : ""}>${escapeHtml(t("nt.em.daily"))}</option></select></label>
        <label class="nt-hour"${em.mode === "daily" ? "" : " hidden"}>${escapeHtml(t("nt.em.hour"))}<select class="fld" name="daily_hour">${hours}</select></label>
      </div>
      <details class="nt-smtp"${smtp.host ? "" : " open"}><summary>${escapeHtml(t("nt.smtp.title"))}${smtp.host ? ` · ${escapeHtml(smtp.host)}` : ""}</summary>
        <p class="dev-note">${escapeHtml(t("nt.smtp.hint"))}</p>
        <div class="nt-grid">
          <label>${escapeHtml(t("nt.smtp.host"))}<input class="fld" name="host" type="text" value="${escapeHtml(smtp.host)}" placeholder="smtp.gmail.com" /></label>
          <label>${escapeHtml(t("nt.smtp.port"))}<input class="fld" name="port" type="number" value="${escapeHtml(smtp.port)}" /></label>
          <label class="check nt-ssl"><input type="checkbox" name="secure"${smtp.secure ? " checked" : ""} /> <span>${escapeHtml(t("nt.smtp.secure"))}</span></label>
          <label>${escapeHtml(t("nt.smtp.user"))}<input class="fld" name="user" type="text" value="${escapeHtml(smtp.user)}" autocomplete="off" /></label>
          <label>${escapeHtml(t("nt.smtp.pass"))}<input class="fld" name="pass" type="password" value="" placeholder="${escapeHtml(smtp.has_pass ? t("nt.smtp.passSaved") : "")}" autocomplete="new-password" /></label>
          <label>${escapeHtml(t("nt.smtp.from"))}<input class="fld" name="from" type="text" value="${escapeHtml(smtp.from)}" placeholder="Fframe &lt;you@example.com&gt;" /></label>
        </div>
      </details>
      ${st.last_error ? `<p class="nt-err">${escapeHtml(t("nt.em.lastError", { when: fmtDay(st.last_error.at) + " " + fmtTime(st.last_error.at), msg: st.last_error.message }))}</p>` : ""}
      <p class="dev-note">${escapeHtml(t("nt.em.links", { base: st.public_base }))}</p>
      <div class="modal-acts nt-acts2">
        <button class="btn-ghost" type="button" id="nt-test">${escapeHtml(t("nt.em.test"))}</button>
        <button class="btn-primary" type="submit">${escapeHtml(t("nt.em.save"))}</button>
      </div>
    </form>
  </div>`;
  const content = $("content");
  // eventos: salva na hora
  content.querySelectorAll("[data-ev]").forEach((c) => c.addEventListener("change", async () => {
    const rr = await api("PUT", "/_api/notify/settings", { events: { [c.dataset.ev]: { [c.dataset.ch]: c.checked } } });
    if (!rr.ok) { c.checked = !c.checked; toast(t("share.fail"), "err"); }
  }));
  // navegador (por navegador)
  const br = $("nt-br");
  if (br) br.addEventListener("change", async () => {
    br.disabled = true;
    if (br.checked) {
      let p = Notification.permission;
      if (p === "default") p = await Notification.requestPermission();
      if (p !== "granted") { br.checked = false; Notifs.setBrowser(false); toast(t("nt.br.denied"), "err"); return renderNotifySettings(); }
      Notifs.setBrowser(true);
      // Com push, o servidor manda o aviso de teste (prova que o caminho todo funciona).
      if (Notifs.pushSupported()) {
        try { await Notifs.pushEnable(true); }
        catch (e) { Notifs.push = false; toast(t("nt.br.pushFail", { msg: e.message || String(e) }), "err"); }
      }
      if (!Notifs.push) try { new Notification(t("nt.br.testTitle"), { body: t("nt.br.testBody"), icon: Brand.icon }); } catch {}
    } else {
      Notifs.setBrowser(false);
      await Notifs.pushDisable();
    }
    renderNotifySettings();
  });
  // e-mail
  const form = $("nt-email");
  form.elements.mode.addEventListener("change", () => { form.querySelector(".nt-hour").hidden = form.elements.mode.value !== "daily"; });
  const emailPatch = () => {
    const f = form.elements;
    return { email: { enabled: f.enabled.checked, to: f.to.value, mode: f.mode.value, daily_hour: f.daily_hour.value,
      smtp: { host: f.host.value, port: f.port.value, secure: f.secure.checked, user: f.user.value, pass: f.pass.value, from: f.from.value } } };
  };
  form.elements.port.addEventListener("change", () => { if (form.elements.port.value === "465") form.elements.secure.checked = true; if (form.elements.port.value === "587") form.elements.secure.checked = false; });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const rr = await api("PUT", "/_api/notify/settings", emailPatch());
    toast(rr.ok ? t("nt.em.saved") : t("share.fail"), rr.ok ? "ok" : "err");
    if (rr.ok) renderNotifySettings();
  });
  $("nt-test").addEventListener("click", async () => {
    const b = $("nt-test"); b.disabled = true; b.textContent = t("nt.em.testing");
    await api("PUT", "/_api/notify/settings", emailPatch());
    const rr = await api("POST", "/_api/notify/test-email");
    const d = await rr.json().catch(() => ({}));
    b.disabled = false; b.textContent = t("nt.em.test");
    if (rr.ok) toast(t("nt.em.testOk", { to: form.elements.to.value }), "ok");
    else await dialog({ title: t("nt.em.testFail"), message: d.error || t("share.fail"), okText: t("modal.ok") });
  });
}

// =============================================================================
// MARCA (admin): nome do app, cor de destaque, logo e favicon.
// Salvar recarrega a pagina: o servidor injeta a marca no HTML (sem piscar).
// =============================================================================
const ACCENT_PRESETS = ["#1A4DFF", "#7C3AED", "#E11D48", "#F97316", "#EAB308", "#16A34A", "#0EA5E9", "#14B8A6", "#F5F5F7"];
async function renderBranding() {
  $("title").textContent = t("br.title");
  $("count").textContent = "";
  const r = await api("GET", "/_api/branding");
  const b = await r.json().catch(() => null);
  if (!r.ok || !b) { $("content").innerHTML = `<div class="empty">${escapeHtml(t("share.fail"))}</div>`; return; }
  const img = (kind, url) => url ? `<img class="br-img ${kind}" src="${escapeHtml(url)}" alt="" />` : `<span class="br-none">${escapeHtml(t("br.none"))}</span>`;
  $("content").innerHTML = `<div class="br-wrap">
    <p class="dev-hint">${escapeHtml(t("br.intro"))}</p>

    <div class="side-h lib-h">${escapeHtml(t("br.sec.name"))}</div>
    <div class="nt-card">
      <label class="br-field">${escapeHtml(t("br.name"))}<input class="fld" id="br-name" type="text" maxlength="60" value="${escapeHtml(b.name)}" placeholder="Fframe" /></label>
      <p class="dev-note">${escapeHtml(t("br.nameHint"))}</p>
    </div>

    <div class="side-h lib-h">${escapeHtml(t("br.sec.color"))}</div>
    <div class="nt-card">
      <div class="br-colors">
        <input type="color" id="br-color" value="${escapeHtml(b.accent)}" aria-label="${escapeHtml(t("br.color"))}" />
        <input class="fld br-hex" id="br-hex" type="text" maxlength="7" value="${escapeHtml(b.accent)}" spellcheck="false" />
        <span class="br-presets">${ACCENT_PRESETS.map((c) => `<button type="button" class="br-swatch" data-c="${c}" title="${c}" aria-label="${c}"><i class="sw-${c.slice(1)}"></i></button>`).join("")}</span>
      </div>
      <div class="br-preview" id="br-preview">
        <button class="btn-primary" type="button" tabindex="-1">${escapeHtml(t("br.previewBtn"))}</button>
        <span class="cmt-time">0:22</span>
        <span class="br-bar"><i></i></span>
        <span class="dot"></span>
      </div>
      <p class="dev-note">${escapeHtml(t("br.colorHint"))}</p>
    </div>

    <div class="side-h lib-h">${escapeHtml(t("br.sec.images"))}</div>
    <div class="br-images">
      <div class="nt-card br-up">
        <b>${escapeHtml(t("br.logo"))}</b><small>${escapeHtml(t("br.logoHint"))}</small>
        <div class="br-show logo">${img("logo", b.logo)}</div>
        <div class="br-acts"><label class="btn-ghost br-pick">${escapeHtml(b.logo ? t("br.replace") : t("br.upload"))}<input type="file" data-kind="logo" accept="image/png,image/jpeg,image/webp,image/svg+xml,image/gif" hidden /></label>
          ${b.logo ? `<button class="btn-ghost danger-txt" type="button" data-clear="logo">${escapeHtml(t("br.remove"))}</button>` : ""}</div>
      </div>
      <div class="nt-card br-up">
        <b>${escapeHtml(t("br.favicon"))}</b><small>${escapeHtml(t("br.faviconHint"))}</small>
        <div class="br-show favicon">${img("favicon", b.favicon)}</div>
        <div class="br-acts"><label class="btn-ghost br-pick">${escapeHtml(b.favicon ? t("br.replace") : t("br.upload"))}<input type="file" data-kind="favicon" accept="image/png,image/svg+xml,image/x-icon,image/vnd.microsoft.icon,image/webp,image/gif,image/jpeg" hidden /></label>
          ${b.favicon ? `<button class="btn-ghost danger-txt" type="button" data-clear="favicon">${escapeHtml(t("br.remove"))}</button>` : ""}</div>
      </div>
    </div>

    <div class="modal-acts br-save">
      <button class="btn-ghost danger-txt" type="button" id="br-reset">${escapeHtml(t("br.reset"))}</button>
      <button class="btn-primary" type="button" id="br-save">${escapeHtml(t("br.save"))}</button>
    </div>
  </div>`;
  const root = document.documentElement, orig = b.accent;
  const color = $("br-color"), hex = $("br-hex");
  // Previa ao vivo: a pagina inteira muda de cor enquanto escolhe.
  const preview = (c) => {
    if (!/^#[0-9a-f]{6}$/i.test(c)) return;
    root.style.setProperty("--royal", c);
    const [R, G, B] = c.slice(1).match(/../g).map((x) => parseInt(x, 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    root.style.setProperty("--on-accent", 0.2126 * R + 0.7152 * G + 0.0722 * B > 0.4 ? "#0A0A0B" : "#FFFFFF");
  };
  color.addEventListener("input", () => { hex.value = color.value.toUpperCase(); preview(color.value); });
  hex.addEventListener("input", () => { const v = hex.value.trim(); if (/^#[0-9a-f]{6}$/i.test(v)) { color.value = v; preview(v); } });
  $("content").querySelectorAll(".br-swatch").forEach((sw) => sw.addEventListener("click", () => { color.value = sw.dataset.c; hex.value = sw.dataset.c; preview(sw.dataset.c); }));
  $("br-save").addEventListener("click", async () => {
    const accent = hex.value.trim();
    if (accent && !/^#[0-9a-f]{6}$/i.test(accent)) { toast(t("br.badColor"), "err"); return; }
    const rr = await api("PUT", "/_api/branding", { name: $("br-name").value, accent });
    const d = await rr.json().catch(() => ({}));
    if (!rr.ok) { toast(d.error || t("share.fail"), "err"); return; }
    location.reload();                                         // a marca vem do servidor no HTML
  });
  $("br-reset").addEventListener("click", async () => {
    if (!(await confirmModal(t("br.reset.confirm"), t("br.reset"), true))) return;
    const rr = await api("POST", "/_api/branding/reset");
    if (rr.ok) location.reload(); else toast(t("share.fail"), "err");
  });
  $("content").querySelectorAll("input[type=file][data-kind]").forEach((inp) => inp.addEventListener("change", async () => {
    const f = inp.files[0]; inp.value = "";
    if (!f) return;
    if (f.size > 3 * 1024 * 1024) { toast(t("br.tooBig"), "err"); return; }
    const rr = await fetch(`/_api/branding/${inp.dataset.kind}`, { method: "PUT", headers: { "Content-Type": f.type || "application/octet-stream" }, body: f });
    const d = await rr.json().catch(() => ({}));
    if (!rr.ok) { toast(d.error || t("share.fail"), "err"); return; }
    location.reload();
  }));
  $("content").querySelectorAll("[data-clear]").forEach((btn) => btn.addEventListener("click", async () => {
    const rr = await api("DELETE", `/_api/branding/${btn.dataset.clear}`);
    if (rr.ok) location.reload(); else toast(t("share.fail"), "err");
  }));
  // sair sem salvar desfaz a previa
  const undo = () => { if (current !== BRAND_VIEW) { root.style.removeProperty("--royal"); root.style.removeProperty("--on-accent"); window.removeEventListener("click", undoLater, true); } };
  const undoLater = () => setTimeout(undo, 0);
  window.addEventListener("click", undoLater, true);
  void orig;
}

// ---- Gaveta (mobile) --------------------------------------------------------
const openDrawer = () => $("app").classList.add("open");
const closeDrawer = () => $("app").classList.remove("open");

// ---- Ligações ---------------------------------------------------------------
$("auth-card").addEventListener("submit", submitAuth);
$("logout").addEventListener("click", logout);
$("new-proj").addEventListener("click", novoProjeto);
$("nav-devices").addEventListener("click", () => { current = DEVICES_VIEW; closeDrawer(); render(); });
$("nav-library").addEventListener("click", () => { current = LIBRARY_VIEW; closeDrawer(); render(); });
$("nav-notify").addEventListener("click", () => { current = NOTIFY_VIEW; closeDrawer(); if (location.pathname !== "/") navigate("/"); else render(); });
$("bell").addEventListener("click", (e) => { e.stopPropagation(); Notifs.toggle(); });
$("nav-brand").addEventListener("click", () => { current = BRAND_VIEW; closeDrawer(); if (location.pathname !== "/") navigate("/"); else render(); });
$("tr-import").addEventListener("click", () => $("tr-import-file").click());
$("share-btn").addEventListener("click", shareModal);
$("settings-btn").addEventListener("click", settingsModal);
$("tr-import-file").addEventListener("change", (e) => { const fs = e.target.files; importarTranscricoes(fs).finally(() => { e.target.value = ""; }); });
$("menu").addEventListener("click", openDrawer);
$("scrim").addEventListener("click", closeDrawer);

// PWA: registra o service worker (instalavel + funciona offline)
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}

init();
