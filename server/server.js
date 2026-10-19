// server.js — servidor Camera-to-Cloud auto-hospedado: recebe videos do app
// Fframe Uploader e emula a API do Frame.io (V2) + OAuth2 para interoperar
// com outros apps de camera que falam o mesmo protocolo.
//
// Fluxo do protocolo C2C:
//   1) OAuth2  -> applications.frame.io/oauth2/auth  e  /oauth2/token   (header Bearer)
//   2) Bootstrap -> descobre conta / projeto / root_asset_id  (GET /v2/me, etc.)
//   3) Criar asset -> POST /v2/assets/{parent}/children {name,type,filetype,filesize}
//                     resposta traz upload_urls[]  (pedacos do arquivo)
//   4) Upload -> PUT em cada upload_url  ->  200 + ETag  ->  asset vira "uploaded"
//
// Como o servidor recebe TANTO applications.frame.io quanto api.frame.io (via DNS),
// tudo roda num Express so; as rotas nao colidem (/oauth2/* vs /v2/*).

const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const store = require("./lib/store");
const library = require("./lib/library");
const transcript = require("./lib/transcript");

const PORT = process.env.PORT || 3000;
// Base publica usada para montar as upload_urls. Em producao aponte para o host
// que o app enxerga como api.frame.io (ex.: https://api.frame.io se via DNS, ou o
// dominio proprio). Localmente usa http://<ip>:<porta>.
const PUBLIC_BASE = process.env.PUBLIC_BASE || `http://localhost:${PORT}`;
const CHUNK_SIZE = Number(process.env.CHUNK_SIZE || 25 * 1024 * 1024); // 25MB por pedaco

const app = express();
app.set("json spaces", 2);
// Atras do Cloudflare Tunnel: confia no proxy p/ detectar HTTPS (cookie secure).
app.set("trust proxy", 1);

// ---- Cabecalhos de seguranca ------------------------------------------------
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  // CSP: tudo do proprio host, sem inline de script. (JS/CSS sao arquivos externos.)
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data:; media-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
  );
  next();
});

// ---- Sessao (cookie assinado, httpOnly, secure via HTTPS, sameSite strict) ---
app.use(session({
  name: "fio.sid",
  secret: store.getSessionSecret(),
  resave: false,
  saveUninitialized: false,
  // Sem maxAge por padrao = cookie de sessao (some ao fechar o navegador).
  // O "Manter conectado" define validade longa (ver applyRemember).
  cookie: { httpOnly: true, secure: "auto", sameSite: "strict" },
}));
// "Manter conectado": marcado -> cookie dura 30 dias; desmarcado -> so a sessao.
function applyRemember(req) {
  if (req.body && req.body.remember) req.session.cookie.maxAge = 30 * 24 * 3600 * 1000;
  else req.session.cookie.expires = false;
}

// ---- Anti forca-bruta simples (por IP) --------------------------------------
const authAttempts = new Map();
function authRate(req, res, next) {
  const ip = req.ip || "?";
  const now = Date.now();
  const rec = authAttempts.get(ip) || { n: 0, t: now };
  if (now - rec.t > 15 * 60 * 1000) { rec.n = 0; rec.t = now; }
  rec.n++;
  authAttempts.set(ip, rec);
  if (rec.n > 10) return res.status(429).json({ error: "Too many attempts. Try again in a few minutes." });
  next();
}
// Exige login (validado no SERVIDOR — o frontend nao decide nada).
function requireAuth(req, res, next) {
  if (req.session && req.session.authed) return next();
  // Alternativa p/ o app: autenticacao por device key (header OU ?key= p/ player nativo).
  // Aceita qualquer chave ATIVA de data/devices.json (revogada = 401).
  const key = req.headers["x-device-key"] || req.query.key;
  const dev = store.findDeviceByKey(key);
  if (dev) { req.device = dev; return next(); }
  res.status(401).json({ error: "not signed in" });
}

// So sessao de admin (painel) -- NAO aceita device key. Usado nas rotas que
// gerenciam os proprios dispositivos: um celular pareado nao pode criar ou
// revogar chaves de outros dispositivos.
function requireAdminSession(req, res, next) {
  if (req.session && req.session.authed && !req.device) return next();
  res.status(401).json({ error: "admin login required" });
}

// ---- LOG de tudo (nossa janela de depuracao) --------------------------------
// Registra cada request que o app faz. E assim que a gente descobre se falta
// implementar algum endpoint: aparece aqui no console e no arquivo de log.
const LOG_FILE = path.join(store.DATA_DIR, "requests.log");
function log(line) {
  const stamp = new Date().toISOString();
  const msg = `[${stamp}] ${line}`;
  console.log(msg);
  try { fs.appendFileSync(LOG_FILE, msg + "\n"); } catch {}
}

app.use((req, res, next) => {
  const host = req.headers.host || "?";
  const auth = req.headers.authorization ? " (Bearer)" : "";
  // o token do link de compartilhamento nao vai pro log
  const url = req.originalUrl.replace(/^\/(_?s)\/[^/?]+/, "/$1/***");
  log(`--> ${req.method} ${host}${url}${auth}`);
  next();
});

// Body parsers. IMPORTANTE: nao aplicar nos PUT de upload (binarios grandes).
// Token OAuth costuma vir form-urlencoded; as chamadas /v2 vem JSON. Alguns
// clientes esquecem o Content-Type, entao tratamos "sem content-type" como JSON.
app.use((req, res, next) => {
  if (req.method === "PUT" && req.path.startsWith("/_upload/")) return next();
  if (req.method === "POST" && req.path === "/_ingest") return next(); // video binario do app
  const ct = (req.headers["content-type"] || "").toLowerCase();
  if (ct.includes("urlencoded")) {
    return express.urlencoded({ extended: true })(req, res, next);
  }
  // JSON tolerante: parseia application/json E tambem body sem content-type.
  return express.json({ type: () => true, limit: "40mb" })(req, res, (err) => {
    if (err) req.body = {}; // se nao for JSON valido, segue com body vazio
    next();
  });
});

