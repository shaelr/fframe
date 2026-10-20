# Installing Fframe on TrueNAS SCALE

This guide is for TrueNAS SCALE 24.10 (Electric Eel) or newer, which runs apps on Docker.

This build of Fframe ([github.com/shaelr/fframe](https://github.com/shaelr/fframe)) adds a **Library**. An admin can pick folders that are already on the NAS (for example `SMB_Share`) and add them to a project. The videos are not copied. Fframe indexes them and plays them from where they are. The share is mounted **read-only**, so Fframe can't change or delete anything in it.

Fframe's own data (phone uploads, projects, comments, transcripts and the admin login) works like Nextcloud's default storage: TrueNAS creates and manages it inside its apps dataset, so there's no dataset to create. If you'd rather keep it in a dataset you choose, see the note at the bottom of the YAML.

> **Check your real path first.** Go to **Datasets**, click **SMB_Share**, and look at its **Path**. The YAML assumes `/mnt/Pool 1/SMB_Share`. If yours is different, use your path everywhere below.

## 1. Let Fframe read SMB_Share

The app runs as the TrueNAS user **`apps`** (UID 568), the same user TrueNAS's own apps use. That user needs read access to the share:

1. Go to **Datasets → SMB_Share → Permissions → Edit**.
2. Add an ACL entry: **User → `apps`**, permissions **Read**, and enable **Apply permissions recursively**.
3. Save. This only adds read access. Your SMB users keep the access they have now.

## 2. Edit the YAML

Open [fframe.yaml](fframe.yaml) and check the two values marked **EDIT ME**:

| # | What | Default |
|---|---|---|
| 1 | Library share (read-only) | `/mnt/Pool 1/SMB_Share` |
| 2 | `PUBLIC_BASE`, the address your phone uses to reach the server | `http://192.168.1.100:3260` (use your NAS IP) |

If port 3260 is already in use, change the left number in `"3260:3000"`.

## 3. Install

1. Go to **Apps → Discover Apps**, open the **⋮** menu, and choose **Install via YAML**.
2. Name the app `fframe` and paste in the YAML.
3. Click **Save**.

TrueNAS downloads the ready-made Fframe image (`ghcr.io/shaelr/fframe`) and starts it, the same way it starts Nextcloud. No files need to be copied to the NAS.

## 4. Use it

1. Go to `http://<NAS-IP>:3260` and create your admin login.
2. In the sidebar, open **📁 Library**. Browse into a folder, then click **add**, or click **＋ Add this folder** for the folder you're in.
3. Choose a project, or **New project "<folder name>"**, and decide whether to include subfolders.
4. The videos appear in that project, where you can play, comment and download them.

Notes:
- **New files aren't picked up automatically.** Click **rescan** on the linked folder. All linked folders are also rescanned each time the app starts. Comments are kept across rescans.
- **"remove"** on a library video only hides it in Fframe. **"unlink"** removes the folder's videos and their comments from Fframe. Neither one touches the files on the NAS.
- **Browser playback:** browsers can play MP4/MOV (H.264, and HEVC in Safari) and WebM. Other formats such as MXF, MKV, AVI and MTS still show up and can be downloaded, but may not play in the browser.
- Only an admin logged into the panel can use the Library. A paired phone's device key can't browse it.

## Updating

Every change pushed to [github.com/shaelr/fframe](https://github.com/shaelr/fframe) is built into a new image automatically, in about 5 minutes. To install the newest build, go to **Apps → fframe → Edit** and click **Save** without changing anything. Your data isn't touched.

To pin a version instead, change `:latest` in the YAML to a build tag such as `:sha-1a2b3c4`. The tags are listed on the repo's **Packages** page. Pinning is also how you roll back.

## DaVinci Resolve scripts

Two Resolve scripts work as a pair:

- **Export to Fframe** sends transcripts and markers from Resolve to Fframe.
- **Import Fframe Comments** brings client comments from Fframe back into Resolve as markers.

**One-time setup (shared by both scripts)**
1. Copy both files from [`tools/resolve/`](../tools/resolve) to `~/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility/`.
2. In Fframe, go to **Devices → Add device**, name it `Resolve`, and click **key** to copy its key.
3. The first time you run either script, it asks for the Fframe address (for example `http://192.168.1.50:3260`) and that key, and saves them to `~/.fframe-resolve.json`. To change them later, edit or delete that file. If you revoke the "Resolve" device in Fframe, both scripts stop connecting.

## Transcripts and markers: Resolve → Fframe

The player has a **Transcript** tab that works like Resolve's: click a word to jump to it, watch the words light up as they're spoken, search the text, or select a passage and click **Comment on selection**.

1. In Resolve, transcribe your clips or your whole timeline (right-click → **Audio Transcription → Transcribe**), add markers, or both. A timeline's transcript and its markers go to the Fframe video named like the timeline.
2. Select the clips in the Media Pool, then run **Workspace → Scripts → Utility → Export to Fframe**.
3. The script uploads straight to Fframe. Each clip is matched to the Fframe video with the same file name, in any project. Open **Workspace → Console** to see what was sent where.

If a clip has no matching video in Fframe yet, or Fframe can't be reached, the script saves an `A001.fframe.json` file next to the media instead. If that folder is linked in the Library, it attaches on the next **rescan**. Otherwise, upload it later with **📝 Import transcripts**. To change this, set `SAVE_FILES` at the top of the script: `"always"` keeps a file for every clip, and `"never"` only uploads.

**Markers become chapters.** Clip markers (added in the Source viewer or on the Media page) go to the Fframe video with the clip's file name. **Timeline markers** (on the timeline ruler) go to the Fframe video named like the timeline. For example, upload your render of timeline `FSWC Review` as `FSWC Review.mp4`, then select the timeline in the Media Pool (or just have it open) and run the script. Case, spaces, underscores and dashes don't matter, so `FSWC_Review.mp4` matches too.

In Fframe's review page each marker is a **chapter**: a tick in the marker's color on the playback bar, a row in the **Chapters** tab (click to jump), and the ⏮ / ⏭ buttons or the **↑ / ↓** keys to jump between chapters. The chapter title is the marker's name; if the name is Resolve's default ("Marker 3"), its note is used instead. Running the script again replaces the chapters, so markers you renamed, moved or deleted in Resolve are updated in Fframe. Markers on individual clips inside a timeline aren't exported.

**Also works: Resolve's own exports (.srt, .vtt, .txt)**
Upload them in the player, or use **📝 Import transcripts** on the project page. Files are matched to videos by name. These formats only have timing per phrase, so word highlighting is approximate. For `.txt` files, Fframe asks for the timeline frame rate. If the text runs early or late, set the clip's start timecode in the transcript **⋯** menu.

## Client comments back into Resolve

Comments from Fframe, yours and your clients', come back into Resolve as **red markers**. The marker name is who wrote the comment, and the marker's **Notes** field holds the comment and its replies. Resolved comments say "(resolved in Fframe)". Range comments become markers with a duration. Chapters (your own Resolve markers) never come back as comments.

**Option A: the "Import Fframe Comments" script (clips and timelines, updates on every run)**
1. Do the one-time setup above.
2. In Resolve, select clips in the Media Pool, then run **Workspace → Scripts → Utility → Import Fframe Comments**.
   - **Clips:** each selected clip gets markers from the Fframe video with the same file name.
   - **Timeline:** if you uploaded a render of a timeline, for example `Cut v3.mp4` from timeline `Cut v3`, open that timeline. Its comments become timeline markers.
3. Run it again whenever the client adds feedback. Existing markers are updated, markers for deleted comments are removed, and your own markers are never touched. Markers that came from Resolve through the export script aren't imported back.

**Option B: no script, timeline only**
In the Fframe player, click **⤓ Resolve**, enter the timeline's frame rate and start timecode, and download the `.edl`. Then in Resolve, open the timeline and use **Timeline → Import → Timeline Markers from EDL**. Use this for a one-off. Importing again adds a second copy instead of updating.

## Notifications

Fframe tells you when clients act on your share links. Your own activity never notifies you.

- **🔔 Bell** (top of the sidebar): the number shows unread activity, which also appears in the browser tab's title. Click it to see the list, then click an item to jump to that exact moment in the video, with the comment highlighted. **Mark all read** clears the count.
- **🔔 Notifications** (sidebar, under Settings) chooses what you're told about, **In app** and by **Email** separately: new comments, replies, downloads, videos watched and the project link being opened.
- **Browser notifications:** turn on **Show browser notifications** and allow it when the browser asks. New activity pops up as a system notification **even when Fframe isn't open** (Web Push), and clicking it opens the video at the comment. A test notification arrives right away to confirm it works. This is set per browser, so turn it on in each one you use; turn it off, or sign out, and that browser stops getting them.
  - It needs Fframe opened over **HTTPS** (for example `https://review.sixfeatmedia.com` through Cloudflare). Over plain `http://` on your LAN it falls back to notifying only while a Fframe tab is open. The browser itself must be running (in the background is fine); on macOS, allow notifications for your browser in System Settings → Notifications.
  - The push keys are created on first start in `data/vapid.json`. Keep that file with your backups: if it's lost, turn the toggle off and on again in each browser.
- **Email:** turn on **Send email notifications**, enter who to send to, and choose **Right away** (several comments in a row arrive as one email), **Hourly summary** or **Daily summary**. Then fill in your mail server under **Mail server (SMTP)** and click **Send test email**.
  - Gmail: server `smtp.gmail.com`, port `465`, SSL/TLS on, your Gmail address as the username, and an [app password](https://myaccount.google.com/apppasswords) (not your normal password).
  - Microsoft 365 / Outlook: server `smtp.office365.com`, port `587`, SSL/TLS off.
  - Links in emails use `PUBLIC_BASE` from the YAML, so set it to the address you open Fframe at (for example `https://review.sixfeatmedia.com`).
  - The daily summary uses the timezone in the YAML (`TZ`). Set it to yours, for example `America/Toronto`.

## Branding

Click **🎨 Branding** (sidebar, under Settings) to make Fframe look like your company. It applies to you and to clients on share links, in notification emails, in browser notifications and in exported Word transcripts.

- **App name** replaces "Fframe" in the browser tab, the login screen, emails and everywhere else.
- **Highlight color** is used for buttons, the playhead, chapter numbers and highlights. Pick one of the presets or enter a hex code; the page previews it live. Text on top switches between black and white automatically, so light colors stay readable. Click **Save** to keep it.
- **Logo** replaces the dot and name at the top of the sidebar, the login screen and the client pages. Use a white or light version, because the background is dark. A transparent PNG about 400 px wide works best, since most email apps don't show SVG logos.
- **Favicon** is the tab icon (also used for bookmarks and browser notifications). Use a square PNG of at least 192 × 192, or an SVG.
- **Reset to Fframe defaults** puts everything back.

## Project settings

Click **⚙ Settings** in a project to turn **Chapters** or **Transcripts** off for projects that don't use them. They're hidden for you and for anyone viewing the share link, including the tabs, the chapter buttons and the transcript download. Your data isn't deleted, so turning a setting back on brings everything back.

## The review page

- **Download** gets the video, or the transcript as a Word document (.doc) with the title, chapters as headings, speaker names and timecodes.
- **⌨ Shortcuts** (or press **?**) lists the keyboard shortcuts. You and your clients both see it.
- **Full screen** (the ⛶ button, or **F**) puts the whole review page in full screen, so you can still read and write comments and jump between chapters. On iPhone, Safari only allows full screen for the video itself.

## Sharing a project with a client

Clients review on a private link with no account or login, the same way Frame.io works.

1. Open the project and click **🔗 Share**.
2. Turn on **Share link** and click **Copy**. Send that link to your client.
3. Choose what the client can do:
   - **Comment**: leave comments and replies (on by default).
   - **Download videos**: download the video files (off by default).
   - **Download transcripts**: download a video's transcript as a Word document (.doc) (off by default).

   When both downloads are allowed, the **download** button opens a small menu to pick **Video** or **Transcript (.doc)**.

When the client opens the link, they're asked for their name once. Their comments show that name, with a "guest" label for you. Clients can reply and delete their own comments. Resolving comments, deleting anyone else's, transcript settings and the Resolve EDL button are only for you.

To stop access, turn **Share link** off. **New link** replaces the URL, and the old one stops working immediately. Only people with the link can open it, so share it like a password.

## Troubleshooting

- **Logs:** go to Apps → fframe, then view the logs for the `fframe` container.
- **Library is missing from the sidebar:** the share isn't mounted at `/library`. Check EDIT ME #1.
- **"Error: EACCES" on a linked folder:** the `apps` user can't read it. Redo step 1.
- **Install fails with a pull error:** the NAS needs internet access to reach `ghcr.io`.
