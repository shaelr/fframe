// notify.js — notificacoes de atividade dos clientes (estilo Frame.io).
//
// Eventos vindos do link de compartilhamento (comentario, resposta, download,
// video aberto, projeto aberto) viram notificacoes no painel do admin e,
// conforme a configuracao, um e-mail (na hora, agrupado; resumo de hora em
// hora; ou resumo diario). As notificacoes do navegador sao ligadas por
// navegador: com Web Push (lib/push.js) chegam mesmo com o Fframe fechado; sem
// push, o painel aberto consulta /_api/notifications e mostra ele mesmo.
//
// data/notifications.json  -> [{ id, at, type, project_id, project_name, asset_id,
//                                asset_name, actor, text, t, comment_id, read, emailed }]
// data/notify.json         -> configuracao (inclui a senha SMTP: nunca vai pro navegador)

const fs = require("fs");
const path = require("path");
const store = require("./store");
const push = require("./push");
const branding = require("./branding");

const LIST_FILE = path.join(store.DATA_DIR, "notifications.json");
const SETTINGS_FILE = path.join(store.DATA_DIR, "notify.json");
const MAX_ITEMS = 1000;

const TYPES = ["comment", "reply", "download", "view", "visit"];
const DEFAULTS = {
  events: {
    comment: { app: true, email: true },
    reply: { app: true, email: true },
    download: { app: true, email: false },
    view: { app: true, email: false },
    visit: { app: false, email: false },
  },
  email: {
    enabled: false, to: "", mode: "instant", daily_hour: 9,
    smtp: { host: "", port: 587, secure: false, user: "", pass: "", from: "" },
  },
};

// ---- Persistencia -------------------------------------------------------------
const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fallback; } };
const writePrivate = (f, data) => {
  const s = JSON.stringify(data, null, 2);
  try { fs.writeFileSync(f, s, { mode: 0o600 }); } catch { fs.writeFileSync(f, s); }
};
let items = readJson(LIST_FILE, []);
if (!Array.isArray(items)) items = [];
const persist = () => fs.writeFileSync(LIST_FILE, JSON.stringify(items));

function loadSettings() {
  const s = readJson(SETTINGS_FILE, {});
  const ev = {};
  for (const k of TYPES) ev[k] = { ...DEFAULTS.events[k], ...((s.events || {})[k] || {}) };
  const em = { ...DEFAULTS.email, ...(s.email || {}) };
  em.smtp = { ...DEFAULTS.email.smtp, ...((s.email || {}).smtp || {}) };
  return { events: ev, email: em, state: s.state || {} };
}
let settings = loadSettings();
const saveSettings = () => writePrivate(SETTINGS_FILE, settings);

// Configuracao como vai pro navegador: a senha SMTP so diz se existe.
function publicSettings() {
  const { pass, ...smtp } = settings.email.smtp;
  return { events: settings.events, email: { ...settings.email, smtp: { ...smtp, has_pass: !!pass } }, types: TYPES };
}
function updateSettings(patch) {
  patch = patch || {};
  if (patch.events) for (const k of TYPES) {
    const e = patch.events[k];
    if (e) for (const ch of ["app", "email"]) if (ch in e) settings.events[k][ch] = !!e[ch];
  }
  if (patch.email) {
    const e = patch.email, em = settings.email;
    if ("enabled" in e) em.enabled = !!e.enabled;
    if ("to" in e) em.to = String(e.to || "").slice(0, 500);
    if ("mode" in e && ["instant", "hourly", "daily"].includes(e.mode)) em.mode = e.mode;
    if ("daily_hour" in e) em.daily_hour = Math.max(0, Math.min(23, parseInt(e.daily_hour, 10) || 0));
    if (e.smtp) {
      const s = e.smtp;
      for (const k of ["host", "user", "from"]) if (k in s) em.smtp[k] = String(s[k] || "").trim().slice(0, 300);
      if ("port" in s) em.smtp.port = parseInt(s.port, 10) || 587;
      if ("secure" in s) em.smtp.secure = !!s.secure;
      if (typeof s.pass === "string" && s.pass !== "") em.smtp.pass = s.pass;      // vazio = mantem a atual
      if (s.clear_pass) em.smtp.pass = "";
    }
    // Ligar o e-mail agora nao manda o historico antigo.
    if (e.enabled && !settings.state.email_since) settings.state.email_since = new Date().toISOString();
    if ("enabled" in e && !e.enabled) settings.state.email_since = null;
  }
  saveSettings();
  return publicSettings();
}

// ---- Eventos ------------------------------------------------------------------
// Visualizacoes/aberturas repetidas do mesmo cliente nao viram varias notificacoes.
const recent = new Map();
function seenRecently(key, ms) {
  const now = Date.now(), last = recent.get(key);
  recent.set(key, now);
  if (recent.size > 5000) for (const [k, v] of recent) if (now - v > 24 * 3600e3) recent.delete(k);
  return last && now - last < ms;
}

