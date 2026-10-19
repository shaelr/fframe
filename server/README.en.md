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

The Resolve script's JSON also carries the clip's **markers**, which are synced as comments (author "Resolve", `color` = marker color, range if the marker has a duration). Each one is keyed by its frame, so re-importing updates or removes them and keeps replies and resolved state.

Ways to attach one: upload it in the player, use **Import transcripts** on a project page (files are matched to videos by name, e.g. `A001.srt` → `A001.mov`), or put it next to the video in a Library folder (`A001.fframe.json`, `A001.srt`, …), where it's attached on the next rescan. Set `TRANSCRIPT_FPS` for Library `.txt` files (default 24). Stored in `data/transcripts/<assetId>.json`.

Routes: `GET /_api/assets/:id/transcript` (login), `PUT`/`PATCH`/`DELETE` same path and `POST /_api/projects/:id/transcripts` (admin session).

## Comments back to Resolve

- `GET /_api/resolve/comments[?project=]` (session or device key): every video with comments, top-level comments with replies, and `from_resolve` for comments that came from Resolve markers. Used by [`tools/resolve/Import Fframe Comments.py`](../tools/resolve/Import%20Fframe%20Comments.py), which syncs them as clip or timeline markers. Each marker is tagged `customData = "fframe:<commentId>"`, so re-running updates or removes them.
- `POST /_api/resolve/import` (session or device key): `{ files: [{ filename, content }], fps?, project_id? }`. Same matching as **Import transcripts**, but across all projects. Used by `tools/resolve/Export to Fframe.py` to upload transcripts and markers directly.
- `GET /_api/assets/:id/markers.edl?fps=&start=`: a marker EDL for **Timeline → Import → Timeline Markers from EDL**. The player's **⤓ Resolve** button downloads it.

## Panel languages

The panel ships in **Portuguese** and **English**, with a dropdown on the login screen and in the
sidebar (your choice is saved in the browser; on first visit it follows your browser's language).
The Android app remains **Portuguese-only**.

To add a language, copy a block in `public/i18n.js`, translate the values, and that's it — the
dropdown lists it automatically. Missing keys fall back to Portuguese.

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
