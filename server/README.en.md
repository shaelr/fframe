# Fframe Server

🌐 [Português](README.md) · **[English](README.en.md)**

Self-hosted server that **receives videos** and organizes them into projects, with a web panel
(PWA) to watch, download, and delete. The main way to send is the **Fframe Uploader** (the app in
this repository), via `POST /_ingest` authenticated by a *device key*.

> Study/interoperability project. Use it with apps and accounts you have the right to use.

## Run it

You need Docker + Docker Compose.

```bash
cp .env.example .env      # adjust PUBLIC_BASE, DATA_DIR, PORT...
docker compose up -d --build
```

Panel: `http://localhost:3260/` (or whatever `PUBLIC_BASE` you set).
On first access you create a **username and password** (stored as a hash, only on the server).

### Variables (.env)

| Variable | Description |
|----------|-----------|
| `PORT` | port published on the host (default 3260) |
| `PUBLIC_BASE` | the server's public address |
| `DATA_DIR` | where videos are stored on the host |
| `CONTAINER_NAME` | container name |
| `CHUNK_SIZE` | size of each upload chunk (bytes) |

## Connecting the Fframe Uploader app

In the panel, go to **Devices → Add device**, give it a name (e.g. "John's phone"), and scan the
generated QR code straight from the app — server address and key are filled in automatically.
Each device has its own key and can be **individually revoked** at any time, without affecting
the others.

## Timestamp comments

In the panel's player, every video has a **time-anchored comments** panel: pause at the point you
want, type, and the comment sticks to that moment. Comments show up as **markers on the timeline**
(click to jump to that point), can be marked **resolved** and deleted. The video card shows a 💬
badge with the count. Only logged-in panel users can comment. They're stored in
`data/comments.json`.

Routes (all require login): `GET/POST /_api/assets/:id/comments`, `PATCH` (resolve), and
`DELETE /_api/assets/:id/comments/:cid`.

## Library (folders already on the NAS)

Set `LIBRARY_DIR` (default `/library`) to a folder mounted **read-only**, such as a TrueNAS SMB share. The admin can then open **📁 Library** in the panel, browse it, and link folders to projects. Videos are indexed in place, never copied. Use **rescan** to pick up new files; all links are also rescanned at startup. Removing or unlinking only affects Fframe's index, never the files. Links live in `data/library.json`.

Routes (admin session only): `GET /_api/library/status`, `GET /_api/library/browse?path=`, `GET/POST /_api/library/links`, `POST /_api/library/links/:id/rescan`, `DELETE /_api/library/links/:id`.

## Transcripts (click the text to jump in the video)

Like Resolve's Transcription window: the player has a **Transcript** tab. Click any word to jump there, the spoken word lights up as the video plays, you can search the text (Enter jumps to the next match), and you can select a passage and use **Comment on selection** to leave a range comment.

Accepted files: the word-level `.fframe.json` from [`tools/resolve/Export to Fframe.py`](../tools/resolve/Export%20to%20Fframe.py), Resolve's raw `GetTranscription()` JSON, `.srt`, `.vtt`, and timecoded `.txt` exports. SRT/VTT/TXT only have timing per phrase, so word timing is spread across the phrase (approximate). Timecodes with frames use the frame rate you pick (23.976 vs 24 matters on long clips); source timecode such as `01:00:00:00` is removed automatically, and the start can be adjusted in the ⋯ menu.

The Resolve script's JSON also carries the clip's or timeline's **markers**, which become **chapters** (see below). Each export replaces the chapter list.

Ways to attach one: upload it in the player, use **Import transcripts** on a project page (files are matched to videos by name, e.g. `A001.srt` → `A001.mov`), or put it next to the video in a Library folder (`A001.fframe.json`, `A001.srt`, …), where it's attached on the next rescan. Set `TRANSCRIPT_FPS` for Library `.txt` files (default 24). Stored in `data/transcripts/<assetId>.json`.

Routes: `GET /_api/assets/:id/transcript` (login), `PUT`/`PATCH`/`DELETE` same path and `POST /_api/projects/:id/transcripts` (admin session).

## Review page, chapters and share links

- The player is a full page: `/v/<assetId>` for the admin and `/s/<token>/v/<assetId>` for clients. The side panel has Chapters | Comments | Transcript tabs.
- **Chapters** are Resolve markers (`data/chapters.json`), synced by the Resolve export: `GET /_api/assets/:id/chapters`. Keys: ↑/↓ previous/next chapter, M mute, F fullscreen.
- **Project settings** (`project.settings`): `PATCH /_api/projects/:id/settings` with `chapters`, `transcript`. A feature that's off is hidden for the admin and blocked for clients.
- **Transcript export**: `GET /_api/assets/:id/transcript.doc` (and `/_s/<token>/transcript/<id>` when allowed) returns a Word-compatible `.doc`.
- **Share links** (`project.share` in `data/projects.json`): `GET/PATCH /_api/projects/:id/share` (admin session) with `enabled`, `allow_comments`, `allow_download_video`, `allow_download_transcript`, `regenerate`. Clients use `/_s/<token>/…` (info, assets, media, download, chapters, transcript, comments). Every request is checked against the token's project and settings. A guest is identified by a random `X-Guest-Id`, stored only as a hash, so they can delete only their own comments. The token is redacted from the request log.