/** Registra um evento de cliente. `dedupe` = chave para nao repetir (visualizacoes). */
function record(ev) {
  if (!TYPES.includes(ev.type)) return null;
  const conf = settings.events[ev.type];
  if (!conf.app && !conf.email) return null;
  if (ev.dedupe && seenRecently(ev.dedupe, 6 * 3600e3)) return null;
  const n = {
    id: store.uuid(), at: new Date().toISOString(), type: ev.type,
    project_id: ev.project_id || null, project_name: ev.project_name || "",
    asset_id: ev.asset_id || null, asset_name: ev.asset_name || "",
    actor: String(ev.actor || "Someone").slice(0, 60),
    text: ev.text ? String(ev.text).slice(0, 400) : null,
    t: ev.t != null && Number.isFinite(Number(ev.t)) ? Number(ev.t) : null,
    comment_id: ev.comment_id || null, kind: ev.kind || null,
    app: !!conf.app, read: !conf.app, emailed: !conf.email,
  };
  items.push(n);
  if (items.length > MAX_ITEMS) items = items.slice(-MAX_ITEMS);
  persist();
  if (conf.app) pushOut(n);
  return n;
}

// Push para os navegadores inscritos (mesmo texto e link do sino).
function pushOut(n) {
  const l = line(n);
  const what = l.startsWith(n.actor + " ") ? l.slice(n.actor.length + 1) : l;
  const body = what.charAt(0).toUpperCase() + what.slice(1) + (n.text ? `\n“${n.text}”` : "");
  const url = n.asset_id && n.type !== "visit" ? linkFor("", n) : "/";
  push.send({ id: n.id, title: `${n.actor} · ${n.project_name || branding.name()}`, body, url, tag: n.id,
    icon: branding.publicInfo().favicon || undefined }).catch(() => {});
}

function list({ limit = 50, before } = {}) {
  let l = items.filter((n) => n.app);
  if (before) l = l.filter((n) => n.at < before);
  l = l.slice(-Math.min(200, limit)).reverse();
  return { items: l.map(({ emailed, app, ...n }) => n), unread: items.filter((n) => n.app && !n.read).length };
}
function markRead({ ids, all }) {
  const set = new Set(ids || []);
  let n = 0;
  for (const it of items) if (!it.read && (all || set.has(it.id))) { it.read = true; n++; }
  if (n) persist();
  return n;
}
// Comentario apagado (pelo cliente ou pelo admin) some das notificacoes.
function forgetComment(commentId) {
  const before = items.length;
  items = items.filter((n) => n.comment_id !== commentId);
  if (items.length !== before) persist();
}

