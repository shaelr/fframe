"""Export to Fframe — DaVinci Resolve script (transcripts + markers).

Sends the word-level audio transcription AND the clip markers of media pool
clips straight to Fframe. In Fframe the transcript becomes click-to-seek text
and each marker becomes a comment (with its color) on the playback bar.
Clip markers (added in the Source viewer / Media page) go to the Fframe video
with the clip's file name. TIMELINE markers (on the timeline ruler) and a transcription made on the
timeline itself go to the Fframe video named like the timeline, e.g. your render "FSWC Review.mp4" of
timeline "FSWC Review": select the timeline in the Media Pool, or just have it
open. Markers on individual clips inside a timeline are not exported.

Install: copy this file to
  macOS:   ~/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility/
  Windows: %APPDATA%\\Blackmagic Design\\DaVinci Resolve\\Support\\Fusion\\Scripts\\Utility\\
then run it from Workspace > Scripts > Utility > Export to Fframe.

Setup (once, shared with "Import Fframe Comments"): in Fframe go to Devices ->
Add device, name it "Resolve" and copy its key. The first run asks for the
Fframe address and that key and saves them to ~/.fframe-resolve.json.

Usage: transcribe your clips in Resolve (right-click > Audio Transcription >
Transcribe) and/or add markers, select them in the Media Pool (or open their
bin) and run the script. Each clip is matched to the Fframe video with the same
file name (in any project). Re-exporting updates the transcript and markers in
Fframe instead of duplicating them.

Clips with no matching video in Fframe yet (or when Fframe can't be reached)
are saved as "<clip>.fframe.json" next to the media instead; if that folder is
linked in Fframe's Library they attach on the next rescan, or you can upload
them later. See SAVE_FILES below.
"""

import json
import os
import urllib.error
import urllib.request

# "fallback" = save a .fframe.json only for clips that couldn't be sent;
# "always" = also save one for every clip; "never" = only upload.
SAVE_FILES = "fallback"
CONFIG_FILE = os.path.join(os.path.expanduser("~"), ".fframe-resolve.json")
OUTPUT_DIR = None  # None = next to each media file; or e.g. "/Users/me/Desktop/Fframe Transcripts"
FALLBACK_DIR = os.path.join(os.path.expanduser("~"), "Desktop", "Fframe Transcripts")
SILENCE = {"(...)", "…", "(blank audio)", "(silence)"}


def get_resolve():
    g = globals()
    if g.get("resolve"):
        return g["resolve"]
    if g.get("bmd"):
        return g["bmd"].scriptapp("Resolve")
    import DaVinciResolveScript as dvr  # noqa: E402  (external scripting)
    return dvr.scriptapp("Resolve")


# ---- HTTPS ------------------------------------------------------------------
# python.org Python on macOS ships without trusted CA certificates (until its
# "Install Certificates.command" is run), so verification fails even for valid
# certificates. Fall back to certifi or the system bundle. Cloudflare also
# blocks Python's default user agent, so send our own.
USER_AGENT = "Fframe-Resolve/1.0 (DaVinci Resolve script)"


def ssl_context():
    import ssl
    paths = ssl.get_default_verify_paths()
    if (paths.cafile and os.path.exists(paths.cafile)) or (paths.openssl_cafile and os.path.exists(paths.openssl_cafile)):
        return ssl.create_default_context()
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        pass
    for f in ("/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt"):
        if os.path.exists(f):
            return ssl.create_default_context(cafile=f)
    return ssl.create_default_context()


