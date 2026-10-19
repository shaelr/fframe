"""Import Fframe Comments — DaVinci Resolve script.

Pulls the review comments from Fframe and adds them as MARKERS in Resolve, so
you can jump straight to each note while editing:

  * Media Pool clips: select clips (or open their bin) -> each clip gets a
    marker per comment on the Fframe video with the same file name.
  * Current timeline: if an Fframe video is named like the timeline (e.g. you
    uploaded a render "Cut v3.mp4" of timeline "Cut v3"), its comments become
    timeline markers.

Every comment becomes a RED marker: the marker name is who wrote it and the
marker's Notes field holds the comment and its replies (resolved comments say
"(resolved in Fframe)"). Range comments get a duration. Run it again any time:
markers are updated in place and removed when the comment is deleted. Your own
markers are never touched, and Resolve markers sent with "Export to Fframe"
(chapters in Fframe) never come back as comments.

Setup (once): in Fframe go to Devices -> Add device, name it "Resolve" and copy
its key. The first run asks for the Fframe address and that key and saves them
to ~/.fframe-resolve.json.

Install: copy this file to
  macOS:   ~/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility/
  Windows: %APPDATA%\\Blackmagic Design\\DaVinci Resolve\\Support\\Fusion\\Scripts\\Utility\\
then run Workspace > Scripts > Utility > Import Fframe Comments.
"""

import json
import os
import urllib.error
import urllib.request

CONFIG_FILE = os.path.join(os.path.expanduser("~"), ".fframe-resolve.json")
DEFAULTS = {"url": "", "key": ""}
MARKER_COLOR = "Red"
TAG = "fframe:"


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


# ---- Resolve / UI -----------------------------------------------------------
def get_resolve():
    g = globals()
    if g.get("resolve"):
        return g["resolve"]
    if g.get("bmd"):
        return g["bmd"].scriptapp("Resolve")
    import DaVinciResolveScript as dvr  # noqa: E402  (external scripting)
    return dvr.scriptapp("Resolve")


def ask_config(resolve, cfg):
    """Small dialog for the Fframe URL and device key. Returns cfg or None."""
    try:
        fu = resolve.Fusion()
        ui = fu.UIManager
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
    cfg = dict(DEFAULTS)
    try:
        with open(CONFIG_FILE, encoding="utf-8") as fh:
            cfg.update(json.load(fh))
    except (OSError, ValueError):
        pass
    if not cfg["url"] or not cfg["key"]:
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


