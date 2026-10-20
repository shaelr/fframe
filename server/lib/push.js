// push.js — Web Push: notificacoes do navegador mesmo com o Fframe fechado.
//
// Cada navegador onde o admin liga "Browser notifications" vira uma inscricao
// (pushManager.subscribe no painel). Quando chega atividade de cliente com o
// canal "app" ligado, o servidor manda um push para todas as inscricoes e o
// service worker (public/sw.js) mostra a notificacao.
//
// data/vapid.json           -> { publicKey, privateKey } (gerado uma vez; a chave
//                               privada nunca vai pro navegador)
// data/push-subs.json       -> [{ endpoint, keys: { p256dh, auth }, ua, created }]

const fs = require("fs");
const path = require("path");
const store = require("./store");

const VAPID_FILE = path.join(store.DATA_DIR, "vapid.json");
const SUBS_FILE = path.join(store.DATA_DIR, "push-subs.json");
const MAX_SUBS = 50;

const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fallback; } };
const writePrivate = (f, data) => {
  const s = JSON.stringify(data, null, 2);
  try { fs.writeFileSync(f, s, { mode: 0o600 }); } catch { fs.writeFileSync(f, s); }
};

let webpush = null, vapid = null, logFn = null;
let subs = readJson(SUBS_FILE, []);
if (!Array.isArray(subs)) subs = [];
const persist = () => writePrivate(SUBS_FILE, subs);

/** Carrega (ou gera na primeira vez) as chaves VAPID. */
function init(base, log) {
  logFn = log || null;
  webpush = require("web-push");
  vapid = readJson(VAPID_FILE, null);
  if (!vapid || !vapid.publicKey || !vapid.privateKey) {
    const k = webpush.generateVAPIDKeys();
    vapid = { publicKey: k.publicKey, privateKey: k.privateKey, created: new Date().toISOString() };
    writePrivate(VAPID_FILE, vapid);
    logFn && logFn("    PUSH: chaves VAPID geradas em data/vapid.json");
  }
  // O "subject" identifica quem manda (os servicos de push usam para contato).
  const subject = process.env.VAPID_SUBJECT || (/^https:\/\//.test(base || "") ? base : "https://github.com/shaelr/fframe");
  webpush.setVapidDetails(subject, vapid.publicKey, vapid.privateKey);
}

const publicKey = () => (vapid ? vapid.publicKey : null);

function valid(sub) {
  return sub && typeof sub.endpoint === "string" && /^https:\/\//.test(sub.endpoint) && sub.endpoint.length < 2000
    && sub.keys && typeof sub.keys.p256dh === "string" && typeof sub.keys.auth === "string";
}

/** Guarda (ou atualiza) a inscricao deste navegador. */
function subscribe(sub, ua) {
  if (!valid(sub)) throw new Error("invalid push subscription");
  const entry = { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    ua: String(ua || "").slice(0, 200), created: new Date().toISOString() };
  const i = subs.findIndex((s) => s.endpoint === sub.endpoint);
  if (i >= 0) entry.created = subs[i].created, subs[i] = entry;
  else { subs.push(entry); if (subs.length > MAX_SUBS) subs = subs.slice(-MAX_SUBS); }
  persist();
  return entry;
}
function unsubscribe(endpoint) {
  const before = subs.length;
  subs = subs.filter((s) => s.endpoint !== endpoint);
  if (subs.length !== before) persist();
  return before - subs.length;
}
const count = () => subs.length;

async function sendOne(sub, payload) {
  try {
    await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 24 * 3600, urgency: "high" });
    return true;
  } catch (e) {
    // 404/410 = a inscricao expirou ou o navegador cancelou: esquece.
    if (e.statusCode === 404 || e.statusCode === 410) {
      unsubscribe(sub.endpoint);
      logFn && logFn(`    PUSH: inscricao expirada removida (${e.statusCode})`);
    } else logFn && logFn(`    ERRO push: ${e.statusCode || ""} ${String(e.body || e.message || e).slice(0, 200)}`);
    return false;
  }
}

/** Manda para todas as inscricoes (ou so para `endpoint`, no teste). */
async function send(payload, endpoint) {
  if (!webpush || !vapid) return 0;
  const targets = endpoint ? subs.filter((s) => s.endpoint === endpoint) : subs.slice();
  const ok = await Promise.all(targets.map((s) => sendOne(s, payload)));
  return ok.filter(Boolean).length;
}

module.exports = { init, publicKey, subscribe, unsubscribe, count, send };