// =============================================================================
// 1) OAUTH2  (host: applications.frame.io)
// =============================================================================

// GET /oauth2/auth -> auto-aprova e redireciona de volta pro app com um "code".
// Frame.io real mostraria tela de login; aqui aprovamos na hora.
app.get("/oauth2/auth", (req, res) => {
  const { redirect_uri, state } = req.query;
  if (!redirect_uri) return res.status(400).send("missing redirect_uri");
  const code = store.issueAuthCode(String(redirect_uri));
  const sep = String(redirect_uri).includes("?") ? "&" : "?";
  let url = `${redirect_uri}${sep}code=${encodeURIComponent(code)}`;
  if (state) url += `&state=${encodeURIComponent(String(state))}`;
  log(`    OAuth auto-aprovado -> redirect ${url}`);
  res.redirect(302, url);
});

// POST /oauth2/token -> troca o code (ou refresh) por um access_token Bearer.
app.post("/oauth2/token", (req, res) => {
  const grant = req.body.grant_type;
  log(`    token grant_type=${grant}`);
  const { access_token, refresh_token } = store.issueToken();
  res.json({
    access_token,
    token_type: "Bearer",
    expires_in: 3600,
    refresh_token,
    scope: req.body.scope || "offline",
  });
});

// =============================================================================
// 2) BOOTSTRAP  (host: api.frame.io) — conta / time / projeto / root asset
// =============================================================================
const cfg = store.config;

function userPayload() {
  return {
    id: cfg.user.id,
    name: cfg.user.name,
    email: cfg.user.email,
    account_id: cfg.account.id,
    account: accountPayload(),
    role: "admin",
    created_at: cfg.user.created_at,
  };
}
function accountPayload() {
  return {
    id: cfg.account.id,
    display_name: cfg.account.display_name,
    name: cfg.account.name,
    plan: cfg.account.plan,
    account_id: cfg.account.id,
  };
}
function teamPayload() {
  return {
    id: cfg.team.id,
    name: cfg.team.name,
    account_id: cfg.account.id,
    project_count: 1,
  };
}
function projectPayload(p) {
  p = p || store.getConnectedProject();
  return {
    id: p.id,
    name: p.name,
    root_asset_id: p.root_asset_id,
    team_id: cfg.team.id,
    account_id: cfg.account.id,
  };
}
const allProjectsPayload = () => store.listProjects().map((p) => projectPayload(p));

// ---- API de DISPOSITIVOS (Camera to Cloud) —
// o app cliente conecta como um "device" C2C e busca a conta/projeto por aqui.
const DEVICE_ID = cfg.device ? cfg.device.id : cfg.user.id;
function devicePayload() {
  const p = store.getConnectedProject();
  return {
    id: DEVICE_ID,
    name: "Fframe",
    type: "device",
    status: "connected",
    connected: true,
    account_id: cfg.account.id,
    account: accountPayload(),
    accounts: [accountPayload()],
    root_asset_id: p.root_asset_id,
    project: projectPayload(p),
  };
}
app.get("/v2/devices/me", (req, res) => res.json(devicePayload()));
app.get("/v2/devices/accounts", (req, res) => res.json([accountPayload()]));
app.get("/v2/devices/accounts/:id", (req, res) => res.json(accountPayload()));
app.get("/v2/devices/accounts/:id/projects", (req, res) => res.json(allProjectsPayload()));
app.get("/v2/devices/accounts/:id/teams", (req, res) => res.json([teamPayload()]));
app.get("/v2/devices/projects", (req, res) => res.json(allProjectsPayload()));
app.get("/v2/devices/projects/:id", (req, res) => res.json(projectPayload(store.getProject(req.params.id))));
app.get("/v2/devices/teams", (req, res) => res.json([teamPayload()]));
app.post("/v2/devices/assets", handleCreateAsset);
app.post("/v2/devices/assets/:parentId/children", handleCreateAsset);

// Conecta o dispositivo a um projeto (passo obrigatorio antes do upload real).
// Guarda qual projeto foi escolhido para associar os videos que vierem depois.
app.post("/v2/devices/connect", (req, res) => {
  const projectId = req.query.project_id || store.getConnectedProject().id;
  store.setConnectedProject(projectId);
  const p = store.getProject(projectId) || store.getConnectedProject();
  log(`    DEVICE conectado ao projeto "${p.name}" (${projectId})`);
  res.status(200).json({
    ...devicePayload(),
    project_id: projectId,
    status: "connected",
    connected: true,
  });
});
app.post("/v2/devices/disconnect", (req, res) => res.status(200).json({ status: "disconnected" }));
app.post("/v2/devices/heartbeat", (req, res) => res.status(200).json({ status: "ok", connected: true }));
app.get("/v2/devices/heartbeat", (req, res) => res.status(200).json({ status: "ok", connected: true }));

app.get("/v2/me", (req, res) => res.json(userPayload()));
app.get("/v2/users/me", (req, res) => res.json(userPayload()));
app.get("/v2/accounts", (req, res) => res.json([accountPayload()]));
app.get("/v2/accounts/:id", (req, res) => res.json(accountPayload()));
app.get("/v2/accounts/:id/teams", (req, res) => res.json([teamPayload()]));
app.get("/v2/teams", (req, res) => res.json([teamPayload()]));
app.get("/v2/teams/:id", (req, res) => res.json(teamPayload()));
app.get("/v2/teams/:id/projects", (req, res) => res.json(allProjectsPayload()));
app.get("/v2/accounts/:id/projects", (req, res) => res.json(allProjectsPayload()));
app.get("/v2/projects", (req, res) => res.json(allProjectsPayload()));
app.get("/v2/projects/:id", (req, res) => res.json(projectPayload(store.getProject(req.params.id))));