def fetch_comments(cfg):
    req = urllib.request.Request(cfg["url"].rstrip("/") + "/_api/resolve/comments",
                                 headers={"X-Device-Key": cfg["key"], "User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30, context=ssl_context()) as r:
        return json.loads(r.read().decode("utf-8"))


# ---- Matching and markers ---------------------------------------------------
def key_of(name):
    """Same rule as Fframe: case, extension and space/_/- differences don't matter."""
    import re
    n = os.path.basename(str(name or "")).lower().strip()
    stem, ext = os.path.splitext(n)
    return re.sub(r"[\s_-]+", " ", stem if ext else n).strip()


def desired_markers(video, fps, cfg):
    """Fframe comments -> {comment_id: marker dict} at the given frame rate."""
    out = {}
    for c in video["comments"]:
        if c.get("from_resolve"):
            continue
        frame = max(0, int(round(float(c["t"]) * fps)))
        dur = 1
        if c.get("t_end") is not None:
            dur = max(1, int(round((float(c["t_end"]) - float(c["t"])) * fps)))
        lines = [c["text"]] + ["↳ %s: %s" % (r["author"], r["text"]) for r in c.get("replies") or []]
        if c.get("resolved"):
            lines.append("(resolved in Fframe)")
        out[c["id"]] = {
            "frame": frame, "duration": dur,
            "color": MARKER_COLOR,
            "name": c.get("author") or "Fframe",
            "note": "\n".join(lines)[:4000],
        }
    return out


def sync(target, wanted):
    """Applies `wanted` to a MediaPoolItem or Timeline. Returns (added, updated, removed)."""
    existing = {}
    for frame, info in (target.GetMarkers() or {}).items():
        cd = info.get("customData") or ""
        if cd.startswith(TAG):
            existing[cd[len(TAG):]] = (int(frame), info)
    added = updated = removed = 0
    for cid, (frame, info) in existing.items():
        if cid not in wanted:
            target.DeleteMarkerAtFrame(frame)
            removed += 1
    taken = {int(f) for f in (target.GetMarkers() or {})}
    for cid, m in wanted.items():
        cur = existing.get(cid)
        if cur:
            frame, info = cur
            # a marker nudged off a taken frame (see below) still counts as in place
            same = (m["frame"] <= frame < m["frame"] + 10 and info.get("color") == m["color"] and info.get("note") == m["note"]
                    and int(info.get("duration") or 1) == m["duration"] and info.get("name") == m["name"])
            if same:
                continue
            target.DeleteMarkerAtFrame(frame)
            taken.discard(frame)
        # one marker per frame in Resolve: nudge forward if the frame is taken
        f = m["frame"]
        while f in taken and f < m["frame"] + 10:
            f += 1
        if target.AddMarker(f, m["color"], m["name"], m["note"], m["duration"], TAG + cid):
            taken.add(f)
            if cur:
                updated += 1
            else:
                added += 1
    return added, updated, removed


def clip_fps(clip, default):
    try:
        return float(clip.GetClipProperty("FPS") or default)
    except (TypeError, ValueError):
        return float(default or 24)


def main():
    resolve = get_resolve()
    project = resolve.GetProjectManager().GetCurrentProject()
    if not project:
        print("Fframe: no project open.")
        return
    cfg = load_config(resolve)
    if not cfg:
        print("Fframe: no address/key set. Edit %s or run the script again." % CONFIG_FILE)
        return
    try:
        videos = fetch_comments(cfg)
    except urllib.error.HTTPError as e:
        print("Fframe: server said %s. If 401, the device key is wrong or revoked (fix it in %s)." % (e.code, CONFIG_FILE))
        return
    except Exception as e:  # network, DNS, bad URL
        print("Fframe: could not reach %s (%s)." % (cfg["url"], e))
        return
    by_key = {}
    for v in videos:
        by_key.setdefault(key_of(v["name"]), []).append(v)
    proj_fps = project.GetSetting("timelineFrameRate") or 24

    pool = project.GetMediaPool()
    clips = pool.GetSelectedClips() or []
    if not clips:
        folder = pool.GetCurrentFolder()
        clips = folder.GetClipList() if folder else []

    report = []
    for clip in clips:
        name = clip.GetClipProperty("File Name") or clip.GetName()
        matches = by_key.get(key_of(name)) or by_key.get(key_of(clip.GetName()))
        if not matches:
            continue
        fps = clip_fps(clip, proj_fps)
        wanted = {}
        for v in matches:
            wanted.update(desired_markers(v, fps, cfg))
        a, u, r = sync(clip, wanted)
        report.append("clip %s: +%d new, %d updated, %d removed" % (clip.GetName(), a, u, r))

    tl = project.GetCurrentTimeline()
    if tl and by_key.get(key_of(tl.GetName())):
        try:
            fps = float(tl.GetSetting("timelineFrameRate") or proj_fps)
        except (TypeError, ValueError):
            fps = float(proj_fps)
        wanted = {}
        for v in by_key[key_of(tl.GetName())]:
            wanted.update(desired_markers(v, fps, cfg))
        a, u, r = sync(tl, wanted)
        report.append("timeline %s: +%d new, %d updated, %d removed" % (tl.GetName(), a, u, r))

    total = sum(len([c for c in v["comments"] if not c.get("from_resolve")]) for v in videos)
    print("Fframe: %d video(s) with %d comment(s) on the server." % (len(videos), total))
    if report:
        for line in report:
            print("  " + line)
    else:
        print("Fframe: nothing matched. Select the clips in the Media Pool (same file names as in Fframe),")
        print("        or open a timeline named like the Fframe video.")


main()
