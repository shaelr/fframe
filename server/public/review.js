"use strict";
// Pagina de revisao (estilo Frame.io): player proprio com capitulos (marcadores
// do Resolve), pins de comentario, timecode, passo por frame, volume, e o painel
// lateral Capitulos | Comentarios | Transcricao.
//
// Usada pelo admin (/v/<id>) e pelo cliente do link de compartilhamento
// (/s/<token>/v/<id>). O que cada um pode fazer vem de `ctx` — e o SERVIDOR
// confere tudo de novo; esconder botao aqui e so interface.
//
// Review.open(root, ctx) -> { close() }
//   ctx = { id, name, admin, call(method, url, body) -> Response,
//           urls: { media, download, comments, chapters, transcript, edl },
//           canComment, showTranscript, guest: { name } | null,
//           backLabel, onBack(), onGuestRename() }
// Usa os utilitarios globais do app.js (t, escapeHtml, toast, confirmModal,
// fmtClock, fmtTC, fpsModal, trMenuModal, edlModal).

const ICONS = {
  play: '<path d="M8 5.5v13l11-6.5z" fill="currentColor"/>',
  pause: '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor"/>',
  frameBack: '<path d="M6.5 6h2v12h-2zM18 6.5v11L10 12z" fill="currentColor"/>',
  frameFwd: '<path d="M15.5 6h2v12h-2zM6 6.5v11L14 12z" fill="currentColor"/>',
  chapPrev: '<path d="M5 6h2v12H5zM13 6.5v11L7.5 12zM19.5 6.5v11L14 12z" fill="currentColor"/>',
  chapNext: '<path d="M17 6h2v12h-2zM11 6.5v11L16.5 12zM4.5 6.5v11L10 12z" fill="currentColor"/>',
  vol: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a7.6 7.6 0 0 1 0 11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  volLow: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  mute: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor"/><path d="M15.5 9.5l5 5M20.5 9.5l-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  fs: '<path d="M4.5 9V4.5H9M15 4.5h4.5V9M19.5 15v4.5H15M9 19.5H4.5V15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
};
// Cores dos marcadores do Resolve (o app.css define .mk-<Cor>; a CSP nao deixa style="" inline)
const MK_COLORS = ["Blue", "Cyan", "Green", "Yellow", "Red", "Pink", "Purple", "Fuchsia", "Rose",
  "Lavender", "Sky", "Mint", "Lemon", "Sand", "Cocoa", "Cream"];
const icon = (name) => `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">${ICONS[name]}</svg>`;

