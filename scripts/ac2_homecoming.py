#!/usr/bin/env python3
"""
Receives "coming home" from the Farm Homecoming phone app and tells AC v2 to get the house comfortable.
Runs under launchd (farm.bsf.ac2-homecoming, KeepAlive) on 127.0.0.1:8791 and on this Mac's Tailscale address
(the owner chose Tailscale-only, 2026-10-13: nothing new on the public internet; the phone must have Tailscale on).

The phone decides (The owner's rule, on the phone): it was more than 15 km from home, and now it is inside 12 km
and getting closer. It sends only {"event":"coming_home","eta_min":N,"km":D} with a secret token
(config/homecoming-token.txt, gitignored, also baked into the app at build time). No location is sent.

On a valid event:
  * publishes bsf/presence/coming_home {ts, eta_min, km, src} (retained) on the Cerbo broker for AC v2
  * sends the owner a Telegram line
  * appends to data/homecoming.jsonl
"test" events (from the app's Send test button) are logged and answered but don't move the aircon.

  ac2_homecoming.py              serve
  ac2_homecoming.py --self-test  POST a test event to the running server and print the reply
  ac2_homecoming.py --dry --port 8792   a test receiver: logs to data/homecoming-dry.jsonl, never touches the
                                        broker or Telegram (emulator drive tests use this)
"""
import hmac, json, os, sys, time, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
TOKEN_FILE = os.environ.get("HOMECOMING_TOKEN_FILE") or os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "config", "homecoming-token.txt")
BROKER = os.environ.get("CERBO_HOST", "venus.local")
PORT = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else 8791
DRY = "--dry" in sys.argv
_last = {"ts": 0}


def token():
    return open(TOKEN_FILE).read().strip()


def publish(msg):
    import paho.mqtt.client as mqtt
    try:
        c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="bsf-ac2-homecoming")
    except AttributeError:
        c = mqtt.Client(client_id="bsf-ac2-homecoming")
    c.connect(BROKER, 1883, 15)
    c.loop_start()
    c.publish("bsf/presence/coming_home", json.dumps(msg, separators=(",", ":")), qos=1, retain=True).wait_for_publish(10)
    c.loop_stop(); c.disconnect()


def telegram(text):
    """Optional notification. Set NOTIFY_CMD to a command that takes the message as its last argument
    (e.g. a Telegram or ntfy script); without it the message is only printed."""
    cmd = os.environ.get("NOTIFY_CMD")
    print("notify:", text, flush=True)
    if not cmd:
        return False
    try:
        import shlex, subprocess
        return subprocess.run(shlex.split(cmd) + [text], timeout=30).returncode == 0
    except Exception as e:
        print("notify failed:", e, flush=True)
        return False


class H(BaseHTTPRequestHandler):
    def log_message(self, fmt, *a):
        pass

    def reply(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path.rstrip("/") != "/homecoming":
            return self.reply(404, {"ok": False})
        if not hmac.compare_digest(self.headers.get("X-Token", ""), token()):
            print(time.strftime("%H:%M:%S"), "rejected: bad token", flush=True)
            return self.reply(403, {"ok": False, "error": "bad token"})
        try:
            n = min(int(self.headers.get("Content-Length", "0")), 2048)
            ev = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return self.reply(400, {"ok": False, "error": "bad json"})
        kind = ev.get("event")
        eta = ev.get("eta_min") if isinstance(ev.get("eta_min"), (int, float)) else None
        km = ev.get("km") if isinstance(ev.get("km"), (int, float)) else None
        rec = {"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "event": kind, "eta_min": eta, "km": km, "who": str(ev.get("who", ""))[:20]}
        os.makedirs(DATA, exist_ok=True)
        with open(os.path.join(DATA, "homecoming-dry.jsonl" if DRY else "homecoming.jsonl"), "a") as f:
            f.write(json.dumps(rec) + "\n")
        print(rec, flush=True)
        if kind == "test":
            return self.reply(200, {"ok": True, "test": True, "msg": "Farm got your test. The aircon was not changed."})
        if kind != "coming_home":
            return self.reply(400, {"ok": False, "error": "unknown event"})
        if time.time() - _last["ts"] < 600:
            return self.reply(200, {"ok": True, "duplicate": True})
        _last["ts"] = time.time()
        if DRY:
            return self.reply(200, {"ok": True, "dry": True})
        publish({"ts": rec["ts"], "eta_min": eta, "km": km, "src": "farm-homecoming-app", "who": rec["who"]})
        telegram("🚗 %sHeading home%s — getting the house comfortable." % ((rec["who"] + ": ") if rec["who"] else "",
                 " (about %d min, %.0f km out)" % (eta, km) if eta is not None and km is not None else ""))
        return self.reply(200, {"ok": True})

    def do_GET(self):
        return self.reply(200 if self.path.rstrip("/") == "/homecoming" else 404, {"ok": True, "service": "farm-homecoming"})


def main():
    if "--self-test" in sys.argv:
        req = urllib.request.Request("http://127.0.0.1:%d/homecoming" % PORT, data=json.dumps({"event": "test", "who": "self-test"}).encode(),
                                     headers={"X-Token": token(), "Content-Type": "application/json"})
        print(urllib.request.urlopen(req, timeout=10).read().decode())
        return
    import threading
    if not DRY:
        # this Mac's tailnet IPv4 (private to the owner's tailnet), found by ac2_remote off the interfaces (the Mac app's
        # CLI answers nothing from a launchd job). It keeps looking: at boot Tailscale may not have an address yet,
        # and binding 127.0.0.1 only left the phone refused after the 28 Oct reboot.
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from ac2_remote import keep_tailnet_bound
        threading.Thread(target=keep_tailnet_bound, args=(H, PORT, {"127.0.0.1"}), daemon=True).start()
    print("listening on 127.0.0.1", PORT, flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()


if __name__ == "__main__":
    main()