// =============================================================================
// 3) CRIAR ASSET  — o app anuncia um video e recebe as upload_urls
// =============================================================================
function assetResponse(a) {
  const urls = [];
  for (let i = 0; i < a.expected_parts; i++) {
    urls.push(`${PUBLIC_BASE}/_upload/${a.id}/${i}`);
  }
  // O parser do app (org.json) EXIGE todos estes campos, senao quebra e nao
  // faz o upload: id, project_id, name, account_id, creator_id, team_id,
  // status, type, filesize (numero/long), filetype, upload_urls (array).
  return {
    id: a.id,
    parent_id: a.parent_id,
    project_id: a.project_id,
    account_id: cfg.account.id,
    creator_id: cfg.user.id,
    team_id: cfg.team.id,
    name: a.name,
    type: a.type,
    filetype: a.filetype,
    filesize: a.filesize,
    status: a.status,
    upload_url: urls[0],
    upload_urls: urls,
    is_hls_required: false,
    created_at: a.created_at,
  };
}

// Descobre a qual projeto o video pertence: pelo corpo (parent_id/project_id),
// pela rota, ou pelo projeto atualmente conectado (o que o usuario escolheu no app).
function resolveProject(req) {
  const b = req.body || {};
  if (b.parent_id) { const p = store.getProjectByRoot(b.parent_id); if (p) return p; }
  if (b.project_id) { const p = store.getProject(b.project_id); if (p) return p; }
  if (req.params.parentId) { const p = store.getProjectByRoot(req.params.parentId); if (p) return p; }
  return store.getConnectedProject();
}

function handleCreateAsset(req, res) {
  const proj = resolveProject(req);
  const { name, filetype, filesize } = req.body || {};
  const parts = Number(req.query.parts) || 0; // o app diz quantos pedacos quer
  const asset = store.createAsset({ projectId: proj.id, name, filetype, filesize, chunkSize: CHUNK_SIZE, parts });
  log(`    ASSET criado: "${asset.name}" ${asset.filesize} bytes -> ${asset.expected_parts} pedaco(s)  projeto="${proj.name}"  id=${asset.id}`);
  res.status(201).json(assetResponse(asset));
}

app.post("/v2/assets/:parentId/children", handleCreateAsset);
app.post("/v2/assets", handleCreateAsset);

app.get("/v2/assets/:id", (req, res) => {
  const a = store.getAsset(req.params.id);
  if (!a) return res.status(404).json({ message: "asset not found" });
  res.json(assetResponse(a));
});

// =============================================================================
// 4) UPLOAD dos pedacos  (PUT binario, sem Bearer — igual presigned S3)
// =============================================================================
app.put("/_upload/:id/:part", (req, res) => {
  const { id } = req.params;
  const part = Number(req.params.part);
  const asset = store.getAsset(id);
  if (!asset) return res.status(404).end();

  // IDEMPOTENTE: se o video ja foi recebido por inteiro, uma retentativa do app
  // nao deve dar erro. Consome o corpo e responde 200 -> o app marca como enviado.
  if (asset.status === "uploaded") {
    req.on("data", () => {});
    req.on("end", () => { res.set("ETag", asset.etag || '"done"'); res.status(200).end(); });
    req.on("error", () => { try { res.status(200).end(); } catch {} });
    return;
  }

  // Garante que a pasta dos pedacos exista (evita ENOENT em retentativas).
  fs.mkdirSync(path.join(store.PARTS_DIR, id), { recursive: true });
  const out = fs.createWriteStream(store.partPath(id, part));
  const hash = crypto.createHash("md5");
  let bytes = 0;

  req.on("data", (chunk) => { hash.update(chunk); bytes += chunk.length; });
  req.pipe(out);

  out.on("finish", () => {
    store.markPartReceived(id, part);
    const etag = `"${hash.digest("hex")}"`;
    asset.etag = etag; // guardado p/ responder retentativas
    log(`    UPLOAD parte ${part} de ${asset.name}: ${bytes} bytes (etag ${etag.slice(1, 9)})`);
    maybeAssemble(asset);
    res.set("ETag", etag);
    res.status(200).end();
  });
  out.on("error", (e) => { log(`    ERRO gravando parte: ${e.message}`); res.status(500).end(); });
});

// Quando todos os pedacos chegam, junta tudo no arquivo final, organizado em
// uploads/<projeto>/<data>/<arquivo>.
function maybeAssemble(asset) {
  const a = store.getAsset(asset.id);
  if (!a || a.status === "uploaded") return;
  if (a.received_parts.length < a.expected_parts) return;

  const finalPath = store.finalPathFor(a);
  const outStream = fs.createWriteStream(finalPath);

  const writeNext = (i) => {
    if (i >= a.expected_parts) {
      outStream.end(() => {
        store.markUploaded(a.id, finalPath);
        log(`    >>> VIDEO COMPLETO: ${finalPath}`);
      });
      return;
    }
    const rs = fs.createReadStream(store.partPath(a.id, i));
    rs.pipe(outStream, { end: false });
    rs.on("end", () => writeNext(i + 1));
    rs.on("error", (e) => log(`    ERRO juntando parte ${i}: ${e.message}`));
  };
  writeNext(0);
}

// =============================================================================
// UTIL / DEBUG
// =============================================================================

app.get("/api/health", (req, res) => res.json({ ok: true, service: "fframe-server" }));

// ---- Tela / arquivos estaticos (SEM segredos: so HTML/CSS/JS publicos) -------
const SHELL_HTML = path.join(__dirname, "public", "dashboard.html");
app.get("/", (req, res) => res.sendFile(SHELL_HTML));
// Pagina de revisao do admin (/v/<id>) e do cliente (/s/<token>, /s/<token>/v/<id>).
// So o HTML publico; os dados vem das APIs, que checam login ou o token.
app.get(["/v/:id", "/s/:token", "/s/:token/v/:id"], (req, res) => {
  res.set("Referrer-Policy", "no-referrer");
  res.sendFile(SHELL_HTML);
});
app.get("/favicon.ico", (req, res) => res.status(204).end());
// PWA: service worker (escopo raiz) e manifest, publicos e sem segredo.
app.get("/sw.js", (req, res) => {
  res.set("Content-Type", "application/javascript; charset=utf-8");
  res.set("Cache-Control", "no-cache");
  res.set("Service-Worker-Allowed", "/");
  res.sendFile(path.join(__dirname, "public", "sw.js"));
});
app.get("/manifest.webmanifest", (req, res) => {
  res.set("Content-Type", "application/manifest+json; charset=utf-8");
  res.sendFile(path.join(__dirname, "public", "manifest.webmanifest"));
});
app.use(express.static(path.join(__dirname, "public"), { index: false }));