## Branding

`lib/branding.js` keeps the app name, accent color, logo and favicon in `data/branding.json` and `data/branding/`. The server injects them into every page it sends (title, favicon, `data-brand-*` attributes, and `/_brand/theme.css` for the accent), so there's no flash of the default look. The manifest is generated too. Public: `GET /_brand`, `/_brand/theme.css`, `/_brand/logo`, `/_brand/favicon` (uploaded SVGs are served sandboxed). Admin: `GET/PUT /_api/branding`, `PUT/DELETE /_api/branding/{logo|favicon}` (raw image body, 3 MB max), `POST /_api/branding/reset`. Every accent shade in `app.css` derives from `--royal`, and text on it uses `--on-accent` (black or white, by contrast).

## Notifications

`lib/notify.js` records client activity on share links (`comment`, `reply`, `download`, `view`, `visit`) in `data/notifications.json`, and sends email through SMTP (nodemailer): right away (grouped after a minute of quiet), hourly, or daily at a chosen hour (`TZ`). Settings live in `data/notify.json`; the SMTP password is never returned to the browser. Admin-only routes: `GET /_api/notifications`, `POST /_api/notifications/read`, `GET/PUT /_api/notify/settings`, `POST /_api/notify/test-email`. The panel polls every 20 s for the bell.

Browser notifications use Web Push (`lib/push.js`, `web-push`), so they arrive with no Fframe tab open. VAPID keys are generated on first start in `data/vapid.json` (the private key never leaves the server; set `VAPID_SUBJECT` to override the contact, default `PUBLIC_BASE` when it is https). Each browser that turns the toggle on subscribes through `pushManager` and is stored in `data/push-subs.json`; admin-only routes: `GET /_api/push/key`, `POST /_api/push/subscription` (`{ subscription, test }`), `DELETE /_api/push/subscription` (`{ endpoint }`). Every event whose **In app** channel is on is pushed to all subscriptions; subscriptions the push service reports as gone (404/410) are removed. `public/sw.js` shows the notification (skipped when a panel tab is focused, which shows its own toast) and on click marks it read and opens `/v/<asset_id>?t=..&c=..`. Push needs a secure context (HTTPS, or `localhost`); otherwise the panel falls back to the in-page Notification API while a tab is open. Signing out unsubscribes that browser.

## Comments back to Resolve

- `GET /_api/resolve/comments[?project=]` (session or device key): every video with comments, top-level comments with replies, with `guest` for comments left through a share link. Used by [`tools/resolve/Import Fframe Comments.py`](../tools/resolve/Import%20Fframe%20Comments.py), which syncs them as red clip or timeline markers. Each marker is tagged `customData = "fframe:<commentId>"`, so re-running updates or removes them.
- `POST /_api/resolve/import` (session or device key): `{ files: [{ filename, content }], fps?, project_id? }`. Same matching as **Import transcripts**, but across all projects. Used by `tools/resolve/Export to Fframe.py` to upload transcripts and markers directly.
- `GET /_api/assets/:id/markers.edl?fps=&start=`: a marker EDL for **Timeline → Import → Timeline Markers from EDL**. The player's **⤓ Resolve** button downloads it.

## Panel language

This build of the panel is **English-only**. All text lives in `public/i18n.js` (`t("key")`). The Android app is still Portuguese-only.

## Structure

- `server.js` — routes (`/_ingest` for the app, `/_api/*` and panel media)
- `lib/store.js` — state (config, projects, assets, auth, devices, comments)
- `public/` — web panel (PWA): `dashboard.html`, `app.css`, `app.js`, `i18n.js` (translations)
- `data/` — runtime data (config, videos, logs, devices, `comments.json`) — **not versioned**
- `test-client.js` — simulates a full upload to test the server without a phone

### Where videos live (proxy → render workflow)

```
data/
├── uploads/<project>/<YYYY-MM-DD>/    # PROXIES (light) — day-to-day editing
└── originals/<project>/<YYYY-MM-DD>/  # ORIGINALS — point your editor here for the final render
```

The app uploads the proxy right away and keeps the original in a separate queue; later, on Wi-Fi, you
process that queue and the originals go to `originals/` (`POST /_ingest?kind=original`). Edit with the
proxies, then relink to the `originals/` folder before rendering.

## Security

- Panel protected by login (bcrypt + httpOnly/secure/sameSite session).
- **Multiple devices, each with its own key** (`data/devices.json`), generated with
  `crypto.randomBytes(24)`. Revoking a device doesn't affect the others.
- Data endpoints require a session **or** an active device key. **Managing devices
  (create/list/revoke) requires an admin session** — a device key alone cannot create or revoke
  other keys. Camera-protocol endpoints (`/oauth2`, `/v2`, `/_upload`) are left open out of
  protocol necessity.
- The device key should never go in a query string on new flows (only the `X-Device-Key`
  header) — avoids leaking into proxy/CDN logs.
- No private address/secret in the code — everything goes through `.env` and `data/`.

## License

MIT