# ---- Fframe connection (same config file as "Import Fframe Comments") -------
def ask_config(resolve, cfg):
    """Small dialog for the Fframe URL and device key. Returns cfg or None."""
    try:
        ui = resolve.Fusion().UIManager
        disp = globals()["bmd"].UIDispatcher(ui)
    except Exception:
        return None
    win = disp.AddWindow(
        {"ID": "FframeCfg", "WindowTitle": "Fframe connection", "Geometry": [400, 300, 460, 170]},
        ui.VGroup([
            ui.Label({"Text": "Fframe address (e.g. http://192.168.1.50:3260)"}),
            ui.LineEdit({"ID": "url", "Text": cfg.get("url", "")}),
            ui.Label({"Text": "Device key (Fframe > Devices > Add device)"}),
            ui.LineEdit({"ID": "key", "Text": cfg.get("key", ""), "EchoMode": "Password"}),
            ui.HGroup([ui.HGap(), ui.Button({"ID": "cancel", "Text": "Cancel"}), ui.Button({"ID": "ok", "Text": "Save"})]),
        ]),
    )
    result = {}
    items = win.GetItems()

    def on_ok(ev):
        result["url"] = items["url"].Text.strip().rstrip("/")
        result["key"] = items["key"].Text.strip()
        disp.ExitLoop()

    win.On.ok.Clicked = on_ok
    win.On.cancel.Clicked = lambda ev: disp.ExitLoop()
    win.On.FframeCfg.Close = lambda ev: disp.ExitLoop()
    win.Show()
    disp.RunLoop()
    win.Hide()
    if not result.get("url") or not result.get("key"):
        return None
    cfg.update(result)
    return cfg


def load_config(resolve):
    cfg = {}
    try:
        with open(CONFIG_FILE, encoding="utf-8") as fh:
            cfg = json.load(fh)
    except (OSError, ValueError):
        pass
    if not cfg.get("url") or not cfg.get("key"):
        cfg = ask_config(resolve, cfg)
        if not cfg:
            return None
        with open(CONFIG_FILE, "w", encoding="utf-8") as fh:
            json.dump(cfg, fh, indent=2)
        try:
            os.chmod(CONFIG_FILE, 0o600)
        except OSError:
            pass
    return cfg