// ---- AUTENTICACAO (credenciais e hash SO no servidor) -----------------------
app.get("/_auth/status", (req, res) =>
  res.json({ configured: store.isConfigured(), authed: !!(req.session && req.session.authed) }));

// Primeiro acesso: o usuario define login+senha direto no navegador (via HTTPS).
app.post("/_auth/setup", authRate, async (req, res) => {
  if (store.isConfigured()) return res.status(409).json({ error: "already set up" });
  const user = String((req.body && req.body.user) || "").trim();
  const password = String((req.body && req.body.password) || "");
  if (user.length < 3 || password.length < 6)
    return res.status(400).json({ error: "username (at least 3 characters) and password (at least 6) are required" });
  const hash = await bcrypt.hash(password, 12);
  store.setAuth(user, hash);
  req.session.authed = true; req.session.user = user;
  applyRemember(req);
  log(`    ADMIN configurado: ${user}`);
  res.json({ ok: true });
});

app.post("/_auth/login", authRate, async (req, res) => {
  const auth = store.getAuth();
  const user = String((req.body && req.body.user) || "");
  const password = String((req.body && req.body.password) || "");
  const ok = !!auth && user === auth.user && (await bcrypt.compare(password, auth.hash));
  if (!ok) return res.status(401).json({ error: "invalid credentials" }); // generico de proposito
  req.session.authed = true; req.session.user = auth.user;
  applyRemember(req);
  res.json({ ok: true });
});

app.post("/_auth/logout", (req, res) => req.session.destroy(() => res.json({ ok: true })));

// Login automatico do app (WebView) via device key -> abre o painel ja logado.
// Qualquer dispositivo ATIVO de devices.json serve; revogado nao loga.
app.get("/_devicelogin", (req, res) => {
  const dev = store.findDeviceByKey(req.query.key || "");
  if (dev) {
    req.session.authed = true;
    req.session.user = "device:" + dev.name;
    req.session.cookie.maxAge = 30 * 24 * 3600 * 1000;
  }
  res.redirect("/");
});

// ---- API do painel — TUDO exige login (checado no SERVIDOR) -----------------
app.get("/_api/projects", requireAuth, (req, res) => {
  const connId = store.getConnectedProject().id;
  const all = Object.values(store.assets());
  res.json(store.listProjects().map(({ share, ...p }) => ({
    ...p,
    shared: !!(share && share.enabled),   // o token so sai em /_api/projects/:id/share (admin)
    settings: store.getSettings(p.id),
    connected: p.id === connId,
    video_count: all.filter((a) => a.project_id === p.id && a.status === "uploaded").length,
  })));
});
app.post("/_api/projects", requireAuth, (req, res) => {
  const name = (req.body && req.body.name) || "";
  if (!String(name).trim()) return res.status(400).json({ error: "name is required" });
  res.status(201).json(store.createProject(name));
});
app.delete("/_api/projects/:id", requireAuth, (req, res) => {
  const ok = store.deleteProject(req.params.id);
  if (ok) library.dropLinksForProject(req.params.id);
  res.status(ok ? 200 : 400).json({ ok, error: ok ? undefined : "can't delete the last project, or it doesn't exist" });
});
app.get("/_api/assets", requireAuth, (req, res) => {
  const projectId = req.query.project;
  let list = Object.values(store.assets()).filter((a) => a.status === "uploaded");
  if (projectId) list = list.filter((a) => a.project_id === projectId);
  list = list
    .map((a) => ({
      id: a.id, name: a.name, project_id: a.project_id, project_name: a.project_name,
      filesize: a.filesize, filetype: a.filetype, device_name: a.device_name,
      kind: a.kind || "proxy",
      source: a.source || "upload", library_folder: a.library_folder,
      uploaded_at: a.uploaded_at || a.created_at,
      date: (a.uploaded_at || a.created_at || "").slice(0, 10),
      comment_count: store.countComments(a.id),
      has_transcript: transcript.has(a.id),
      chapter_count: store.countChapters(a.id),
    }))
    .sort((x, y) => String(y.uploaded_at).localeCompare(String(x.uploaded_at)));
  res.json(list);
});
// Excluir video (apaga o arquivo do disco tambem). Video da biblioteca so sai
// do Fframe — o arquivo no NAS nunca e apagado (e exige sessao de admin).
app.delete("/_api/assets/:id", requireAuth, (req, res) => {
  const a = store.getAsset(req.params.id);
  if (a && a.source === "library") {
    if (!(req.session && req.session.authed) || req.device) return res.status(401).json({ error: "admin login required" });
    library.hideAsset(a);
    log(`    BIBLIOTECA: video removido do Fframe (arquivo mantido): "${a.name}"`);
    return res.json({ ok: true });
  }
  const ok = store.deleteAsset(req.params.id);
  if (ok) log(`    VIDEO EXCLUIDO: "${a && a.name}" (${req.params.id})`);
  res.status(ok ? 200 : 404).json({ ok });
});

// Comentario como vai pro navegador: sem o hash do convidado.
const publicComment = (c, guestHash) => {
  const { guest_hash, ...rest } = c;
  if (guestHash !== undefined) rest.mine = !!guest_hash && guest_hash === guestHash;
  return rest;
};

