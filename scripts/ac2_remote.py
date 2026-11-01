#!/usr/bin/env python3
"""
Remote control for the aircon over Tailscale (owner 18 Oct): press a preset on the phone when away from home.

Security, in layers:
  * Listens ONLY on 127.0.0.1 and this Mac's Tailscale address (never the LAN, never the public tunnel), port 8793.
  * Who is asking is proven by Tailscale itself: a 100.x source address is cryptographically tied to one device, so
    the caller's address must be one of the devices in config/remote.json ("allowed": name -> Tailscale address;
    `tailscale whois` is a fallback, but the Mac app's CLI answers nothing from a launchd job). No shared secret.
  * It accepts only a fixed list of actions: the four presets (warm / cool / fresh / off, 15-240 min, default 60)
    and AUTO. Nothing else reaches the aircon, the Cerbo or the inverter.
  * Writes need a JSON body and the X-BSF-Control header, so a web page on another site can't press a button from
    the phone's browser (that needs a CORS preflight, and only the farm dashboard's origins get a yes).
  * At most 10 commands a minute. Every command goes to Telegram and to data/remote.jsonl.

  GET  /ac        status for the buttons: room, mode, preset and when it ends, what the unit is doing, battery
  POST /ac        {"action": "warm"|"cool"|"fresh"|"off"|"auto", "minutes": 60}

  ac2_remote.py                      serve (launchd farm.bsf.ac2-remote on the Mac mini)
  ac2_remote.py --port 8794 --dry    test server: nothing is published or sent, no Tailscale check for 127.0.0.1
"""
import json, os, re, subprocess, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
CFG = os.environ.get("AC2_REMOTE_CONFIG") or os.path.join(ROOT, "config", "remote.json")
if not os.path.exists(CFG):
    CFG = os.path.join(ROOT, "config", "remote.example.json")
BROKER = os.environ.get("CERBO_HOST", "venus.local")
PORT = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else 8793
DRY = "--dry" in sys.argv
TS_CLI = [p for p in ("/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/usr/local/bin/tailscale",
                      "/opt/homebrew/bin/tailscale") if os.path.exists(p)]
ACTIONS = {"warm": "Warm up", "cool": "Cool down", "fresh": "Fresh air", "off": "Off", "auto": "Auto"}
DASH_PORTS = (8780,)
_status = {}
_recent = []
_lock = threading.Lock()


def cfg():
    try:
        return json.load(open(CFG))
    except (OSError, ValueError):
        return {"allowed": []}


def tailnet_ips():
    """This Mac's Tailscale IPv4 addresses (100.64.0.0/10), from the CLI or else straight off the interfaces."""
    out = ""
    if TS_CLI:
        try:
            out = subprocess.run([TS_CLI[0], "ip", "-4"], capture_output=True, text=True, timeout=10).stdout
        except Exception:
            out = ""
    ips = [a for a in out.split() if a.startswith("100.")]
    if not ips:
        try:
            ifc = subprocess.run(["/sbin/ifconfig"], capture_output=True, text=True, timeout=10).stdout
            ips = [a for a in re.findall(r"inet (100\.(\d+)\.\d+\.\d+)", ifc) if 64 <= int(a[1]) <= 127]
            ips = [a[0] for a in ips]
        except Exception:
            ips = []
    return sorted(set(ips))


def node_name(ip):
    """Short Tailscale device name for a caller address ("my-phone"), or None if it isn't a known device."""
    if ip in ("127.0.0.1", "::1"):
        return "localhost"
    for name, addr in (cfg().get("allowed") or {}).items():
        if addr == ip:
            return name
    if not TS_CLI:
        return None
    try:
        out = subprocess.run([TS_CLI[0], "whois", "--json", ip], capture_output=True, text=True, timeout=8).stdout
        n = json.loads(out).get("Node") or {}
        return (n.get("ComputedName") or n.get("Name") or "").split(".")[0] or None
    except Exception:
        return None


def allowed(name):
    return name is not None and (name == "localhost" or name in (cfg().get("allowed") or {}))


def origin_ok(origin, own_hosts):
    """Only the farm dashboard (port 8780 on this Mac, by any of its names or addresses) may call from a browser."""
    m = re.match(r"^http://([^/:]+):(\d+)$", origin or "")
    return bool(m) and int(m.group(2)) in DASH_PORTS and m.group(1) in own_hosts


def command_for(action, minutes):
    """-> the bsf/ac2/cmd payload for an allowed action, or None."""
    if action == "auto":
        return {"cmd": "set_mode", "mode": "AUTO"}
    if action in ("warm", "cool", "fresh", "off"):
        mins = minutes if isinstance(minutes, (int, float)) and not isinstance(minutes, bool) else 60
        return {"cmd": "preset", "name": action, "minutes": int(min(240, max(15, mins)))}
    return None


def rate_ok(now):
    with _lock:
        while _recent and now - _recent[0] > 60:
            _recent.pop(0)
        if len(_recent) >= 10:
            return False
        _recent.append(now)
        return True


def mqtt_client():
    import paho.mqtt.client as mqtt
    try:
        return mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="bsf-ac2-remote")
    except AttributeError:
        return mqtt.Client(client_id="bsf-ac2-remote")


_mq = None


def publish(payload):
    _mq.publish("bsf/ac2/cmd", json.dumps(payload, separators=(",", ":")), qos=1).wait_for_publish(10)


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


def status_view():
    s = _status.get("v") or {}
    rep = s.get("ac_reported") or {}
    return {"ok": True, "ts": s.get("ts"), "room_c": s.get("room_c"), "mode": s.get("mode"), "tier": s.get("tier"),
            "preset": s.get("preset"), "preset_until": s.get("preset_until"), "soc": s.get("soc"),
            "unit": {"power": rep.get("power"), "mode": rep.get("mode"), "temp": rep.get("temp")},
            "fresh": bool(s) and time.time() - _status.get("at", 0) < 180}