def upload(cfg, files):
    """POSTs [{filename, content}] in batches. Returns {filename: result}."""
    out, batch, size = {}, [], 0

    def send(items):
        body = json.dumps({"files": items}).encode("utf-8")
        req = urllib.request.Request(cfg["url"].rstrip("/") + "/_api/resolve/import", data=body, method="POST",
                                     headers={"X-Device-Key": cfg["key"], "Content-Type": "application/json",
                                              "User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=120, context=ssl_context()) as r:
            for res in json.loads(r.read().decode("utf-8"))["results"]:
                out[res["filename"]] = res

    for f in files:
        n = len(f["content"])
        if batch and size + n > 8 * 1024 * 1024:
            send(batch)
            batch, size = [], 0
        batch.append(f)
        size += n
    if batch:
        send(batch)
    return out


def tc_frames(tc, base):
    """'01:02:03:04' (';' = drop-frame) -> frame count at nominal rate.
    Timeline transcriptions can start before 0 ("-00:00:04:08"): negative."""
    tc = str(tc or "").strip()
    sign = -1 if tc.startswith("-") else 1
    parts = tc.lstrip("-+").replace(";", ":").split(":")
    if len(parts) != 4:
        return None
    try:
        h, m, s, f = (int(p) for p in parts)
    except ValueError:
        return None
    return sign * (((h * 60 + m) * 60 + s) * base + f)


def markers(clip, fps):
    """Clip markers -> [{t, end, frame, color, name, note}] (seconds from clip start)."""
    out = []
    for frame, info in sorted((clip.GetMarkers() or {}).items()):
        frame = int(frame)
        dur = int(info.get("duration") or 1)
        out.append({
            "frame": frame,
            "t": round(frame / fps, 3),
            "end": round((frame + dur) / fps, 3) if dur > 1 else None,
            "color": info.get("color"),
            "name": info.get("name") or "",
            "note": info.get("note") or "",
        })
    return out


def segments(segs, fps, start_tc):
    """Resolve transcription segments -> Fframe segments (seconds from the start).
    Timecodes are source/timeline TC on some clips: made relative to `start_tc`."""
    base = round(fps)
    start = tc_frames(start_tc, base) or 0
    first = min((tc_frames(s.get("start"), base) or 0) for s in segs) if segs else 0
    off = start if start and first >= start else 0

    def sec(tc):
        f = tc_frames(tc, base)
        return None if f is None else round(max(0, f - off) / fps, 3)

    out = []
    for s in segs:
        words = []
        for w in s.get("words") or []:
            text = (w.get("text") or "").strip()
            if not text or text.lower() in SILENCE:
                continue
            words.append({"t": sec(w.get("start")), "end": sec(w.get("end")), "text": text})
        text = " ".join(w["text"] for w in words) if words else (s.get("text") or "").strip()
        if not text or text.lower() in SILENCE:
            continue
        out.append({"t": sec(s.get("start")), "end": sec(s.get("end")),
                    "speaker": s.get("speaker"), "text": text, "words": words})
    return out


def build(clip, project_fps):
    """Returns the Fframe JSON dict for a MediaPoolItem, or None."""
    try:
        fps = float(clip.GetClipProperty("FPS") or project_fps)
    except (TypeError, ValueError):
        fps = float(project_fps or 24)
    marks = markers(clip, fps)
    tr = clip.GetTranscription() or {}
    segs = tr.get("segments") or []
    if not segs and not marks:
        return None
    out = segments(segs, fps, clip.GetClipProperty("Start TC"))
    if not out and not marks:
        return None
    return {
        "fframe_transcript": 1,
        "clip": clip.GetName(),
        "file": clip.GetClipProperty("File Name"),
        "fps": fps,
        "start_tc": clip.GetClipProperty("Start TC"),
        "language": tr.get("language"),
        "segments": out,
        "markers": marks,
    }


class TimelineTarget:
    """Lets a Timeline go through the same send/save code as a clip."""

    def __init__(self, tl):
        self.tl = tl

    def GetName(self):
        return "timeline " + self.tl.GetName()

    def GetClipProperty(self, key):
        return self.tl.GetName() if key == "File Name" else ""


def build_timeline(tl, item, project_fps):
    """Timeline -> Fframe JSON: its ruler markers, plus the transcription made
    on the timeline itself (stored on its Media Pool item `item`)."""
    try:
        fps = float(tl.GetSetting("timelineFrameRate") or project_fps)
    except (TypeError, ValueError):
        fps = float(project_fps or 24)
    marks = markers(tl, fps)
    tr = {}
    if item:
        try:
            tr = item.GetTranscription() or {}
        except Exception:
            tr = {}
    segs = segments(tr.get("segments") or [], fps, tl.GetStartTimecode())
    if not marks and not segs:
        return None
    return {
        "fframe_transcript": 1, "clip": tl.GetName(), "file": tl.GetName(), "timeline": True,
        "fps": fps, "start_tc": tl.GetStartTimecode(), "language": tr.get("language"), "segments": segs, "markers": marks,
    }


def timeline_item(pool, name):
    """The Media Pool item of a timeline (where a timeline's transcription lives)."""
    def walk(folder):
        for c in folder.GetClipList() or []:
            if c.GetClipProperty("Type") == "Timeline" and c.GetName() == name:
                return c
        for sub in folder.GetSubFolderList() or []:
            hit = walk(sub)
            if hit:
                return hit
        return None
    return walk(pool.GetRootFolder())


def find_timeline(project, name):
    for i in range(1, (project.GetTimelineCount() or 0) + 1):
        tl = project.GetTimelineByIndex(i)
        if tl and tl.GetName() == name:
            return tl
    return None


def file_stem(clip):
    media = clip.GetClipProperty("File Path") or ""
    return os.path.splitext(os.path.basename(media) or clip.GetClipProperty("File Name") or clip.GetName())[0]


def write(doc, clip):
    media = clip.GetClipProperty("File Path") or ""
    targets = [OUTPUT_DIR] if OUTPUT_DIR else [os.path.dirname(media), FALLBACK_DIR]
    for d in targets:
        if not d:
            continue
        try:
            os.makedirs(d, exist_ok=True)
            path = os.path.join(d, file_stem(clip) + ".fframe.json")
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(doc, fh, ensure_ascii=False)
            return path
        except OSError:
            continue
    return None


def main():
    resolve = get_resolve()
    project = resolve.GetProjectManager().GetCurrentProject()
    if not project:
        print("Fframe: no project open.")
        return
    pool = project.GetMediaPool()
    clips = pool.GetSelectedClips() or []
    if not clips:
        folder = pool.GetCurrentFolder()
        clips = folder.GetClipList() if folder else []
    fps = project.GetSetting("timelineFrameRate") or 24

    # Timelines: the ones selected in the Media Pool, plus the open one.
    timelines = {}                                   # name -> (Timeline, its Media Pool item)
    for item in [c for c in clips if c.GetClipProperty("Type") == "Timeline"]:
        clips.remove(item)
        tl = find_timeline(project, item.GetName())
        if tl:
            timelines[tl.GetName()] = (tl, item)
    current = project.GetCurrentTimeline()
    if current and current.GetName() not in timelines:
        timelines[current.GetName()] = (current, timeline_item(pool, current.GetName()))

    docs, empty = [], []
    for name, (tl, item) in timelines.items():
        doc = build_timeline(tl, item, fps)
        target = TimelineTarget(tl)
        if doc:
            docs.append((target, doc, name + ".fframe.json"))
        elif tl is not current:
            empty.append(target.GetName())
    for clip in clips:
        doc = build(clip, fps)
        if doc:
            docs.append((clip, doc, file_stem(clip) + ".fframe.json"))
        else:
            empty.append(clip.GetName())
    if not docs:
        print("Fframe: nothing to send - no transcription or markers on the selected clips or the open timeline.")
        return

    results, problem = {}, None
    cfg = load_config(resolve)
    if not cfg:
        problem = "no Fframe address/key set (edit %s or run again)" % CONFIG_FILE
    else:
        try:
            results = upload(cfg, [{"filename": fn, "content": json.dumps(doc, ensure_ascii=False)} for _, doc, fn in docs])
        except urllib.error.HTTPError as e:
            problem = "Fframe answered %s%s" % (e.code, " - device key wrong or revoked" if e.code == 401 else "")
        except Exception as e:  # network, DNS, bad URL
            problem = "could not reach %s (%s)" % (cfg["url"], e)

    sent, saved, failed = [], [], []
    for clip, doc, fn in docs:
        res = results.get(fn) or {}
        if res.get("ok"):
            where = ", ".join("%s (%s)" % (v["name"], v["project"]) for v in res.get("videos") or [])
            what = []
            if res.get("transcript"):
                what.append("transcript")
            if res.get("markers"):
                what.append("%d marker(s)" % res["markers"])
            sent.append("%s -> %s: %s" % (clip.GetName(), where, " + ".join(what) or "updated"))
        if SAVE_FILES == "always" or (SAVE_FILES == "fallback" and not res.get("ok")):
            path = write(doc, clip)
            if path and not res.get("ok"):
                reason = ("no video named like it in Fframe yet - upload the render as \"%s.mp4\"" % doc["clip"]
                          if doc.get("timeline") else "no video named like it in Fframe yet") if res.get("error") in ("no video with that name", "nenhum video com esse nome") else (res.get("error") or problem or "not sent")
                saved.append("%s (%s) -> %s" % (clip.GetName(), reason, path))
            elif not path and not res.get("ok"):
                failed.append(clip.GetName())
        elif not res.get("ok"):
            failed.append(clip.GetName())

    if problem:
        print("Fframe: upload failed: %s." % problem)
    print("Fframe: sent %d item(s) to Fframe." % len(sent))
    for line in sent:
        print("  ->", line)
    if saved:
        print("Fframe: saved %d item(s) as files instead:" % len(saved))
        for line in saved:
            print("  ->", line)
    if failed:
        print("Fframe: could not send or save %d clip(s):" % len(failed))
        for n in failed:
            print("  -", n)
    if empty:
        print("Fframe: skipped %d clip(s) with no transcription or markers." % len(empty))


main()