// ---- Comentarios com timestamp (revisao no painel) — exige login ------------
app.get("/_api/assets/:id/comments", requireAuth, (req, res) => {
  if (!store.getAsset(req.params.id)) return res.status(404).json({ error: "video not found" });
  res.json(store.listComments(req.params.id).map((c) => publicComment(c)));
});
// Capitulos = marcadores do Resolve (somente leitura no painel).
app.get("/_api/assets/:id/chapters", requireAuth, (req, res) => {
  if (!store.getAsset(req.params.id)) return res.status(404).json({ error: "video not found" });
  res.json(store.listChapters(req.params.id));
});
app.post("/_api/assets/:id/comments", requireAuth, (req, res) => {
  if (!store.getAsset(req.params.id)) return res.status(404).json({ error: "video not found" });
  const author = (req.session && req.session.user) || (req.device && ("device:" + req.device.name)) || null;
  const b = req.body || {};
  const c = store.addComment(req.params.id, { t: b.t, tEnd: b.t_end, parentId: b.parent_id, text: b.text, author });
  if (!c) return res.status(400).json({ error: "text is required" });
  res.status(201).json(c);
});
app.patch("/_api/assets/:id/comments/:cid", requireAuth, (req, res) => {
  const ok = store.setCommentResolved(req.params.id, req.params.cid, !!(req.body && req.body.resolved));
  res.status(ok ? 200 : 404).json({ ok });
});
app.delete("/_api/assets/:id/comments/:cid", requireAuth, (req, res) => {
  const ok = store.deleteComment(req.params.id, req.params.cid);
  res.status(ok ? 200 : 404).json({ ok });
});

// ---- Transcricoes (clicar no texto -> vai para o ponto do video) ------------
app.get("/_api/assets/:id/transcript", requireAuth, (req, res) => {
  if (!store.getAsset(req.params.id)) return res.status(404).json({ error: "video not found" });
  const tr = transcript.forPlayer(req.params.id);
  if (!tr) return res.status(404).json({ error: "no transcript" });
  res.json(tr);
});
// Corpo: { filename, content, fps } (o painel le o arquivo e manda o texto).
app.put("/_api/assets/:id/transcript", requireAdminSession, (req, res) => {
  if (!store.getAsset(req.params.id)) return res.status(404).json({ error: "video not found" });
  const b = req.body || {};
  const r = transcript.parse(b.content, { filename: b.filename, fps: b.fps });
  if (r.error) return res.status(400).json({ error: r.error });
  const out = transcript.apply(req.params.id, r, { source: "upload" });
  log(`    TRANSCRICAO: "${b.filename}" -> ${req.params.id} (${r.kind}, ${r.segments.length} trechos, ${out.markers} marcadores)`);
  res.json({ markers: out.markers, transcript: out.transcript ? transcript.forPlayer(req.params.id) : null });
});
app.patch("/_api/assets/:id/transcript", requireAdminSession, (req, res) => {
  const d = transcript.update(req.params.id, req.body || {});
  if (!d) return res.status(404).json({ error: "no transcript" });
  res.json(transcript.forPlayer(req.params.id));
});
app.delete("/_api/assets/:id/transcript", requireAdminSession, (req, res) =>
  res.json({ ok: transcript.remove(req.params.id) }));
// Casa cada arquivo { filename, content } com os videos de mesmo nome em `vids`
// e aplica (transcricao + marcadores). Usado pelo painel e pelo script do Resolve.
function importFiles(vids, files, fps) {
  const byKey = new Map();
  vids.forEach((a) => { const k = transcript.matchKey(a.name); (byKey.get(k) || byKey.set(k, []).get(k)).push(a); });
  return (Array.isArray(files) ? files : []).slice(0, 500).map((f) => {
    const targets = byKey.get(transcript.matchKey(f.filename)) || [];
    if (!targets.length) return { filename: f.filename, ok: false, error: "no video with that name" };
    const r = transcript.parse(f.content, { filename: f.filename, fps });
    if (r.error) return { filename: f.filename, ok: false, error: r.error };
    let markers = 0;
    targets.forEach((a) => { markers = transcript.apply(a.id, r, { source: "upload" }).markers; });
    return {
      filename: f.filename, ok: true, transcript: r.segments.length > 0, markers,
      videos: targets.map((a) => ({ name: a.name, project: a.project_name })),
    };
  });
}

// Varias de uma vez: casa cada arquivo com o video de mesmo nome no projeto.
// Corpo: { fps, files: [{ filename, content }] }
app.post("/_api/projects/:id/transcripts", requireAdminSession, (req, res) => {
  if (!store.getProject(req.params.id)) return res.status(404).json({ error: "project not found" });
  const b = req.body || {};
  const vids = Object.values(store.assets()).filter((a) => a.project_id === req.params.id && a.status === "uploaded");
  const results = importFiles(vids, b.files, b.fps).map((r) => ({ ...r, videos: r.videos && r.videos.map((v) => v.name) }));
  log(`    TRANSCRICOES em lote: ${results.filter((r) => r.ok).length}/${results.length} casadas`);
  res.json({ results });
});

// Envio direto do script "Export to Fframe" (device key): procura o video de
// mesmo nome em TODOS os projetos (ou so em `project_id`, se vier).
app.post("/_api/resolve/import", requireAuth, (req, res) => {
  const b = req.body || {};
  let vids = Object.values(store.assets()).filter((a) => a.status === "uploaded");
  if (b.project_id) vids = vids.filter((a) => a.project_id === b.project_id);
  const results = importFiles(vids, b.files, b.fps);
  const who = req.device ? `dispositivo "${req.device.name}"` : "painel";
  log(`    RESOLVE -> Fframe (${who}): ${results.filter((r) => r.ok).length}/${results.length} clipes casados`);
  res.json({ results });
});

// =============================================================================
// COMPARTILHAMENTO (estilo Frame.io): link secreto por projeto, sem login.
// O cliente informa o nome; os comentarios ficam com esse nome. Tudo aqui so
// enxerga o projeto do token e respeita as opcoes definidas pelo admin.
// =============================================================================
app.get("/_api/projects/:id/share", requireAdminSession, (req, res) => {
  const p = store.getProject(req.params.id);
  if (!p) return res.status(404).json({ error: "project not found" });
  res.json(store.getShare(p.id));
});
app.patch("/_api/projects/:id/share", requireAdminSession, (req, res) => {
  const p = store.getProject(req.params.id);
  if (!p) return res.status(404).json({ error: "project not found" });
  const sh = store.updateShare(p.id, req.body || {});
  log(`    COMPARTILHAMENTO "${p.name}": ${sh.enabled ? "ativo" : "desativado"}${(req.body || {}).regenerate ? " (novo link)" : ""}`);
  res.json(sh);
});