class H(BaseHTTPRequestHandler):
    own_hosts = set()

    def log_message(self, fmt, *a):
        # One line per request from another device, so "did the phone get through?" has an answer (29 Oct: the
        # widget's status reads left no trace). Localhost (the dashboard proxy, self-checks) stays quiet.
        ip = self.client_address[0]
        if ip not in ("127.0.0.1", "::1"):
            print(time.strftime("%H:%M:%S"), ip, fmt % a, flush=True)

    def cors(self):
        o = self.headers.get("Origin")
        if o and origin_ok(o, self.own_hosts):
            self.send_header("Access-Control-Allow-Origin", o)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-BSF-Control")
            self.send_header("Access-Control-Allow-Methods", "GET, POST")
            self.send_header("Access-Control-Allow-Private-Network", "true")

    def reply(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.cors()
        self.end_headers()
        self.wfile.write(body)

    def who(self):
        ip = self.client_address[0]
        name = "localhost" if DRY and ip in ("127.0.0.1", "::1") else node_name(ip)
        return ip, name

    def do_OPTIONS(self):
        self.send_response(204 if origin_ok(self.headers.get("Origin"), self.own_hosts) else 403)
        self.cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if self.path.split("?")[0].rstrip("/") != "/ac":
            return self.reply(404, {"ok": False})
        ip, name = self.who()
        if not allowed(name):
            return self.reply(403, {"ok": False, "error": "this device is not allowed"})
        return self.reply(200, status_view())

    def do_POST(self):
        if self.path.split("?")[0].rstrip("/") != "/ac":
            return self.reply(404, {"ok": False})
        ip, name = self.who()
        if not allowed(name):
            print(time.strftime("%H:%M:%S"), "refused", ip, name, flush=True)
            return self.reply(403, {"ok": False, "error": "this device is not allowed"})
        if self.headers.get("X-BSF-Control") != "1" or "application/json" not in (self.headers.get("Content-Type") or ""):
            return self.reply(400, {"ok": False, "error": "missing X-BSF-Control header or JSON body"})
        try:
            n = min(int(self.headers.get("Content-Length", "0")), 1024)
            req = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return self.reply(400, {"ok": False, "error": "bad json"})
        cmd = command_for(req.get("action"), req.get("minutes"))
        if not cmd:
            return self.reply(400, {"ok": False, "error": "unknown action"})
        if not rate_ok(time.time()):
            return self.reply(429, {"ok": False, "error": "too many presses, try again in a minute"})
        cmd["source"] = "remote:" + name
        rec = {"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "from": name, "ip": ip, "cmd": cmd, "dry": DRY}
        os.makedirs(DATA, exist_ok=True)
        with open(os.path.join(DATA, "remote-dry.jsonl" if DRY else "remote.jsonl"), "a") as f:
            f.write(json.dumps(rec) + "\n")
        print(rec, flush=True)
        if not DRY:
            publish(cmd)
            label = ACTIONS[req["action"]] + ("" if req["action"] == "auto" else " for %d min" % cmd["minutes"])
            telegram("📱 Aircon remote (%s): %s" % (name, label))
        return self.reply(200, {"ok": True, "sent": cmd, "dry": DRY})


def bind_new(addrs, bound, start):
    """Start a server (start(addr)) on each address not yet in `bound`. -> the addresses newly bound.
    An address the system won't bind yet (Tailscale still coming up) is skipped and tried again next round."""
    new = []
    for a in addrs:
        if a in bound:
            continue
        try:
            start(a)
        except OSError as e:
            print("can't listen on %s yet: %s" % (a, e), flush=True)
            continue
        bound.add(a)
        new.append(a)
    return new


def keep_tailnet_bound(handler, port, bound, every=30, on_bind=None):
    """After a reboot the Mini can start a service before Tailscale has an address. Binding only 127.0.0.1 then, and
    never looking again, left the phone widget and the homecoming receiver refused for a day (28-29 Oct). So keep
    looking, and listen on the tailnet address as soon as it appears (or changes). Runs forever: start it in a thread."""
    def start(a):
        srv = ThreadingHTTPServer((a, port), handler)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
    while True:
        for a in bind_new(tailnet_ips(), bound, start):
            if on_bind:
                on_bind(a)
            print("listening on", a, port, flush=True)
        time.sleep(every)


def main():
    global _mq
    addrs = ["127.0.0.1"] + ([] if DRY else tailnet_ips())
    if not DRY and len(addrs) == 1:
        print("no tailscale address found yet: listening on 127.0.0.1, will add it when Tailscale is up", flush=True)
    H.own_hosts = set(addrs) | {"home-mac", "home-mac.local", "localhost"} | set(cfg().get("dashboard_hosts", []))
    if not DRY:
        _mq = mqtt_client()
        _mq.on_message = lambda c, u, m: _status.update({"v": json.loads(m.payload), "at": time.time()})
        _mq.on_connect = lambda c, u, f, rc, *a: c.subscribe("bsf/ac2/status")
        _mq.reconnect_delay_set(5, 120)
        _mq.connect_async(BROKER, 1883, 60)
        _mq.loop_start()
    if not DRY:
        threading.Thread(target=keep_tailnet_bound, args=(H, PORT, {"127.0.0.1"}),
                         kwargs={"on_bind": H.own_hosts.add}, daemon=True).start()
    print("listening on 127.0.0.1", PORT, "allowed:", sorted(cfg().get("allowed") or {}), flush=True)
    ThreadingHTTPServer((addrs[0], PORT), H).serve_forever()


if __name__ == "__main__":
    main()
