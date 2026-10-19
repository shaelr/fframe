"use strict";
// Frontend do painel. NENHUM segredo aqui: a autenticacao e feita por cookie de
// sessao (httpOnly) e TODA autorizacao e validada no servidor.
// Textos visiveis vem do i18n.js (t("chave")) — nunca escreva texto fixo aqui.

let projects = [], current = null, configured = false;
const DEVICES_VIEW = "__devices__"; // valor especial de `current` p/ tela Dispositivos
const LIBRARY_VIEW = "__library__"; // tela Biblioteca (pastas do NAS)
let libraryPath = "";               // pasta aberta no navegador da Biblioteca

const $ = (id) => document.getElementById(id);
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
const confirmModal = (message, okText, danger) =>
  dialog({ title: t("modal.confirmTitle"), message, okText: okText || t("modal.confirm"), danger });
const promptModal = (title, placeholder) => dialog({ title, input: true, placeholder, okText: t("modal.create") });

// ---- Autenticacao -----------------------------------------------------------
async function init() {
  I18n.init();
  I18n.onChange = () => { if ($("app").classList.contains("hidden")) showAuth(); else render(); };
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
  $("host").textContent = location.host;
  render();
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
    if (!r.ok) { err.textContent = data.error === "credenciais invalidas" ? t("auth.err.invalid") : (data.error || t("auth.err.generic")); return; }
    configured = true;
    $("auth-pass").value = ""; $("auth-pass2").value = "";
    showApp();
  } finally { $("auth-btn").disabled = false; }
}
async function logout() { await api("POST", "/_auth/logout"); location.reload(); }

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
  $("tr-import").classList.add("hidden");
  if (current === DEVICES_VIEW) return renderDevices();
  if (current === LIBRARY_VIEW) return renderLibrary();
  const proj = projects.find((p) => p.id === current);
  $("title").textContent = proj ? proj.name : t("title.allVideos");
  const url = current ? "/_api/assets?project=" + encodeURIComponent(current) : "/_api/assets";
  const assets = await (await api("GET", url)).json();
  $("count").textContent = t("count.videos", { n: assets.length });
  const imp = $("tr-import");
  imp.classList.toggle("hidden", !proj || !assets.length);
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
  content.querySelectorAll("[data-play]").forEach((b) =>
    b.addEventListener("click", () => openPlayer(b.dataset.play, b.dataset.name)));
}
function cardHtml(a) {
  const lib = a.source === "library";
  return `<div class="card${lib ? " lib" : ""}">
    <button class="thumb" type="button" data-play="${a.id}" data-name="${escapeHtml(a.name)}">
      <video preload="metadata" muted playsinline src="/_media/${a.id}#t=0.5"></video>
      <span class="playbtn">▶</span>
      ${a.comment_count ? `<span class="cmt-badge">💬 ${a.comment_count}</span>` : ""}
      ${a.has_transcript ? `<span class="tr-badge" title="${escapeHtml(t("tr.title"))}">📝</span>` : ""}
      ${lib ? `<span class="lib-badge" title="${escapeHtml("/" + (a.library_folder || ""))}">📁 ${escapeHtml(t("card.library"))}</span>` : ""}
    </button>
    <div class="meta">
      <div class="nm" title="${escapeHtml(lib ? "/" + (a.library_folder ? a.library_folder + "/" : "") + a.name : a.name)}">${escapeHtml(a.name)}</div>
      <div class="row"><span>${fmtSize(a.filesize)} · ${fmtTime(a.uploaded_at)}</span>
        <span class="acts">
          <a class="act" href="/_download/${a.id}">${escapeHtml(t("card.download"))}</a>
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
// Cores dos marcadores do DaVinci Resolve (comentarios importados).
// (as cores ficam no app.css como .mk-<Cor>: a CSP bloqueia style="" inline)
const MARKER_COLORS = ["Blue", "Cyan", "Green", "Yellow", "Red", "Pink", "Purple", "Fuchsia", "Rose",
  "Lavender", "Sky", "Mint", "Lemon", "Sand", "Cocoa", "Cream"];
const markerColor = (c) => (c && MARKER_COLORS.includes(c.color) ? "mk-" + c.color : null);
// Autor "device:Celular do Ciro" -> "Celular do Ciro".
const authorLabel = (a) => (a ? String(a).replace(/^device:/, "") : "—");

// Player de revisao estilo Frame.io: barra propria com pins na timeline,
// timecode, passo frame a frame, atalhos, e comentarios (trecho + respostas).
function openPlayer(id, name) {
  const p = $("player");
  p.innerHTML =
    `<div class="player-inner review">
      <div class="player-main">
        <div class="player-bar">
          <span class="player-name">${escapeHtml(name)}</span>
          <button class="player-edl" type="button" id="pv-edl" title="${escapeHtml(t("edl.title"))}">⤓ ${escapeHtml(t("edl.btn"))}</button>
          <button class="player-close" type="button" data-close aria-label="${escapeHtml(t("player.close"))}">✕</button>
        </div>
        <div class="pv" id="pv">
          <div class="pv-stage" id="pv-stage">
            <video class="player-video" src="/_media/${id}" playsinline></video>
            <button class="pv-bigplay" id="pv-bigplay" type="button" aria-label="${escapeHtml(t("pv.play"))}">▶</button>
          </div>
          <div class="pv-ctl">
            <div class="pv-scrub" id="pv-scrub">
              <div class="pv-track">
                <div class="pv-buffered" id="pv-buffered"></div>
                <div class="pv-progress" id="pv-progress"></div>
                <div class="pv-pins" id="pv-pins"></div>
                <div class="pv-head" id="pv-head"></div>
              </div>
            </div>
            <div class="pv-btns">
              <button class="pv-b" id="pv-play" type="button" aria-label="${escapeHtml(t("pv.play"))}">▶</button>
              <button class="pv-b" id="pv-fb" type="button" title="${escapeHtml(t("pv.frameBack"))}" aria-label="${escapeHtml(t("pv.frameBack"))}">◀|</button>
              <button class="pv-b" id="pv-ff" type="button" title="${escapeHtml(t("pv.frameFwd"))}" aria-label="${escapeHtml(t("pv.frameFwd"))}">|▶</button>
              <span class="pv-tc" id="pv-tc" title="${escapeHtml(t("pv.shortcuts"))}">00:00:00:00</span>
              <span class="pv-dur" id="pv-dur">/ 00:00:00:00</span>
              <select class="pv-fps" id="pv-fps" title="${escapeHtml(t("pv.fps"))}" aria-label="${escapeHtml(t("pv.fps"))}">
                <option value="auto">fps: auto</option>
                <option value="23.976">23.976</option><option value="24">24</option><option value="25">25</option>
                <option value="29.97">29.97</option><option value="30">30</option><option value="50">50</option><option value="60">60</option>
              </select>
              <span class="pv-spacer"></span>
              <button class="pv-b" id="pv-mute" type="button" aria-label="${escapeHtml(t("pv.mute"))}">🔊</button>
              <button class="pv-b" id="pv-fs" type="button" aria-label="${escapeHtml(t("pv.fullscreen"))}">⛶</button>
            </div>
          </div>
        </div>
      </div>
      <aside class="player-side">
        <div class="side-tabs" role="tablist">
          <button class="side-tab" type="button" role="tab" data-tab="cmt">${escapeHtml(t("cmt.title"))} <span class="cmt-n" id="cmt-n">0</span></button>
          <button class="side-tab" type="button" role="tab" data-tab="tr">${escapeHtml(t("tr.title"))} <span class="tr-dot" id="tr-dot" hidden></span></button>
        </div>
        <div class="side-pane tr-pane" id="pane-tr" hidden>
          <div class="tr-tools">
            <input id="tr-search" class="fld tr-search" type="search" placeholder="${escapeHtml(t("tr.search"))}" autocomplete="off" />
            <span class="tr-hits" id="tr-hits"></span>
            <button class="tr-tool" id="tr-follow" type="button" aria-pressed="true" title="${escapeHtml(t("tr.follow.title"))}">${escapeHtml(t("tr.follow"))}</button>
            <button class="tr-tool" id="tr-menu" type="button" aria-label="${escapeHtml(t("tr.menu"))}" title="${escapeHtml(t("tr.menu"))}">⋯</button>
          </div>
          <div class="tr-body" id="tr-body"></div>
          <button class="tr-sel" id="tr-sel" type="button" hidden>💬 ${escapeHtml(t("tr.commentSel"))}</button>
          <input id="tr-file" type="file" accept=".srt,.vtt,.txt,.json,text/plain,application/json" hidden />
        </div>
        <div class="side-pane" id="pane-cmt">
        <div class="cmt-list" id="cmt-list"></div>
        <form class="cmt-compose" id="cmt-compose" autocomplete="off">
          <div class="cmt-when">
            <span class="chip" id="cmt-chip"></span>
            <button type="button" class="cmt-reset" id="cmt-reset" hidden>↺ ${escapeHtml(t("cmt.now"))}</button>
            <button type="button" class="cmt-out" id="cmt-out">${escapeHtml(t("cmt.markIn"))}</button>
          </div>
          <textarea id="cmt-text" rows="2"></textarea>
          <button class="btn-primary" id="cmt-send" type="submit">${escapeHtml(t("cmt.send"))}</button>
        </form>
        </div>
      </aside>
    </div>`;
  p.classList.add("show");

  const video = p.querySelector("video");
  let comments = [];
  let composeTime = null;   // ponto congelado (comentario de ponto; null = segue o playhead)
  let markIn = null;        // inicio do trecho (marcado explicitamente)
  let markOut = null;       // fim do trecho (marcado explicitamente)
  let duration = 0;
  let fps = 24;             // fps atual (default; refinado por deteccao ou manual)
  let fpsAuto = true;       // "auto" = detecta pelos frames; senao usa o valor escolhido
  let activeId = null;      // comentario "aceso" pelo playhead
  let replyTo = null;       // id do comentario sendo respondido

  const el = (i) => document.getElementById(i);
  const textEl = () => el("cmt-text");
  const seek = (sec) => { try { video.currentTime = Math.max(0, Math.min(duration || sec, sec)); } catch {} };
  const frameStep = (dir) => { video.pause(); seek(video.currentTime + dir / fps); };
  const togglePlay = () => { if (video.paused) video.play().catch(() => {}); else video.pause(); };

  // ---- Deteccao de fps (requestVideoFrameCallback quando existe) -------------
  let fpsDetected = false;
  function detectFps() {
    if (!fpsAuto || fpsDetected || !video.requestVideoFrameCallback) return;
    let last = null; const samples = [];
    const cb = (now, meta) => {
      if (!fpsAuto) return;
      if (last != null && meta.mediaTime > last) { const d = meta.mediaTime - last; if (d > 0.001 && d < 0.2) samples.push(d); }
      last = meta.mediaTime;
      if (samples.length < 12 && !video.paused) { video.requestVideoFrameCallback(cb); return; }
      if (samples.length >= 5) {
        samples.sort((a, b) => a - b);
        const guess = Math.round(1 / samples[Math.floor(samples.length / 2)]);
        if (guess >= 12 && guess <= 120) { fps = guess; fpsDetected = true; updateTC(); }
      }
    };
    video.requestVideoFrameCallback(cb);
  }

  // ---- Barra de reprodução ---------------------------------------------------
  function updateTC() {
    el("pv-tc").textContent = fmtTC(video.currentTime, fps);
    el("pv-dur").textContent = "/ " + fmtTC(duration, fps);
  }
  function updateScrub() {
    const pct = duration ? (video.currentTime / duration * 100) : 0;
    el("pv-progress").style.width = pct + "%";
    el("pv-head").style.left = pct + "%";
    try { if (video.buffered.length) el("pv-buffered").style.width = (duration ? video.buffered.end(video.buffered.length - 1) / duration * 100 : 0) + "%"; } catch {}
  }
  function setPlayIcon() {
    const playing = !video.paused && !video.ended;
    el("pv-play").textContent = playing ? "⏸" : "▶";
    el("pv-play").setAttribute("aria-label", playing ? t("pv.pause") : t("pv.play"));
    el("pv-bigplay").style.display = playing ? "none" : "flex";
  }

  // Scrubbing (clique + arrasto)
  const scrub = el("pv-scrub");
  const seekFromEvent = (clientX) => { const r = scrub.getBoundingClientRect(); seek(Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * duration); };
  let scrubbing = false;
  scrub.addEventListener("pointerdown", (e) => { scrubbing = true; try { scrub.setPointerCapture(e.pointerId); } catch {} seekFromEvent(e.clientX); });
  scrub.addEventListener("pointermove", (e) => { if (scrubbing) seekFromEvent(e.clientX); });
  scrub.addEventListener("pointerup", (e) => { scrubbing = false; try { scrub.releasePointerCapture(e.pointerId); } catch {} });

  // Pins de comentario NA barra (top-level; trecho vira uma faixa)
  function renderPins() {
    const box = el("pv-pins");
    const tops = comments.filter((c) => !c.parent_id);
    box.innerHTML = tops.map((c) =>
      `<span class="pv-pin${c.t_end != null ? " range" : ""}${c.resolved ? " done" : ""}${markerColor(c) && !c.resolved ? " marker " + markerColor(c) : ""}" data-id="${c.id}" title="${escapeHtml(authorLabel(c.author) + ": " + c.text)}"></span>`).join("");
    box.querySelectorAll(".pv-pin").forEach((pin) => {
      const c = tops.find((x) => x.id === pin.dataset.id);
      if (!duration || !c) return;
      pin.style.left = (c.t / duration * 100).toFixed(3) + "%";
      if (c.t_end != null) pin.style.width = Math.max(0.6, (c.t_end - c.t) / duration * 100).toFixed(3) + "%";
      pin.classList.toggle("active", c.id === activeId);
      pin.addEventListener("click", (e) => { e.stopPropagation(); seek(c.t); highlight(c.id, true); });
    });
  }

  // Comentario "aceso" conforme o playhead passa por ele
  function activeAt(time) {
    let cur = null;
    comments.filter((c) => !c.parent_id).sort((a, b) => a.t - b.t).forEach((c) => {
      const end = c.t_end != null ? c.t_end : c.t + 0.4;
      if (time >= c.t - 0.05 && time <= end + 0.25) cur = c;
    });
    return cur ? cur.id : null;
  }
  function highlight(cid, doScroll) {
    activeId = cid;
    el("cmt-list").querySelectorAll(".cmt-item").forEach((it) => {
      const on = it.dataset.id === cid;
      it.classList.toggle("active", on);
      if (on && doScroll) it.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    el("pv-pins").querySelectorAll(".pv-pin").forEach((pin) => pin.classList.toggle("active", pin.dataset.id === cid));
  }

  // ---- Compose: ponto (padrao) ou trecho (marcar inicio -> marcar fim) ------
  function updateChip() {
    const out = el("cmt-out");
    if (markIn != null && markOut != null) {          // trecho completo
      el("cmt-chip").textContent = t("cmt.range", { from: fmtClock(markIn), to: fmtClock(markOut) });
      out.textContent = t("cmt.clearOut");
      textEl().placeholder = t("cmt.placeholder", { time: fmtClock(markIn) });
    } else if (markIn != null) {                       // inicio marcado, esperando o fim
      el("cmt-chip").textContent = t("cmt.rangeStart", { from: fmtClock(markIn) });
      out.textContent = t("cmt.markOut");
      textEl().placeholder = t("cmt.placeholder", { time: fmtClock(markIn) });
    } else {                                           // comentario de ponto
      const inT = composeTime != null ? composeTime : video.currentTime;
      el("cmt-chip").textContent = t("cmt.at", { time: fmtClock(inT) });
      out.textContent = t("cmt.markIn");
      textEl().placeholder = t("cmt.placeholder", { time: fmtClock(inT) });
    }
    // "usar momento atual" so aparece no modo ponto, com o ponto congelado
    el("cmt-reset").hidden = !(composeTime != null && markIn == null);
  }
  function freeze() { if (composeTime == null && markIn == null) { composeTime = video.currentTime; video.pause(); updateChip(); } }
  function unfreeze() { composeTime = null; markIn = null; markOut = null; updateChip(); }

  // ---- Lista de comentarios (threads + trecho) ------------------------------
  function renderList() {
    const tops = comments.filter((c) => !c.parent_id).sort((a, b) => a.t - b.t);
    const repliesOf = (pid) => comments.filter((c) => c.parent_id === pid).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    el("cmt-n").textContent = comments.length;
    const list = el("cmt-list");
    if (!tops.length) {
      list.innerHTML = `<div class="cmt-empty">${escapeHtml(t("cmt.empty"))}<br><span>${escapeHtml(t("cmt.emptyHint"))}</span></div>`;
      return;
    }
    const timeLabel = (c) => c.t_end != null ? t("cmt.range", { from: fmtClock(c.t), to: fmtClock(c.t_end) }) : fmtClock(c.t);
    const replyHtml = (r) => `<div class="cmt-reply-item">
        <div class="cmt-top"><span class="cmt-auth">${escapeHtml(authorLabel(r.author))}</span></div>
        <div class="cmt-body">${escapeHtml(r.text)}</div>
        <div class="cmt-acts"><button class="cmt-act danger" type="button" data-del="${r.id}">${escapeHtml(t("cmt.delete"))}</button></div>
      </div>`;
    list.innerHTML = tops.map((c) => {
      const reps = repliesOf(c.id);
      return `<div class="cmt-item${c.resolved ? " done" : ""}${c.id === activeId ? " active" : ""}" data-id="${c.id}">
        <div class="cmt-top">
          <button class="cmt-time" type="button" data-seek="${c.t}" title="${escapeHtml(t("cmt.jump", { time: fmtClock(c.t) }))}">${escapeHtml(timeLabel(c))}</button>
          ${markerColor(c) ? `<span class="mk-dot ${markerColor(c)}" title="${escapeHtml(t("cmt.marker", { color: c.color }))}"></span>` : ""}
          <span class="cmt-auth">${escapeHtml(authorLabel(c.author))}</span>
        </div>
        <div class="cmt-body">${escapeHtml(c.text)}</div>
        <div class="cmt-acts">
          <button class="cmt-act" type="button" data-reply="${c.id}">${escapeHtml(t("cmt.reply"))}</button>
          <button class="cmt-act" type="button" data-resolve="${c.id}" data-on="${c.resolved ? 1 : 0}">${escapeHtml(c.resolved ? t("cmt.reopen") : t("cmt.resolve"))}</button>
          <button class="cmt-act danger" type="button" data-del="${c.id}">${escapeHtml(t("cmt.delete"))}</button>
        </div>
        ${reps.length ? `<div class="cmt-replies">${reps.map(replyHtml).join("")}</div>` : ""}
        ${replyTo === c.id ? `<form class="cmt-replybox" data-parent="${c.id}"><input class="fld" type="text" placeholder="${escapeHtml(t("cmt.replyPlaceholder"))}" /><button class="btn-primary" type="submit">${escapeHtml(t("cmt.replySend"))}</button></form>` : ""}
      </div>`;
    }).join("");
    list.querySelectorAll("[data-seek]").forEach((b) => b.addEventListener("click", () => { seek(parseFloat(b.dataset.seek)); highlight(b.closest(".cmt-item").dataset.id, false); }));
    list.querySelectorAll("[data-resolve]").forEach((b) => b.addEventListener("click", () => toggleResolve(b.dataset.resolve, b.dataset.on !== "1")));
    list.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => delComment(b.dataset.del)));
    list.querySelectorAll("[data-reply]").forEach((b) => b.addEventListener("click", () => { replyTo = replyTo === b.dataset.reply ? null : b.dataset.reply; renderList(); const inp = list.querySelector(".cmt-replybox input"); if (inp) inp.focus(); }));
    list.querySelectorAll(".cmt-replybox").forEach((f) => f.addEventListener("submit", (e) => { e.preventDefault(); sendReply(f.dataset.parent, f.querySelector("input").value); }));
  }

  async function load() {
    try { comments = await (await api("GET", `/_api/assets/${id}/comments`)).json(); }
    catch { comments = []; }
    renderList(); renderPins();
  }
  async function toggleResolve(cid, resolved) {
    await api("PATCH", `/_api/assets/${id}/comments/${cid}`, { resolved });
    const c = comments.find((x) => x.id === cid); if (c) c.resolved = resolved;
    renderList(); renderPins();
  }
  async function delComment(cid) {
    const ok = await confirmModal(t("cmt.delete.confirm"), t("cmt.delete"), true);
    if (!ok) return;
    const r = await api("DELETE", `/_api/assets/${id}/comments/${cid}`);
    if (!r.ok) { toast(t("cmt.delete.fail"), "err"); return; }
    comments = comments.filter((x) => x.id !== cid && x.parent_id !== cid);
    renderList(); renderPins(); toast(t("cmt.deleted"), "ok");
  }
  async function submit(ev) {
    ev.preventDefault();
    const text = textEl().value.trim();
    if (!text) return;
    let body;
    if (markIn != null && markOut != null && markOut > markIn + 0.05) body = { t: markIn, t_end: markOut, text };
    else body = { t: (composeTime != null ? composeTime : video.currentTime), text };
    const btn = el("cmt-send"); btn.disabled = true; btn.textContent = t("cmt.sending");
    try {
      const r = await api("POST", `/_api/assets/${id}/comments`, body);
      const c = await r.json().catch(() => null);
      if (!r.ok || !c || !c.id) { toast((c && c.error) || t("cmt.add.fail"), "err"); return; }
      comments.push(c);
      textEl().value = ""; unfreeze();
      renderList(); renderPins(); toast(t("cmt.added"), "ok");
    } finally { btn.disabled = false; btn.textContent = t("cmt.send"); }
  }
  async function sendReply(parentId, text) {
    text = String(text || "").trim();
    if (!text) return;
    const r = await api("POST", `/_api/assets/${id}/comments`, { parent_id: parentId, text });
    const c = await r.json().catch(() => null);
    if (!r.ok || !c || !c.id) { toast(t("cmt.add.fail"), "err"); return; }
    comments.push(c); replyTo = null;
    renderList(); renderPins();
  }

  // ---- Transcricao (estilo DaVinci Resolve): clicar numa palavra leva o
  // playhead ate ela; a palavra falada acende e a lista acompanha. -----------
  let tr = null;            // { segments: [{t,end,speaker,text,words:[[t,end,txt]]}], ... }
  let flat = [];            // todas as palavras em ordem: { t, end, si, wi, el }
  let curWord = -1;
  let follow = true, userScrollAt = 0, rafId = 0;
  let hits = [], hitIdx = -1;
  const trBody = el("tr-body");

  function setTab(tab, remember) {
    p.querySelectorAll(".side-tab").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
    el("pane-cmt").hidden = tab !== "cmt";
    el("pane-tr").hidden = tab !== "tr";
    if (remember) { try { localStorage.setItem("fframe.sideTab", tab); } catch {} }
  }
  p.querySelectorAll(".side-tab").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab, true)));

  function renderTranscript() {
    flat = []; curWord = -1; hits = []; hitIdx = -1; el("tr-hits").textContent = "";
    el("tr-dot").hidden = !tr;
    if (!tr) {
      trBody.innerHTML = `<div class="cmt-empty">${escapeHtml(t("tr.empty"))}<br><span>${escapeHtml(t("tr.emptyHint"))}</span><br>
        <button class="btn-primary tr-upload" type="button" data-trupload>${escapeHtml(t("tr.upload"))}</button></div>`;
      trBody.querySelector("[data-trupload]").addEventListener("click", () => el("tr-file").click());
      return;
    }
    let prevSpeaker = null;
    trBody.innerHTML = tr.segments.map((s, si) => {
      const showSpk = s.speaker && s.speaker !== prevSpeaker; prevSpeaker = s.speaker || prevSpeaker;
      return `<div class="tr-seg" data-si="${si}">
        <div class="tr-meta"><button class="cmt-time" type="button" data-tseek="${s.t}">${escapeHtml(fmtClock(s.t))}</button>${showSpk ? `<span class="tr-spk">${escapeHtml(s.speaker)}</span>` : ""}</div>
        <p class="tr-p">${s.words.map((w, wi) => `<span class="w" data-si="${si}" data-wi="${wi}">${escapeHtml(w[2])}</span>`).join(" ")}</p>
      </div>`;
    }).join("") + (tr.approx ? `<p class="tr-note">${escapeHtml(t("tr.approxNote"))}</p>` : "");
    trBody.querySelectorAll(".w").forEach((node) => {
      const s = tr.segments[+node.dataset.si], w = s.words[+node.dataset.wi];
      flat.push({ t: w[0], end: w[1], el: node });
    });
    flat.sort((a, b) => a.t - b.t);
    syncWord(true);
  }

  // Palavra atual: ultima com inicio <= tempo (busca binaria).
  function wordAt(time) {
    let lo = 0, hi = flat.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (flat[mid].t <= time + 0.02) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  }
  function syncWord(force) {
    if (!flat.length) return;
    const i = wordAt(video.currentTime);
    if (i === curWord && !force) return;
    if (curWord >= 0 && flat[curWord]) { flat[curWord].el.classList.remove("now"); flat[curWord].el.closest(".tr-seg").classList.remove("now"); }
    curWord = i;
    if (i < 0) return;
    const w = flat[i];
    w.el.classList.add("now");
    const seg = w.el.closest(".tr-seg");
    seg.classList.add("now");
    // marca o que ja foi falado (cinza claro) so no segmento atual — barato
    if (follow && !el("pane-tr").hidden && Date.now() - userScrollAt > 3000) {
      const br = trBody.getBoundingClientRect(), wr = w.el.getBoundingClientRect();
      if (wr.top < br.top + 40 || wr.bottom > br.bottom - 40) {
        trBody.scrollTo({ top: trBody.scrollTop + (wr.top - br.top) - br.height / 3, behavior: video.paused ? "auto" : "smooth" });
      }
    }
  }
  const loop = () => { syncWord(false); if (!video.paused && p.classList.contains("show")) rafId = requestAnimationFrame(loop); };
  video.addEventListener("play", () => { cancelAnimationFrame(rafId); rafId = requestAnimationFrame(loop); });
  video.addEventListener("seeked", () => syncWord(false));
  video.addEventListener("timeupdate", () => syncWord(false)); // reserva se o rAF for estrangulado (aba em 2o plano)
  // rolar a mao pausa o "acompanhar" por alguns segundos
  ["wheel", "touchmove"].forEach((ev) => trBody.addEventListener(ev, () => { userScrollAt = Date.now(); }, { passive: true }));

  trBody.addEventListener("click", (e) => {
    const tb = e.target.closest("[data-tseek]");
    if (tb) { seek(parseFloat(tb.dataset.tseek)); userScrollAt = 0; return; }
    const node = e.target.closest(".w");
    if (!node) return;
    const sel = getSelection();
    if (sel && !sel.isCollapsed && trBody.contains(sel.anchorNode)) return;   // arrastando p/ selecionar
    const w = tr.segments[+node.dataset.si].words[+node.dataset.wi];
    seek(w[0]); userScrollAt = 0;
  });
  el("tr-follow").addEventListener("click", () => {
    follow = !follow; userScrollAt = 0;
    el("tr-follow").setAttribute("aria-pressed", String(follow));
    if (follow) syncWord(true);
  });

  // Busca: destaca as palavras/frases; Enter vai para o proximo resultado.
  function runSearch() {
    const q = el("tr-search").value.trim().toLowerCase();
    trBody.querySelectorAll(".w.hit").forEach((n) => n.classList.remove("hit", "hit-cur"));
    hits = []; hitIdx = -1;
    if (!q || !flat.length) { el("tr-hits").textContent = ""; return; }
    const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}' ]/gu, "");
    const qs = norm(q).split(/\s+/).filter(Boolean);
    if (!qs.length) { el("tr-hits").textContent = ""; return; }
    const words = flat.map((f) => norm(f.el.textContent));
    for (let i = 0; i + qs.length <= words.length; i++) {
      let ok = true;
      for (let k = 0; k < qs.length; k++) {
        const last = k === qs.length - 1;
        if (last ? !words[i + k].startsWith(qs[k]) : words[i + k] !== qs[k]) { ok = false; break; }
      }
      if (ok) { hits.push(i); for (let k = 0; k < qs.length; k++) flat[i + k].el.classList.add("hit"); }
    }
    el("tr-hits").textContent = hits.length ? t("tr.hits", { n: hits.length }) : t("tr.noHits");
  }
  function nextHit(dir) {
    if (!hits.length) return;
    trBody.querySelectorAll(".w.hit-cur").forEach((n) => n.classList.remove("hit-cur"));
    hitIdx = (hitIdx + dir + hits.length) % hits.length;
    const f = flat[hits[hitIdx]];
    f.el.classList.add("hit-cur");
    f.el.scrollIntoView({ block: "center" });
    userScrollAt = Date.now();
    seek(f.t);
    el("tr-hits").textContent = `${hitIdx + 1}/${hits.length}`;
  }
  el("tr-search").addEventListener("input", runSearch);
  el("tr-search").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); nextHit(e.shiftKey ? -1 : 1); }
  });

  // Selecionar um trecho do texto -> "comentar trecho" (marca in/out).
  function selectionRange() {
    const sel = getSelection();
    if (!sel || sel.isCollapsed || !trBody.contains(sel.anchorNode) || !trBody.contains(sel.focusNode)) return null;
    const nodes = Array.from(trBody.querySelectorAll(".w")).filter((n) => sel.containsNode(n, true));
    if (!nodes.length) return null;
    const ws = nodes.map((n) => tr.segments[+n.dataset.si].words[+n.dataset.wi]);
    return { t: Math.min(...ws.map((w) => w[0])), end: Math.max(...ws.map((w) => w[1])), text: nodes.map((n) => n.textContent).join(" ") };
  }
  document.addEventListener("selectionchange", onSelChange);
  function onSelChange() {
    const r = el("pane-tr") && !el("pane-tr").hidden ? selectionRange() : null;
    el("tr-sel").hidden = !r;
  }
  el("tr-sel").addEventListener("mousedown", (e) => e.preventDefault()); // nao perde a selecao
  el("tr-sel").addEventListener("click", () => {
    const r = selectionRange();
    if (!r) return;
    video.pause();
    markIn = r.t; markOut = Math.max(r.end, r.t + 0.1); composeTime = null;
    seek(r.t);
    getSelection().removeAllRanges(); el("tr-sel").hidden = true;
    setTab("cmt");
    updateChip();
    const quote = r.text.length > 140 ? r.text.slice(0, 140) + "…" : r.text;
    if (!textEl().value.trim()) textEl().value = `“${quote}” — `;
    textEl().focus();
    textEl().setSelectionRange(textEl().value.length, textEl().value.length);
  });

  // Enviar / trocar / ajustar / remover a transcricao.
  const needsFps = (name) => /\.(txt|json)$/i.test(name || "");
  async function uploadTranscript(file) {
    if (!file) return;
    if (file.size > 30 * 1024 * 1024) { toast(t("tr.tooBig"), "err"); return; }
    let fps = null;
    if (needsFps(file.name)) { fps = await fpsModal(); if (fps == null) return; }
    const content = await file.text();
    const r = await api("PUT", `/_api/assets/${id}/transcript`, { filename: file.name, content, fps });
    const d = await r.json().catch(() => null);
    if (!r.ok || !d) { toast((d && d.error) || t("tr.uploadFail"), "err"); return; }
    if (d.markers) await load();                       // marcadores viraram comentarios
    if (d.transcript) { tr = d.transcript; renderTranscript(); setTab("tr"); }
    else if (d.markers) setTab("cmt");
    const parts = [];
    if (d.transcript) parts.push(t("tr.uploaded", { n: d.transcript.segments.length }));
    if (d.markers) parts.push(t("tr.markersImported", { n: d.markers }));
    toast(parts.join(" ") || t("tr.uploadFail"), parts.length ? "ok" : "err");
  }
  el("tr-file").addEventListener("change", (e) => { const f = e.target.files[0]; e.target.value = ""; uploadTranscript(f); });
  el("tr-menu").addEventListener("click", async () => {
    const act = await trMenuModal(tr);
    if (!act) return;
    if (act === "upload") el("tr-file").click();
    else if (act === "remove") {
      if (!(await confirmModal(t("tr.remove.confirm"), t("tr.remove"), true))) return;
      const r = await api("DELETE", `/_api/assets/${id}/transcript`);
      if (r.ok) { tr = null; renderTranscript(); toast(t("tr.removed"), "ok"); }
    } else if (act.fps != null || act.offset != null) {
      const r = await api("PATCH", `/_api/assets/${id}/transcript`, act);
      const d = await r.json().catch(() => null);
      if (r.ok && d && d.segments) { tr = d; renderTranscript(); toast(t("tr.updated"), "ok"); }
      else toast(t("tr.uploadFail"), "err");
    }
  });

  async function loadTranscript() {
    try {
      const r = await api("GET", `/_api/assets/${id}/transcript`);
      tr = r.ok ? await r.json() : null;
    } catch { tr = null; }
    renderTranscript();
    let saved = null; try { saved = localStorage.getItem("fframe.sideTab"); } catch {}
    setTab(tr && saved !== "cmt" ? "tr" : "cmt");
  }
  setTab("cmt");
  loadTranscript();

  // Comentarios -> marcadores na timeline do Resolve (EDL, sem script).
  el("pv-edl").addEventListener("click", async () => {
    const opt = await edlModal();
    if (!opt) return;
    const a = document.createElement("a");
    a.href = `/_api/assets/${id}/markers.edl?fps=${encodeURIComponent(opt.fps)}&start=${encodeURIComponent(opt.start)}`;
    a.download = ""; document.body.appendChild(a); a.click(); a.remove();
  });

  // ---- Ligações dos controles -----------------------------------------------
  el("pv-play").addEventListener("click", togglePlay);
  el("pv-bigplay").addEventListener("click", togglePlay);
  video.addEventListener("click", togglePlay);
  el("pv-fb").addEventListener("click", () => frameStep(-1));
  el("pv-ff").addEventListener("click", () => frameStep(1));
  el("pv-mute").addEventListener("click", () => { video.muted = !video.muted; el("pv-mute").textContent = video.muted ? "🔇" : "🔊"; });
  el("pv-fs").addEventListener("click", () => { if (document.fullscreenElement) document.exitFullscreen(); else el("pv").requestFullscreen && el("pv").requestFullscreen(); });
  el("pv-fps").addEventListener("change", (e) => {
    const v = e.target.value;
    if (v === "auto") { fpsAuto = true; fpsDetected = false; detectFps(); }
    else { fpsAuto = false; fps = Number(v) || 24; }
    updateTC();
  });

  video.addEventListener("loadedmetadata", () => { duration = video.duration || 0; updateTC(); updateScrub(); renderPins(); updateChip(); });
  video.addEventListener("timeupdate", () => {
    updateTC(); updateScrub();
    if (composeTime == null) updateChip();
    const a = activeAt(video.currentTime);
    if (a !== activeId) highlight(a, !video.paused);
  });
  video.addEventListener("progress", updateScrub);
  video.addEventListener("play", () => { setPlayIcon(); detectFps(); });
  video.addEventListener("pause", setPlayIcon);
  video.addEventListener("ended", setPlayIcon);

  textEl().addEventListener("focus", freeze);
  el("cmt-reset").addEventListener("click", () => { composeTime = video.currentTime; markIn = null; markOut = null; updateChip(); textEl().focus(); });
  // Botao de trecho, progressivo: marcar inicio -> marcar fim -> limpar.
  el("cmt-out").addEventListener("click", () => {
    video.pause();
    if (markIn != null && markOut != null) { markIn = null; markOut = null; updateChip(); return; }   // limpar
    if (markIn == null) {                                                                              // marcar inicio
      markIn = video.currentTime; composeTime = null;
      toast(t("cmt.rangeStarted", { from: fmtClock(markIn) }), "ok");
    } else if (video.currentTime > markIn + 0.05) {                                                    // marcar fim
      markOut = video.currentTime;
    } else { toast(t("cmt.rangeEndAfter"), "err"); return; }
    updateChip();
  });
  el("cmt-compose").addEventListener("submit", submit);
  updateChip(); setPlayIcon();
  load();

  // ---- Teclado (nao intercepta quando escrevendo) ---------------------------
  const typing = () => { const a = document.activeElement; return a && (a.tagName === "TEXTAREA" || a.tagName === "INPUT"); };
  const onKey = (e) => {
    if (e.key === "Escape") { if (typing()) { document.activeElement.blur(); return; } close(); return; }
    if (typing()) return;
    switch (e.key) {
      case " ": case "k": case "K": e.preventDefault(); togglePlay(); break;
      case "j": case "J": seek(video.currentTime - 5); break;
      case "l": case "L": seek(video.currentTime + 5); break;
      case "ArrowLeft": e.preventDefault(); frameStep(-1); break;
      case "ArrowRight": e.preventDefault(); frameStep(1); break;
    }
  };

  const close = () => {
    try { video.pause(); } catch {}
    if (document.fullscreenElement) { try { document.exitFullscreen(); } catch {} }
    p.classList.remove("show");
    setTimeout(() => (p.innerHTML = ""), 200);
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("selectionchange", onSelChange);
    cancelAnimationFrame(rafId);
    render(); // atualiza o contador no card
  };
  p.querySelector("[data-close]").addEventListener("click", close);
  p.addEventListener("click", (e) => { if (e.target === p) close(); });
  document.addEventListener("keydown", onKey);
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
      bad.map((x) => `• ${x.filename}: ${x.error === "nenhum video com esse nome" ? t("tr.noMatch") : x.error}`).join("\n"),
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

// ---- Gaveta (mobile) --------------------------------------------------------
const openDrawer = () => $("app").classList.add("open");
const closeDrawer = () => $("app").classList.remove("open");

// ---- Ligações ---------------------------------------------------------------
$("auth-card").addEventListener("submit", submitAuth);
$("logout").addEventListener("click", logout);
$("new-proj").addEventListener("click", novoProjeto);
$("nav-devices").addEventListener("click", () => { current = DEVICES_VIEW; closeDrawer(); render(); });
$("nav-library").addEventListener("click", () => { current = LIBRARY_VIEW; closeDrawer(); render(); });
$("tr-import").addEventListener("click", () => $("tr-import-file").click());
$("tr-import-file").addEventListener("change", (e) => { const fs = e.target.files; importarTranscricoes(fs).finally(() => { e.target.value = ""; }); });
$("menu").addEventListener("click", openDrawer);
$("scrim").addEventListener("click", closeDrawer);

// PWA: registra o service worker (instalavel + funciona offline)
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}

init();