// Recursos do projeto (capitulos, transcricao) — valem para admin e cliente.
app.patch("/_api/projects/:id/settings", requireAdminSession, (req, res) => {
  const st = store.updateSettings(req.params.id, req.body || {});
  if (!st) return res.status(404).json({ error: "project not found" });
  res.json(st);
});

// Transcricao como documento do Word (.doc).
function sendTranscriptDoc(res, a) {
  const tr = transcript.forPlayer(a.id);
  if (!tr) return res.status(404).json({ error: "no transcript" });
  const st = store.getSettings(a.project_id);
  const doc = transcript.toWordDoc({ title: path.basename(a.name, path.extname(a.name)), project: a.project_name, tr,
    chapters: st.chapters ? store.listChapters(a.id) : [] });
  const fname = `${path.basename(a.name, path.extname(a.name))} - Transcript.doc`;
  res.set("Content-Type", "application/msword; charset=utf-8");
  res.set("Content-Disposition", `attachment; filename="${fname.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(fname)}`);
  res.send("\ufeff" + doc);
}
app.get("/_api/assets/:id/transcript.doc", requireAuth, (req, res) => {
  const a = store.getAsset(req.params.id);
  if (!a) return res.status(404).end();
  sendTranscriptDoc(res, a);
});

// Resolve o token -> projeto. Link desativado/inexistente = 404 generico.
function shareCtx(req, res, next) {
  const p = store.getProjectByShareToken(req.params.token);
  if (!p) return res.status(404).json({ error: "link is invalid or turned off" });
  req.shareProject = p;
  req.share = p.share;
  const gid = String(req.headers["x-guest-id"] || "");
  req.guestHash = /^[a-f0-9]{16,64}$/.test(gid) ? crypto.createHash("sha256").update(gid).digest("hex") : null;
  next();
}
function shareAsset(req, res, next) {
  const a = store.getAsset(req.params.id);
  if (!a || a.status !== "uploaded" || a.project_id !== req.shareProject.id) return res.status(404).json({ error: "video not found" });
  req.asset = a;
  next();
}
const guestRate = new Map();
function guestLimit(req, res, next) {
  const k = req.ip + "|" + req.params.token, now = Date.now();
  const r = guestRate.get(k) || { n: 0, t: now };
  if (now - r.t > 10 * 60 * 1000) { r.n = 0; r.t = now; }
  r.n++; guestRate.set(k, r);
  if (r.n > 120) return res.status(429).json({ error: "too many messages, try again in a few minutes" });
  next();
}
// O que o cliente pode ver/fazer: opcoes do link + recursos do projeto.
const shareSettings = (req) => {
  const st = store.getSettings(req.shareProject.id), sh = req.share;
  return {
    allow_comments: !!sh.allow_comments, chapters: !!st.chapters, transcript: !!st.transcript,
    allow_download_video: !!sh.allow_download_video,
    allow_download_transcript: !!sh.allow_download_transcript && !!st.transcript,
  };
};

app.get("/_s/:token/info", shareCtx, (req, res) =>
  res.json({ project: req.shareProject.name, ...shareSettings(req) }));
app.get("/_s/:token/assets", shareCtx, (req, res) => {
  const list = Object.values(store.assets())
    .filter((a) => a.status === "uploaded" && a.project_id === req.shareProject.id)
    .map((a) => ({
      id: a.id, name: a.name, filesize: a.filesize,
      uploaded_at: a.uploaded_at || a.created_at, date: (a.uploaded_at || a.created_at || "").slice(0, 10),
      comment_count: store.countComments(a.id),
      chapter_count: store.getSettings(req.shareProject.id).chapters ? store.countChapters(a.id) : 0,
      has_transcript: store.getSettings(req.shareProject.id).transcript && transcript.has(a.id),
    }))
    .sort((x, y) => String(y.uploaded_at).localeCompare(String(x.uploaded_at)));
  res.json(list);
});
app.get("/_s/:token/media/:id", shareCtx, shareAsset, (req, res) => sendMedia(req, res, req.asset));
app.get("/_s/:token/download/:id", shareCtx, shareAsset, (req, res) => {
  if (!req.share.allow_download_video || !req.asset.stored_path || !fs.existsSync(req.asset.stored_path)) return res.status(404).end();
  res.download(req.asset.stored_path, req.asset.name);
});
app.get("/_s/:token/transcript/:id", shareCtx, shareAsset, (req, res) => {
  if (!shareSettings(req).allow_download_transcript) return res.status(404).end();
  sendTranscriptDoc(res, req.asset);
});
app.get("/_s/:token/assets/:id/chapters", shareCtx, shareAsset, (req, res) =>
  res.json(store.getSettings(req.shareProject.id).chapters ? store.listChapters(req.asset.id).map(({ key, ...c }) => c) : []));
app.get("/_s/:token/assets/:id/transcript", shareCtx, shareAsset, (req, res) => {
  const tr = store.getSettings(req.shareProject.id).transcript ? transcript.forPlayer(req.asset.id) : null;
  if (!tr) return res.status(404).json({ error: "no transcript" });
  delete tr.source_name; delete tr.source;
  res.json(tr);
});
app.get("/_s/:token/assets/:id/comments", shareCtx, shareAsset, (req, res) =>
  res.json(store.listComments(req.asset.id).map((c) => publicComment(c, req.guestHash))));
