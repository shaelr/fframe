// Service worker do PWA. Estrategia: rede-primeiro para o "shell" (fica sempre
// atualizado online e funciona offline pelo cache). NUNCA intercepta dados
// privados nem os endpoints do app (deixa passar direto pra rede).
const CACHE = "fframe-shell-v17";
const SHELL = ["/", "/app.css", "/app.js", "/review.js", "/i18n.js", "/qrcode.min.js", "/manifest.webmanifest", "/icon.svg", "/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()).catch(() => {}));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  // Dados privados e endpoints do app: sempre direto pra rede (nunca cachear).
  if (/^\/(_api|_media|_download|_auth|_status|_s\/|v2|oauth2|_upload|api)/.test(url.pathname)) return;
  // Paginas (/, /v/<id>, /s/<token>...) sao todas o mesmo shell: guarda so
  // como "/" (o token do link nunca vira chave de cache).
  if (e.request.mode === "navigate") {
    e.respondWith(
      fetch(e.request)
        .then((resp) => { if (resp.ok) { const copy = resp.clone(); caches.open(CACHE).then((c) => c.put("/", copy)).catch(() => {}); } return resp; })
        .catch(() => caches.match("/"))
    );
    return;
  }
  // Shell: rede-primeiro, cai pro cache se estiver offline.
  e.respondWith(
    fetch(e.request)
      .then((resp) => { const copy = resp.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {}); return resp; })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("/")))
  );
});

// ---- Web Push: atividade dos clientes mesmo com o Fframe fechado ------------
// O servidor (lib/push.js) manda { id, title, body, url, tag }.
const isPanel = (c) => !new URL(c.url).pathname.startsWith("/s/");   // /s/<token> = pagina do cliente
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil((async () => {
    const wins = (await self.clients.matchAll({ type: "window", includeUncontrolled: true })).filter(isPanel);
    wins.forEach((c) => c.postMessage({ type: "fframe-push", id: d.id || null }));
    // Painel aberto e na frente: ele mesmo mostra o aviso (nao duplica).
    if (d.id && wins.some((c) => c.focused && c.visibilityState === "visible")) return;
    await self.registration.showNotification(d.title || "Fframe", {
      body: d.body || "", icon: "/icon-192.png", badge: "/icon-192.png",
      tag: d.tag || d.id || undefined, data: { url: d.url || "/", id: d.id || null },
    });
  })());
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const { url = "/", id = null } = e.notification.data || {};
  const target = typeof url === "string" && url.startsWith("/") ? url : "/";
  e.waitUntil((async () => {
    // Mesmo comportamento do sino: marca como lida e abre o video no ponto do comentario.
    if (id) await fetch("/_api/notifications/read", { method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: [id] }) }).catch(() => {});
    const wins = (await self.clients.matchAll({ type: "window", includeUncontrolled: true })).filter(isPanel);
    const win = wins.find((c) => c.focused) || wins[0];
    if (win) {
      try { await win.focus(); } catch {}
      win.postMessage({ type: "fframe-open", url: target });
      return;
    }
    await self.clients.openWindow(target);
  })());
});