const Review = {
  open(root, ctx) {
    const { id, name, admin, urls } = ctx;
    const call = ctx.call;
    const canComment = !!ctx.canComment;
    const showTr = !!ctx.showTranscript;

    root.innerHTML =
      `<div class="rv">
        <header class="rv-top">
          <button class="rv-back" type="button" id="rv-back">← <span>${escapeHtml(ctx.backLabel || t("rv.back"))}</span></button>
          <div class="rv-title" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
          <div class="rv-acts">
            ${urls.download ? `<a class="rv-act" id="rv-dl" href="${escapeHtml(urls.download)}">⤓ ${escapeHtml(t("card.download"))}</a>` : ""}
            ${admin && urls.edl ? `<button class="rv-act" type="button" id="pv-edl" title="${escapeHtml(t("edl.title"))}">⤓ ${escapeHtml(t("edl.btn"))}</button>` : ""}
          </div>
        </header>
        <div class="rv-body">
          <div class="rv-main">
            <div class="pv" id="pv">
              <div class="pv-stage" id="pv-stage">
                <video class="player-video" src="${escapeHtml(urls.media)}" playsinline preload="metadata"></video>
                <button class="pv-bigplay" id="pv-bigplay" type="button" aria-label="${escapeHtml(t("pv.play"))}">${icon("play")}</button>
              </div>
              <div class="pv-ctl">
                <div class="pv-scrub" id="pv-scrub">
                  <div class="pv-track">
                    <div class="pv-buffered" id="pv-buffered"></div>
                    <div class="pv-progress" id="pv-progress"></div>
                    <div class="pv-chaps" id="pv-chaps"></div>
                    <div class="pv-pins" id="pv-pins"></div>
                    <div class="pv-head" id="pv-head"></div>
                  </div>
                </div>
                <div class="pv-btns">
                  <button class="pv-b" id="pv-play" type="button" aria-label="${escapeHtml(t("pv.play"))}">${icon("play")}</button>
                  <button class="pv-b pv-chapbtn" id="pv-cprev" type="button" title="${escapeHtml(t("ch.prev"))}" aria-label="${escapeHtml(t("ch.prev"))}" hidden>${icon("chapPrev")}</button>
                  <button class="pv-b" id="pv-fb" type="button" title="${escapeHtml(t("pv.frameBack"))}" aria-label="${escapeHtml(t("pv.frameBack"))}">${icon("frameBack")}</button>
                  <button class="pv-b" id="pv-ff" type="button" title="${escapeHtml(t("pv.frameFwd"))}" aria-label="${escapeHtml(t("pv.frameFwd"))}">${icon("frameFwd")}</button>
                  <button class="pv-b pv-chapbtn" id="pv-cnext" type="button" title="${escapeHtml(t("ch.next"))}" aria-label="${escapeHtml(t("ch.next"))}" hidden>${icon("chapNext")}</button>
                  <span class="pv-tc" id="pv-tc" title="${escapeHtml(t("pv.shortcuts"))}">00:00:00:00</span>
                  <span class="pv-dur" id="pv-dur">/ 00:00:00:00</span>
                  <span class="pv-chapname" id="pv-chapname"></span>
                  <span class="pv-spacer"></span>
                  <div class="pv-vol" id="pv-vol">
                    <div class="pv-vol-pop"><input class="pv-volr" id="pv-volr" type="range" min="0" max="1" step="0.01" aria-label="${escapeHtml(t("pv.volume"))}" /></div>
                    <button class="pv-b" id="pv-mute" type="button" aria-label="${escapeHtml(t("pv.mute"))}" title="${escapeHtml(t("pv.mute"))}">${icon("vol")}</button>
                  </div>
                  <button class="pv-b" id="pv-fs" type="button" aria-label="${escapeHtml(t("pv.fullscreen"))}" title="${escapeHtml(t("pv.fullscreen"))}">${icon("fs")}</button>
                </div>
              </div>
            </div>
          </div>
          <aside class="player-side">
            <div class="side-tabs" role="tablist">
              <button class="side-tab" type="button" role="tab" data-tab="ch" hidden>${escapeHtml(t("ch.title"))} <span class="cmt-n" id="ch-n">0</span></button>
              <button class="side-tab" type="button" role="tab" data-tab="cmt">${escapeHtml(t("cmt.title"))} <span class="cmt-n" id="cmt-n">0</span></button>
              <button class="side-tab" type="button" role="tab" data-tab="tr" hidden>${escapeHtml(t("tr.title"))} <span class="tr-dot" id="tr-dot" hidden></span></button>
            </div>
            <div class="side-pane" id="pane-ch" hidden><div class="ch-list" id="ch-list"></div></div>
            <div class="side-pane tr-pane" id="pane-tr" hidden>
              <div class="tr-tools">
                <input id="tr-search" class="fld tr-search" type="search" placeholder="${escapeHtml(t("tr.search"))}" autocomplete="off" />
                <span class="tr-hits" id="tr-hits"></span>
                <button class="tr-tool" id="tr-follow" type="button" aria-pressed="true" title="${escapeHtml(t("tr.follow.title"))}">${escapeHtml(t("tr.follow"))}</button>
                ${admin ? `<button class="tr-tool" id="tr-menu" type="button" aria-label="${escapeHtml(t("tr.menu"))}" title="${escapeHtml(t("tr.menu"))}">⋯</button>` : ""}
              </div>
              <div class="tr-body" id="tr-body"></div>
              <button class="tr-sel" id="tr-sel" type="button" hidden>💬 ${escapeHtml(t("tr.commentSel"))}</button>
              ${admin ? `<input id="tr-file" type="file" accept=".srt,.vtt,.txt,.json,text/plain,application/json" hidden />` : ""}
            </div>
            <div class="side-pane" id="pane-cmt">
              <div class="cmt-list" id="cmt-list"></div>
              ${canComment ? `<form class="cmt-compose" id="cmt-compose" autocomplete="off">
                ${ctx.guest ? `<div class="cmt-as">${escapeHtml(t("share.as", { name: ctx.guest.name }))} · <button type="button" class="linkbtn" id="cmt-rename">${escapeHtml(t("share.change"))}</button></div>` : ""}
                <div class="cmt-when">
                  <span class="chip" id="cmt-chip"></span>
                  <button type="button" class="cmt-reset" id="cmt-reset" hidden>↺ ${escapeHtml(t("cmt.now"))}</button>
                  <button type="button" class="cmt-out" id="cmt-out">${escapeHtml(t("cmt.markIn"))}</button>
                </div>
                <textarea id="cmt-text" rows="2"></textarea>
                <button class="btn-primary" id="cmt-send" type="submit">${escapeHtml(t("cmt.send"))}</button>
              </form>` : ""}
            </div>
          </aside>
        </div>
      </div>`;

    const q = (sel) => root.querySelector(sel);
    const el = (i) => root.querySelector("#" + i);
    const video = q("video");
    let comments = [], chapters = [];
    let composeTime = null, markIn = null, markOut = null;   // ponto congelado / trecho in-out
    let duration = 0;
    let fps = 24, fpsDetected = false;                     // fps lido do proprio video
    let activeId = null, replyTo = null, curChap = -1;
    let alive = true;

    const textEl = () => el("cmt-text");
    const seek = (sec) => { try { video.currentTime = Math.max(0, Math.min(duration || sec, sec)); } catch {} };
    const frameStep = (dir) => { video.pause(); seek(video.currentTime + dir / fps); };
    const togglePlay = () => { if (video.paused) video.play().catch(() => {}); else video.pause(); };

    // ---- fps lido dos frames do video (requestVideoFrameCallback) -------------
    function detectFps() {
      if (fpsDetected || !video.requestVideoFrameCallback) return;
      let last = null; const samples = [];
      const cb = (now, meta) => {
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

    // ---- Barra de reproducao --------------------------------------------------
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
      el("pv-play").innerHTML = icon(playing ? "pause" : "play");
      el("pv-play").setAttribute("aria-label", playing ? t("pv.pause") : t("pv.play"));
      el("pv-bigplay").style.display = playing ? "none" : "flex";
    }
    const scrub = el("pv-scrub");
    const seekFromEvent = (clientX) => { const r = scrub.getBoundingClientRect(); seek(Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * duration); };
    let scrubbing = false;
    scrub.addEventListener("pointerdown", (e) => { if (e.target.closest(".pv-pin,.pv-chap")) return; scrubbing = true; try { scrub.setPointerCapture(e.pointerId); } catch {} seekFromEvent(e.clientX); });
    scrub.addEventListener("pointermove", (e) => { if (scrubbing) seekFromEvent(e.clientX); });
    scrub.addEventListener("pointerup", (e) => { scrubbing = false; try { scrub.releasePointerCapture(e.pointerId); } catch {} });

    // ---- Volume: clique = mudo; passar o mouse abre o nivel (toque: abre) ------
    const vol = el("pv-vol"), volr = el("pv-volr");
    const noHover = window.matchMedia && matchMedia("(hover: none)").matches;
    try {
      const v = parseFloat(localStorage.getItem("fframe.vol"));
      if (v >= 0 && v <= 1) video.volume = v;
      video.muted = localStorage.getItem("fframe.muted") === "1";
    } catch {}
    function setVolIcon() {
      const v = video.muted ? 0 : video.volume;
      el("pv-mute").innerHTML = icon(v === 0 ? "mute" : v < 0.5 ? "volLow" : "vol");
      volr.value = String(v);
      volr.style.setProperty("--v", (v * 100).toFixed(0) + "%");
    }
    el("pv-mute").addEventListener("click", () => {
      if (noHover && !vol.classList.contains("open")) { vol.classList.add("open"); return; }
      if (video.muted || video.volume === 0) { video.muted = false; if (video.volume === 0) video.volume = 0.5; }
      else video.muted = true;
    });
    volr.addEventListener("input", () => { video.volume = parseFloat(volr.value); video.muted = video.volume === 0; });
    video.addEventListener("volumechange", () => {
      setVolIcon();
      try { localStorage.setItem("fframe.vol", String(video.volume)); localStorage.setItem("fframe.muted", video.muted ? "1" : "0"); } catch {}
    });
    const closeVol = (e) => { if (!vol.contains(e.target)) vol.classList.remove("open"); };
    document.addEventListener("pointerdown", closeVol);
    setVolIcon();

    // ---- Capitulos (marcadores do Resolve) -------------------------------------
    function chapterAt(time) {
      let i = -1;
      for (let k = 0; k < chapters.length; k++) if (chapters[k].t <= time + 0.05) i = k;
      return i;
    }
    function goChapter(dir) {
      if (!chapters.length) return;
      const now = video.currentTime, i = chapterAt(now);
      let target;
      if (dir < 0) target = i >= 0 && now - chapters[i].t > 1.5 ? i : i - 1;   // 1o volta ao inicio do atual
      else target = i + 1;
      if (target < 0) { seek(0); return; }
      if (target >= chapters.length) return;
      seek(chapters[target].t);
    }
    function renderChapterTicks() {
      const box = el("pv-chaps");
      box.innerHTML = chapters.map((c, i) => `<span class="pv-chap${MK_COLORS.includes(c.color) ? " mk-" + c.color : ""}" data-i="${i}" title="${escapeHtml(fmtClock(c.t) + " · " + c.title)}"></span>`).join("");
      box.querySelectorAll(".pv-chap").forEach((n) => {
        const c = chapters[+n.dataset.i];
        if (duration) n.style.left = (c.t / duration * 100).toFixed(3) + "%";
        n.addEventListener("click", (e) => { e.stopPropagation(); seek(c.t); });
      });
    }
    function renderChapters() {
      const tab = q('.side-tab[data-tab="ch"]');
      tab.hidden = !chapters.length && !admin;
      el("ch-n").textContent = chapters.length;
      el("pv-cprev").hidden = el("pv-cnext").hidden = !chapters.length;
      const list = el("ch-list");
      list.innerHTML = chapters.length
        ? chapters.map((c, i) => `<button class="ch-item${i === curChap ? " now" : ""}" type="button" data-i="${i}">
            <span class="ch-num">${i + 1}</span>
            <span class="ch-main"><span class="ch-title">${escapeHtml(c.title)}</span>${c.note ? `<span class="ch-note">${escapeHtml(c.note)}</span>` : ""}</span>
            <span class="ch-time">${escapeHtml(fmtClock(c.t))}</span>
          </button>`).join("")
        : `<div class="cmt-empty">${escapeHtml(t("ch.empty"))}<br><span>${escapeHtml(t("ch.emptyHint"))}</span></div>`;
      list.querySelectorAll(".ch-item").forEach((b) => b.addEventListener("click", () => { seek(chapters[+b.dataset.i].t); }));
      renderChapterTicks();
      syncChapter(true);
    }
    function syncChapter(force) {
      const i = chapterAt(video.currentTime);
      if (i === curChap && !force) return;
      curChap = i;
      el("pv-chapname").textContent = i >= 0 ? chapters[i].title : "";
      el("pv-chapname").title = i >= 0 ? chapters[i].title : "";
      el("ch-list").querySelectorAll(".ch-item").forEach((b) => {
        const on = +b.dataset.i === i;
        b.classList.toggle("now", on);
        if (on && !el("pane-ch").hidden && !force) b.scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
    }
    async function loadChapters() {
      try { const r = await call("GET", urls.chapters); chapters = r.ok ? await r.json() : []; } catch { chapters = []; }
      chapters.sort((a, b) => a.t - b.t);
      if (alive) renderChapters();
    }

    // ---- Pins de comentario na barra (trecho vira faixa) -----------------------
    function renderPins() {
      const box = el("pv-pins");
      const tops = comments.filter((c) => !c.parent_id);
      box.innerHTML = tops.map((c) =>
        `<span class="pv-pin${c.t_end != null ? " range" : ""}${c.resolved ? " done" : ""}" data-id="${c.id}" title="${escapeHtml(authorLabel(c.author) + ": " + c.text)}"></span>`).join("");
      box.querySelectorAll(".pv-pin").forEach((pin) => {
        const c = tops.find((x) => x.id === pin.dataset.id);
        if (!duration || !c) return;
        pin.style.left = (c.t / duration * 100).toFixed(3) + "%";
        if (c.t_end != null) pin.style.width = Math.max(0.6, (c.t_end - c.t) / duration * 100).toFixed(3) + "%";
        pin.classList.toggle("active", c.id === activeId);
        pin.addEventListener("click", (e) => { e.stopPropagation(); seek(c.t); setTab("cmt"); highlight(c.id, true); });
      });
    }
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

    // ---- Compose: ponto (padrao) ou trecho (marcar inicio -> fim) --------------
    function updateChip() {
      if (!canComment) return;
      const out = el("cmt-out");
      if (markIn != null && markOut != null) {
        el("cmt-chip").textContent = t("cmt.range", { from: fmtClock(markIn), to: fmtClock(markOut) });
        out.textContent = t("cmt.clearOut");
        textEl().placeholder = t("cmt.placeholder", { time: fmtClock(markIn) });
      } else if (markIn != null) {
        el("cmt-chip").textContent = t("cmt.rangeStart", { from: fmtClock(markIn) });
        out.textContent = t("cmt.markOut");
        textEl().placeholder = t("cmt.placeholder", { time: fmtClock(markIn) });
      } else {
        const inT = composeTime != null ? composeTime : video.currentTime;
        el("cmt-chip").textContent = t("cmt.at", { time: fmtClock(inT) });
        out.textContent = t("cmt.markIn");
        textEl().placeholder = t("cmt.placeholder", { time: fmtClock(inT) });
      }
      el("cmt-reset").hidden = !(composeTime != null && markIn == null);
    }
    function freeze() { if (composeTime == null && markIn == null) { composeTime = video.currentTime; video.pause(); updateChip(); } }
    function unfreeze() { composeTime = null; markIn = null; markOut = null; updateChip(); }

    // ---- Lista de comentarios (threads + trecho) -------------------------------
    const canDelete = (c) => admin || !!c.mine;
    const guestTag = (c) => (admin && c.guest ? ` <span class="cmt-guest">${escapeHtml(t("cmt.guest"))}</span>` : "");
    function renderList() {
      const tops = comments.filter((c) => !c.parent_id).sort((a, b) => a.t - b.t);
      const repliesOf = (pid) => comments.filter((c) => c.parent_id === pid).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      el("cmt-n").textContent = comments.length;
      const list = el("cmt-list");
      if (!tops.length) {
        list.innerHTML = `<div class="cmt-empty">${escapeHtml(t("cmt.empty"))}${canComment ? `<br><span>${escapeHtml(t("cmt.emptyHint"))}</span>` : ""}</div>`;
        return;
      }
      const timeLabel = (c) => c.t_end != null ? t("cmt.range", { from: fmtClock(c.t), to: fmtClock(c.t_end) }) : fmtClock(c.t);
      const replyHtml = (r) => `<div class="cmt-reply-item">
          <div class="cmt-top"><span class="cmt-auth">${escapeHtml(authorLabel(r.author))}${guestTag(r)}</span></div>
          <div class="cmt-body">${escapeHtml(r.text)}</div>
          ${canDelete(r) ? `<div class="cmt-acts"><button class="cmt-act danger" type="button" data-del="${r.id}">${escapeHtml(t("cmt.delete"))}</button></div>` : ""}
        </div>`;
      list.innerHTML = tops.map((c) => {
        const reps = repliesOf(c.id);
        const acts = [
          canComment ? `<button class="cmt-act" type="button" data-reply="${c.id}">${escapeHtml(t("cmt.reply"))}</button>` : "",
          admin ? `<button class="cmt-act" type="button" data-resolve="${c.id}" data-on="${c.resolved ? 1 : 0}">${escapeHtml(c.resolved ? t("cmt.reopen") : t("cmt.resolve"))}</button>` : "",
          canDelete(c) ? `<button class="cmt-act danger" type="button" data-del="${c.id}">${escapeHtml(t("cmt.delete"))}</button>` : "",
        ].join("");
        return `<div class="cmt-item${c.resolved ? " done" : ""}${c.id === activeId ? " active" : ""}" data-id="${c.id}">
          <div class="cmt-top">
            <button class="cmt-time" type="button" data-seek="${c.t}" title="${escapeHtml(t("cmt.jump", { time: fmtClock(c.t) }))}">${escapeHtml(timeLabel(c))}</button>
            <span class="cmt-auth">${escapeHtml(authorLabel(c.author))}${guestTag(c)}</span>
            ${c.resolved && !admin ? `<span class="cmt-done-tag">${escapeHtml(t("cmt.resolvedTag"))}</span>` : ""}
          </div>
          <div class="cmt-body">${escapeHtml(c.text)}</div>
          ${acts ? `<div class="cmt-acts">${acts}</div>` : ""}
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
    async function loadComments() {
      try { const r = await call("GET", urls.comments); comments = r.ok ? await r.json() : []; } catch { comments = []; }
      if (alive) { renderList(); renderPins(); }
    }
    async function toggleResolve(cid, resolved) {
      await call("PATCH", `${urls.comments}/${cid}`, { resolved });
      const c = comments.find((x) => x.id === cid); if (c) c.resolved = resolved;
      renderList(); renderPins();
    }
    async function delComment(cid) {
      if (!(await confirmModal(t("cmt.delete.confirm"), t("cmt.delete"), true))) return;
      const r = await call("DELETE", `${urls.comments}/${cid}`);
      if (!r.ok) { toast(t("cmt.delete.fail"), "err"); return; }
      comments = comments.filter((x) => x.id !== cid && x.parent_id !== cid);
      renderList(); renderPins(); toast(t("cmt.deleted"), "ok");
    }
    const withName = (body) => (ctx.guest ? { ...body, name: ctx.guest.name } : body);
    async function submit(ev) {
      ev.preventDefault();
      const text = textEl().value.trim();
      if (!text) return;
      let body;
      if (markIn != null && markOut != null && markOut > markIn + 0.05) body = { t: markIn, t_end: markOut, text };
      else body = { t: (composeTime != null ? composeTime : video.currentTime), text };
      const btn = el("cmt-send"); btn.disabled = true; btn.textContent = t("cmt.sending");
      try {
        const r = await call("POST", urls.comments, withName(body));
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
      const r = await call("POST", urls.comments, withName({ parent_id: parentId, text }));
      const c = await r.json().catch(() => null);
      if (!r.ok || !c || !c.id) { toast(t("cmt.add.fail"), "err"); return; }
      comments.push(c); replyTo = null;
      renderList(); renderPins();
    }

    // ---- Abas -------------------------------------------------------------------
    function setTab(tab, remember) {
      const btn = q(`.side-tab[data-tab="${tab}"]`);
      if (!btn || btn.hidden) tab = "cmt";
      root.querySelectorAll(".side-tab").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
      el("pane-ch").hidden = tab !== "ch";
      el("pane-cmt").hidden = tab !== "cmt";
      el("pane-tr").hidden = tab !== "tr";
      if (remember) { try { localStorage.setItem("fframe.sideTab", tab); } catch {} }
      if (tab === "ch") syncChapter(true);
    }
    root.querySelectorAll(".side-tab").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab, true)));

    // ---- Transcricao (estilo Resolve): clicar numa palavra leva ate ela ----------
    let tr = null, flat = [], curWord = -1;
    let follow = true, userScrollAt = 0, rafId = 0;
    let hits = [], hitIdx = -1;
    const trBody = el("tr-body");
    function renderTranscript() {
      flat = []; curWord = -1; hits = []; hitIdx = -1; el("tr-hits").textContent = "";
      el("tr-dot").hidden = !tr;
      q('.side-tab[data-tab="tr"]').hidden = !showTr || (!tr && !admin);
      if (!tr) {
        trBody.innerHTML = `<div class="cmt-empty">${escapeHtml(t("tr.empty"))}${admin ? `<br><span>${escapeHtml(t("tr.emptyHint"))}</span><br>
          <button class="btn-primary tr-upload" type="button" data-trupload>${escapeHtml(t("tr.upload"))}</button>` : ""}</div>`;
        const up = trBody.querySelector("[data-trupload]");
        if (up) up.addEventListener("click", () => el("tr-file").click());
        return;
      }
      let prevSpeaker = null;
      trBody.innerHTML = tr.segments.map((s, si) => {
        const showSpk = s.speaker && s.speaker !== prevSpeaker; prevSpeaker = s.speaker || prevSpeaker;
        return `<div class="tr-seg" data-si="${si}">
          <div class="tr-meta"><button class="cmt-time" type="button" data-tseek="${s.t}">${escapeHtml(fmtClock(s.t))}</button>${showSpk ? `<span class="tr-spk">${escapeHtml(s.speaker)}</span>` : ""}</div>
          <p class="tr-p">${s.words.map((w, wi) => `<span class="w" data-si="${si}" data-wi="${wi}">${escapeHtml(w[2])}</span>`).join(" ")}</p>
        </div>`;
      }).join("") + (tr.approx && admin ? `<p class="tr-note">${escapeHtml(t("tr.approxNote"))}</p>` : "");
      trBody.querySelectorAll(".w").forEach((node) => {
        const w = tr.segments[+node.dataset.si].words[+node.dataset.wi];
        flat.push({ t: w[0], end: w[1], el: node });
      });
      flat.sort((a, b) => a.t - b.t);
      syncWord(true);
    }
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
      w.el.closest(".tr-seg").classList.add("now");
      if (follow && !el("pane-tr").hidden && Date.now() - userScrollAt > 3000) {
        const br = trBody.getBoundingClientRect(), wr = w.el.getBoundingClientRect();
        if (wr.top < br.top + 40 || wr.bottom > br.bottom - 40) {
          trBody.scrollTo({ top: trBody.scrollTop + (wr.top - br.top) - br.height / 3, behavior: video.paused ? "auto" : "smooth" });
        }
      }
    }
    const loop = () => { syncWord(false); syncChapter(false); if (alive && !video.paused) rafId = requestAnimationFrame(loop); };
    video.addEventListener("play", () => { cancelAnimationFrame(rafId); rafId = requestAnimationFrame(loop); });
    video.addEventListener("seeked", () => { syncWord(false); syncChapter(false); });
    ["wheel", "touchmove"].forEach((ev) => trBody.addEventListener(ev, () => { userScrollAt = Date.now(); }, { passive: true }));
    trBody.addEventListener("click", (e) => {
      const tb = e.target.closest("[data-tseek]");
      if (tb) { seek(parseFloat(tb.dataset.tseek)); userScrollAt = 0; return; }
      const node = e.target.closest(".w");
      if (!node) return;
      const sel = getSelection();
      if (sel && !sel.isCollapsed && trBody.contains(sel.anchorNode)) return;
      seek(tr.segments[+node.dataset.si].words[+node.dataset.wi][0]); userScrollAt = 0;
    });
    el("tr-follow").addEventListener("click", () => {
      follow = !follow; userScrollAt = 0;
      el("tr-follow").setAttribute("aria-pressed", String(follow));
      if (follow) syncWord(true);
    });
    function runSearch() {
      const query = el("tr-search").value.trim().toLowerCase();
      trBody.querySelectorAll(".w.hit").forEach((n) => n.classList.remove("hit", "hit-cur"));
      hits = []; hitIdx = -1;
      if (!query || !flat.length) { el("tr-hits").textContent = ""; return; }
      const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}' ]/gu, "");
      const qs = norm(query).split(/\s+/).filter(Boolean);
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
    el("tr-search").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); nextHit(e.shiftKey ? -1 : 1); } });

    // Selecionar texto -> "comentar trecho" (marca in/out).
    function selectionRange() {
      const sel = getSelection();
      if (!sel || sel.isCollapsed || !trBody.contains(sel.anchorNode) || !trBody.contains(sel.focusNode)) return null;
      const nodes = Array.from(trBody.querySelectorAll(".w")).filter((n) => sel.containsNode(n, true));
      if (!nodes.length) return null;
      const ws = nodes.map((n) => tr.segments[+n.dataset.si].words[+n.dataset.wi]);
      return { t: Math.min(...ws.map((w) => w[0])), end: Math.max(...ws.map((w) => w[1])), text: nodes.map((n) => n.textContent).join(" ") };
    }
    function onSelChange() {
      el("tr-sel").hidden = !(canComment && !el("pane-tr").hidden && selectionRange());
    }
    document.addEventListener("selectionchange", onSelChange);
    el("tr-sel").addEventListener("mousedown", (e) => e.preventDefault());
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

    // Admin: enviar / trocar / ajustar / remover a transcricao.
    if (admin) {
      const needsFps = (n) => /\.(txt|json)$/i.test(n || "");
      const uploadTranscript = async (file) => {
        if (!file) return;
        if (file.size > 30 * 1024 * 1024) { toast(t("tr.tooBig"), "err"); return; }
        let f = null;
        if (needsFps(file.name)) { f = await fpsModal(); if (f == null) return; }
        const content = await file.text();
        const r = await call("PUT", urls.transcript, { filename: file.name, content, fps: f });
        const d = await r.json().catch(() => null);
        if (!r.ok || !d) { toast((d && d.error) || t("tr.uploadFail"), "err"); return; }
        if (d.markers) await loadChapters();
        if (d.transcript) { tr = d.transcript; renderTranscript(); setTab("tr"); }
        else if (d.markers) setTab("ch");
        const parts = [];
        if (d.transcript) parts.push(t("tr.uploaded", { n: d.transcript.segments.length }));
        if (d.markers) parts.push(t("ch.imported", { n: d.markers }));
        toast(parts.join(" ") || t("tr.uploadFail"), parts.length ? "ok" : "err");
      };
      el("tr-file").addEventListener("change", (e) => { const f = e.target.files[0]; e.target.value = ""; uploadTranscript(f); });
      el("tr-menu").addEventListener("click", async () => {
        const act = await trMenuModal(tr);
        if (!act) return;
        if (act === "upload") el("tr-file").click();
        else if (act === "remove") {
          if (!(await confirmModal(t("tr.remove.confirm"), t("tr.remove"), true))) return;
          const r = await call("DELETE", urls.transcript);
          if (r.ok) { tr = null; renderTranscript(); toast(t("tr.removed"), "ok"); }
        } else if (act.fps != null || act.offset != null) {
          const r = await call("PATCH", urls.transcript, act);
          const d = await r.json().catch(() => null);
          if (r.ok && d && d.segments) { tr = d; renderTranscript(); toast(t("tr.updated"), "ok"); }
          else toast(t("tr.uploadFail"), "err");
        }
      });
      if (urls.edl) el("pv-edl").addEventListener("click", async () => {
        const opt = await edlModal();
        if (!opt) return;
        const a = document.createElement("a");
        a.href = `${urls.edl}?fps=${encodeURIComponent(opt.fps)}&start=${encodeURIComponent(opt.start)}`;
        a.download = ""; document.body.appendChild(a); a.click(); a.remove();
      });
    }
    async function loadTranscript() {
      if (!showTr) { tr = null; renderTranscript(); return; }
      try { const r = await call("GET", urls.transcript); tr = r.ok ? await r.json() : null; } catch { tr = null; }
      if (alive) renderTranscript();
    }

    // ---- Ligacoes ---------------------------------------------------------------
    el("rv-back").addEventListener("click", () => ctx.onBack && ctx.onBack());
    el("pv-play").addEventListener("click", togglePlay);
    el("pv-bigplay").addEventListener("click", togglePlay);
    video.addEventListener("click", togglePlay);
    el("pv-fb").addEventListener("click", () => frameStep(-1));
    el("pv-ff").addEventListener("click", () => frameStep(1));
    el("pv-cprev").addEventListener("click", () => goChapter(-1));
    el("pv-cnext").addEventListener("click", () => goChapter(1));
    el("pv-fs").addEventListener("click", () => { if (document.fullscreenElement) document.exitFullscreen(); else el("pv").requestFullscreen && el("pv").requestFullscreen(); });
    video.addEventListener("loadedmetadata", () => { duration = video.duration || 0; updateTC(); updateScrub(); renderPins(); renderChapterTicks(); updateChip(); });
    video.addEventListener("timeupdate", () => {
      updateTC(); updateScrub(); syncWord(false); syncChapter(false);
      if (composeTime == null) updateChip();
      const a = activeAt(video.currentTime);
      if (a !== activeId) highlight(a, !video.paused);
    });
    video.addEventListener("progress", updateScrub);
    video.addEventListener("play", () => { setPlayIcon(); detectFps(); });
    video.addEventListener("pause", setPlayIcon);
    video.addEventListener("ended", setPlayIcon);
    if (canComment) {
      textEl().addEventListener("focus", freeze);
      el("cmt-reset").addEventListener("click", () => { composeTime = video.currentTime; markIn = null; markOut = null; updateChip(); textEl().focus(); });
      el("cmt-out").addEventListener("click", () => {
        video.pause();
        if (markIn != null && markOut != null) { markIn = null; markOut = null; updateChip(); return; }
        if (markIn == null) { markIn = video.currentTime; composeTime = null; toast(t("cmt.rangeStarted", { from: fmtClock(markIn) }), "ok"); }
        else if (video.currentTime > markIn + 0.05) markOut = video.currentTime;
        else { toast(t("cmt.rangeEndAfter"), "err"); return; }
        updateChip();
      });
      el("cmt-compose").addEventListener("submit", submit);
      const rn = el("cmt-rename");
      if (rn) rn.addEventListener("click", () => ctx.onGuestRename && ctx.onGuestRename());
    }
    updateChip(); setPlayIcon();

    // ---- Teclado (nao intercepta quando escrevendo) ----------------------------
    const typing = () => { const a = document.activeElement; return a && (a.tagName === "TEXTAREA" || a.tagName === "INPUT" || a.tagName === "SELECT"); };
    const onKey = (e) => {
      if (document.querySelector("#modal.show")) return;
      if (e.key === "Escape") { if (typing()) document.activeElement.blur(); return; }
      if (typing() || e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case " ": case "k": case "K": e.preventDefault(); togglePlay(); break;
        case "j": case "J": seek(video.currentTime - 5); break;
        case "l": case "L": seek(video.currentTime + 5); break;
        case "ArrowLeft": e.preventDefault(); frameStep(-1); break;
        case "ArrowRight": e.preventDefault(); frameStep(1); break;
        case "ArrowUp": e.preventDefault(); goChapter(-1); break;      // como os marcadores no Resolve
        case "ArrowDown": e.preventDefault(); goChapter(1); break;
        case "m": case "M": el("pv-mute").click(); break;
        case "f": case "F": el("pv-fs").click(); break;
      }
    };
    document.addEventListener("keydown", onKey);

    // ---- Carrega os dados; aba inicial: a ultima escolhida, senao Capitulos ----
    Promise.all([loadChapters(), loadComments(), loadTranscript()]).then(() => {
      if (!alive) return;
      let saved = null; try { saved = localStorage.getItem("fframe.sideTab"); } catch {}
      const visible = (tab) => { const b = q(`.side-tab[data-tab="${tab}"]`); return b && !b.hidden; };
      setTab(saved && visible(saved) ? saved : chapters.length ? "ch" : "cmt");
    });
    setTab("cmt");

    return {
      close() {
        alive = false;
        try { video.pause(); video.removeAttribute("src"); video.load(); } catch {}
        if (document.fullscreenElement) { try { document.exitFullscreen(); } catch {} }
        document.removeEventListener("keydown", onKey);
        document.removeEventListener("selectionchange", onSelChange);
        document.removeEventListener("pointerdown", closeVol);
        cancelAnimationFrame(rafId);
        root.innerHTML = "";
      },
    };
  },
};
window.Review = Review;