app.post("/_s/:token/assets/:id/comments", shareCtx, shareAsset, guestLimit, (req, res) => {
  if (!req.share.allow_comments) return res.status(403).json({ error: "comments are turned off" });
  if (!req.guestHash) return res.status(400).json({ error: "missing guest id" });
  const b = req.body || {};
  const name = String(b.name || "").replace(/\s+/g, " ").trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: "name is required" });
  const c = store.addComment(req.asset.id, { t: b.t, tEnd: b.t_end, parentId: b.parent_id, text: b.text, author: name, guestHash: req.guestHash });
  if (!c) return res.status(400).json({ error: "text is required" });
  log(`    COMENTARIO de convidado "${name}" em "${req.asset.name}"`);
  res.status(201).json(publicComment(c, req.guestHash));
});
// Convidado so apaga o PROPRIO comentario.
app.delete("/_s/:token/assets/:id/comments/:cid", shareCtx, shareAsset, (req, res) => {
  const c = store.listComments(req.asset.id).find((x) => x.id === req.params.cid);
  if (!c || !req.guestHash || c.guest_hash !== req.guestHash) return res.status(403).json({ error: "only the author can delete this" });
  res.json({ ok: store.deleteComment(req.asset.id, c.id) });
});

// ---- Comentarios -> DaVinci Resolve -----------------------------------------
// Feed para o script "Import Fframe Comments" (tools/resolve). Aceita sessao ou
// device key (crie um dispositivo "Resolve" no painel). Comentarios que vieram
// do proprio Resolve viraram capitulos, entao aqui so chegam comentarios reais.
app.get("/_api/resolve/comments", requireAuth, (req, res) => {
  let list = Object.values(store.assets()).filter((a) => a.status === "uploaded");
  if (req.query.project) list = list.filter((a) => a.project_id === req.query.project);
  res.json(list.filter((a) => store.countComments(a.id)).map((a) => {
    const all = store.listComments(a.id);
    return {
      asset_id: a.id, name: a.name, project_id: a.project_id, project_name: a.project_name,
      library_folder: a.library_folder || null,
      comments: all.filter((c) => !c.parent_id).map((c) => ({
        id: c.id, t: c.t, t_end: c.t_end, text: c.text, author: authorName(c.author), resolved: !!c.resolved,
        created_at: c.created_at, guest: !!c.guest,
        replies: all.filter((r) => r.parent_id === c.id).map((r) => ({ author: authorName(r.author), text: r.text, created_at: r.created_at })),
      })),
    };
  }));
});
const authorName = (a) => (a ? String(a).replace(/^device:/, "") : "Fframe");