// ---- E-mail -------------------------------------------------------------------
const clock = (sec) => {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : String(m)) + ":" + String(s).padStart(2, "0");
};
const esc = (x) => String(x == null ? "" : x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const VERB = {
  comment: "commented on", reply: "replied on", view: "watched", visit: "opened the project",
  download: "downloaded",
};
function line(n) {
  if (n.type === "visit") return `${n.actor} opened the project ${n.project_name}`;
  if (n.type === "download") return `${n.actor} downloaded ${n.kind === "transcript" ? "the transcript of " : ""}${n.asset_name}`;
  return `${n.actor} ${VERB[n.type]} ${n.asset_name}${n.t != null && (n.type === "comment" || n.type === "reply") ? ` at ${clock(n.t)}` : ""}`;
}
function linkFor(base, n) {
  if (!n.asset_id) return `${base}/`;
  const q = [];
  if (n.t != null) q.push("t=" + n.t.toFixed(2));
  if (n.comment_id) q.push("c=" + encodeURIComponent(n.comment_id));
  return `${base}/v/${encodeURIComponent(n.asset_id)}${q.length ? "?" + q.join("&") : ""}`;
}

/** Monta { subject, text, html } para um grupo de notificacoes. */
function compose(list, base) {
  const brand = branding.publicInfo(), app = brand.name, accent = brand.accent;
  const logo = brand.logo && /^https?:/.test(base) ? base + brand.logo : null;   // imagem precisa de endereco completo
  const byProject = new Map();
  for (const n of list) {
    const k = n.project_name || branding.name();
    (byProject.get(k) || byProject.set(k, []).get(k)).push(n);
  }
  const comments = list.filter((n) => n.type === "comment" || n.type === "reply").length;
  const people = [...new Set(list.map((n) => n.actor))];
  const projects = [...byProject.keys()];
  const subject = list.length === 1
    ? line(list[0])
    : comments
      ? `${comments} new comment${comments === 1 ? "" : "s"} from ${people.slice(0, 2).join(" and ")}${people.length > 2 ? ` and ${people.length - 2} more` : ""} on ${projects.length === 1 ? projects[0] : projects.length + " projects"}`
      : `${list.length} updates on ${projects.length === 1 ? projects[0] : projects.length + " projects"}`;
  let text = "", html = "";
  for (const [proj, ns] of byProject) {
    text += `\n${proj}\n${"-".repeat(proj.length)}\n`;
    html += `<h2 style="font:600 16px Arial,sans-serif;color:#0A0A0B;margin:22px 0 8px">${esc(proj)}</h2>`;
    for (const n of ns) {
      const url = linkFor(base, n);
      text += `- ${line(n)}${n.text ? `\n  "${n.text}"` : ""}\n  ${url}\n`;
      html += `<div style="border:1px solid #E3E3EA;border-radius:10px;padding:12px 14px;margin:0 0 10px">
        <div style="font:13px Arial,sans-serif;color:#555">${esc(line(n))}</div>
        ${n.text ? `<div style="font:15px Arial,sans-serif;color:#111;margin:6px 0 0">${esc(n.text)}</div>` : ""}
        <a href="${esc(url)}" style="display:inline-block;margin-top:8px;font:600 13px Arial,sans-serif;color:${accent};text-decoration:none">Open in ${esc(app)} →</a>
      </div>`;
    }
  }
  html = `<div style="max-width:560px;margin:0 auto;padding:8px 4px">
    ${logo ? `<img src="${esc(logo)}" alt="${esc(app)}" style="display:block;max-height:40px;max-width:220px;border:0" />`
           : `<div style="font:700 15px Arial,sans-serif;color:${accent}">● ${esc(app)}</div>`}
    <div style="font:15px Arial,sans-serif;color:#111;margin-top:10px">${esc(subject)}</div>
    ${html}
    <div style="font:11px Arial,sans-serif;color:#999;margin-top:18px">You get these emails because notifications are turned on in ${esc(app)} (Notifications settings).</div>
  </div>`;
  return { subject: `${app}: ${subject}`, text: `${subject}\n${text}\nNotification settings: ${base}/`, html };
}

let transport = null, transportKey = "";
function getTransport() {
  const s = settings.email.smtp;
  const key = JSON.stringify([s.host, s.port, s.secure, s.user, s.pass]);
  if (!transport || key !== transportKey) {
    const nodemailer = require("nodemailer");
    transport = nodemailer.createTransport({
      host: s.host, port: s.port, secure: !!s.secure,
      auth: s.user ? { user: s.user, pass: s.pass } : undefined,
      connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
    });
    transportKey = key;
  }
  return transport;
}
async function sendMail(msg) {
  const em = settings.email;
  if (!em.smtp.host || !em.to) throw new Error("set the mail server and the address to send to first");
  return getTransport().sendMail({ from: em.smtp.from || em.smtp.user, to: em.to, ...msg });
}

async function sendTest(base) {
  const app = branding.name();
  const sample = [{ type: "comment", actor: "Test client", project_name: app, asset_name: "Sample video.mp4", asset_id: null,
    text: `This is a test notification from ${app}. If you can read this, email notifications work.`, t: 12 }];
  const m = compose(sample, base);
  await sendMail({ ...m, subject: `${app}: test notification` });
}

// Agenda: na hora = espera ~1 min de silencio (agrupa uma rajada de comentarios,
// no maximo 5 min); de hora em hora; ou uma vez por dia na hora escolhida.
let sending = false;
async function tick(base, logFn) {
  const em = settings.email;
  if (!em.enabled || sending) return;
  const since = settings.state.email_since || "";
  const pending = items.filter((n) => !n.emailed && n.at >= since);
  if (!pending.length) return;
  const now = new Date(), newest = new Date(pending[pending.length - 1].at), oldest = new Date(pending[0].at);
  let due = false;
  if (em.mode === "instant") due = now - newest > 60e3 || now - oldest > 5 * 60e3;
  else if (em.mode === "hourly") due = now - new Date(settings.state.last_digest || 0) >= 3600e3 && now.getMinutes() < 5;
  else if (em.mode === "daily") {
    const today = now.toISOString().slice(0, 10);
    due = now.getHours() === em.daily_hour && settings.state.last_daily !== today;
  }
  if (!due) return;
  sending = true;
  try {
    await sendMail(compose(pending, base));
    for (const n of pending) n.emailed = true;
    persist();
    settings.state.last_digest = now.toISOString();
    if (em.mode === "daily") settings.state.last_daily = now.toISOString().slice(0, 10);
    settings.state.last_error = null;
    saveSettings();
    logFn && logFn(`    NOTIFICACAO por e-mail: ${pending.length} item(ns) para ${em.to}`);
  } catch (e) {
    settings.state.last_error = { at: now.toISOString(), message: String(e.message || e).slice(0, 300) };
    saveSettings();
    logFn && logFn(`    ERRO e-mail de notificacao: ${e.message}`);
  } finally { sending = false; }
}
function start(base, logFn) { setInterval(() => tick(base, logFn), 30e3).unref(); }
const lastError = () => settings.state.last_error || null;

module.exports = { TYPES, record, list, markRead, forgetComment, publicSettings, updateSettings, sendTest, start, lastError, compose };