// EDL de marcadores (sem script): Resolve > Timeline > Import > Timeline
// Markers from EDL. ?fps=24&start=01:00:00:00 (inicio da timeline).
app.get("/_api/assets/:id/markers.edl", requireAuth, (req, res) => {
  const a = store.getAsset(req.params.id);
  if (!a) return res.status(404).end();
  const fps = transcript.FPS_OK.includes(Number(req.query.fps)) ? Number(req.query.fps) : 24;
  const base = Math.round(fps);
  const m = /^(\d{1,2}):(\d{2}):(\d{2})[:;](\d{2})$/.exec(String(req.query.start || "01:00:00:00"));
  const startF = m ? ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * base + +m[4] : 3600 * base;
  const tc = (f) => {
    const p = (n) => String(n).padStart(2, "0");
    const ff = f % base, s = Math.floor(f / base);
    return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}:${p(ff)}`;
  };
  const all = store.listComments(a.id);
  const clean = (s) => String(s || "").replace(/\s*[\r\n|]+\s*/g, " ").trim();
  const lines = [`TITLE: ${clean(a.name)} - Fframe comments`, "FCM: NON-DROP FRAME", ""];
  all.filter((c) => !c.parent_id).forEach((c, i) => {
    // tempo real -> frames; o timecode nominal conta `base` frames por segundo
    const f0 = startF + Math.round(c.t * fps);
    const dur = c.t_end != null ? Math.max(1, Math.round((c.t_end - c.t) * fps)) : 1;
    const reps = all.filter((r) => r.parent_id === c.id).map((r) => `${authorName(r.author)}: ${r.text}`);
    const note = clean([`${authorName(c.author)}: ${c.text}`].concat(reps, c.resolved ? ["(resolved in Fframe)"] : []).join(" / "));
    const n = String(i + 1).padStart(3, "0");
    lines.push(`${n}  001      V     C        ${tc(f0)} ${tc(f0 + 1)} ${tc(f0)} ${tc(f0 + 1)}  `);
    lines.push(` |C:ResolveColorRed |M:${note.slice(0, 900)} |D:${dur}`);
    lines.push("");
  });
  const fname = path.basename(a.name, path.extname(a.name)).replace(/[^\w.-]+/g, "_") + "_fframe_markers.edl";
  res.set("Content-Type", "text/plain; charset=utf-8");
  res.set("Content-Disposition", `attachment; filename="${fname}"`);
  res.send(lines.join("\r\n"));
});

// JSON cru (compatibilidade) — tambem protegido
app.get("/_status", requireAuth, (req, res) => {
  const list = Object.values(store.assets()).map((a) => ({
    name: a.name, project: a.project_name, filesize: a.filesize, status: a.status,
    parts: `${a.received_parts.length}/${a.expected_parts}`, id: a.id,
  }));
  res.json({ projects: store.listProjects().map(({ share, ...p }) => p), count: list.length, assets: list });
});

// ---- Streaming e download de video (exige login) ----------------------------
app.get("/_media/:id", requireAuth, (req, res) => sendMedia(req, res, store.getAsset(req.params.id)));
function sendMedia(req, res, a) {
  if (!a || !a.stored_path || !fs.existsSync(a.stored_path)) return res.status(404).end();
  const stat = fs.statSync(a.stored_path);
  const type = a.filetype && a.filetype.startsWith("video") ? a.filetype : "video/mp4";
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range) || [];
    const start = parseInt(m[1] || "0", 10);
    const end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      "Content-Type": type,
    });
    fs.createReadStream(a.stored_path, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { "Content-Length": stat.size, "Content-Type": type, "Accept-Ranges": "bytes" });
    fs.createReadStream(a.stored_path).pipe(res);
  }
}
app.get("/_download/:id", requireAuth, (req, res) => {
  const a = store.getAsset(req.params.id);
  if (!a || !a.stored_path || !fs.existsSync(a.stored_path)) return res.status(404).end();
  res.download(a.stored_path, a.name);
});

// ---- Ingest do app Fframe Uploader (autenticado por device key) -------------
// Recebe o video inteiro no corpo. Sem Bearer/sessao: valida a X-Device-Key.
app.post("/_ingest", (req, res) => {
  const key = req.headers["x-device-key"] || "";
  const dev = store.findDeviceByKey(key); // qualquer dispositivo ATIVO; revogado = 401
  if (!dev) return res.status(401).json({ error: "invalid device key" });
  const name = req.query.name || "video.mp4";
  const filetype = req.headers["content-type"] || "video/mp4";
  const projectId = req.query.project;
  // proxy (padrao) vai p/ uploads/ ; original vai p/ originals/ (render final)
  const kind = req.query.kind === "original" ? "original" : "proxy";
  let bytes = 0;
  let responded = false;
  store.ingestAsset(
    { name, filetype, projectId, deviceName: dev.name, kind },
    (finalPath, onDone) => {
      const out = fs.createWriteStream(finalPath);
      req.on("data", (c) => { bytes += c.length; });
      req.pipe(out);
      out.on("finish", () => onDone(bytes));
      out.on("error", (e) => { log(`    ERRO ingest: ${e.message}`); if (!responded) { responded = true; res.status(500).json({ ok: false }); } });
    },
    (asset) => {
      log(`    INGEST (app/${asset.kind}): "${asset.name}" ${asset.filesize} bytes projeto="${asset.project_name}" dispositivo="${dev.name}"`);
      if (!responded) { responded = true; res.status(201).json({ ok: true, id: asset.id, name: asset.name }); }
    }
  );
});

// Chave do dispositivo para configurar o app (mostrada no painel, exige login).
// LEGADO: devolve a primeira chave ativa (compatibilidade com clientes antigos).
app.get("/_api/device-key", requireAuth, (req, res) => {
  const active = store.listDevices().filter((d) => !d.revoked_at);
  res.json({ key: active.length ? active[0].key : store.getDeviceKey() });
});

// ---- Dispositivos (multiplos, nomeados, revogaveis) — exige login -----------
app.get("/_api/devices", requireAdminSession, (req, res) => res.json(store.listDevices()));
app.post("/_api/devices", requireAdminSession, (req, res) => {
  const name = String((req.body && req.body.name) || "").trim();
  if (!name) return res.status(400).json({ error: "name is required" });
  const d = store.createDevice(name);
  log(`    DISPOSITIVO criado: "${d.name}" (${d.id})`);
  res.status(201).json(d);
});
app.delete("/_api/devices/:id", requireAdminSession, (req, res) => {
  const ok = store.revokeDevice(req.params.id);
  if (ok) log(`    DISPOSITIVO revogado: ${req.params.id}`);
  res.status(ok ? 200 : 404).json({ ok, error: ok ? undefined : "device not found or already revoked" });
});

// ---- Biblioteca: vincular pastas que ja existem no NAS — so admin ----------
app.get("/_api/library/status", requireAdminSession, (req, res) =>
  res.json({ enabled: library.enabled(), root: library.LIBRARY_DIR }));
app.get("/_api/library/browse", requireAdminSession, (req, res) => {
  if (!library.enabled()) return res.status(404).json({ error: "library is not mounted" });
  const r = library.browse(req.query.path || "");
  if (!r) return res.status(400).json({ error: "invalid folder" });
  res.json(r);
});
app.get("/_api/library/links", requireAdminSession, (req, res) =>
  res.json(library.listLinks().map((l) => ({ ...l, hidden: undefined, hidden_count: (l.hidden || []).length, scanning: library.isScanning(l.id) }))));
app.post("/_api/library/links", requireAdminSession, async (req, res) => {
  if (!library.enabled()) return res.status(404).json({ error: "library is not mounted" });
  const b = req.body || {};
  const r = await library.addLink({ relPath: b.path, projectId: b.project_id, recursive: b.recursive });
  if (r.error) return res.status(400).json({ error: r.error });
  log(`    BIBLIOTECA vinculada: "/${r.link.path}" -> projeto ${r.link.project_id} (${r.link.count} videos)`);
  res.status(201).json(r.link);
});
app.post("/_api/library/links/:id/rescan", requireAdminSession, async (req, res) => {
  if (!library.getLink(req.params.id)) return res.status(404).json({ error: "link not found" });
  const l = await library.scan(req.params.id);
  res.json(l);
});
app.delete("/_api/library/links/:id", requireAdminSession, (req, res) => {
  const ok = library.removeLink(req.params.id);
  if (ok) log(`    BIBLIOTECA desvinculada: ${req.params.id}`);
  res.status(ok ? 200 : 404).json({ ok });
});

// Catch-all: qualquer rota que o app chame e a gente ainda nao implementou
// aparece aqui LOGADA, pra sabermos exatamente o que falta.
app.use((req, res) => {
  log(`    !!! ROTA NAO IMPLEMENTADA: ${req.method} ${req.originalUrl}  body=${JSON.stringify(req.body || {})}`);
  res.status(404).json({ message: "not implemented (logged)", path: req.originalUrl });
});

app.listen(PORT, "0.0.0.0", () => {
  log(`Fframe Server ouvindo na porta ${PORT}`);
  log(`  PUBLIC_BASE = ${PUBLIC_BASE}`);
  log(`  Projetos: ${store.listProjects().map((p) => p.name).join(", ")}`);
  log(`  Painel:  ${PUBLIC_BASE}/`);
  if (library.enabled()) {
    log(`  Biblioteca: ${library.LIBRARY_DIR} (reindexando pastas vinculadas...)`);
    library.scanAll().then(() => log("  Biblioteca: reindexacao concluida"));
  }
});
