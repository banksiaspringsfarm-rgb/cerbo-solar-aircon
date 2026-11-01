package farm.bsf.homecoming;

import android.content.Context;
import android.util.Log;

import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Sends one event to the farm (scripts/ac2_homecoming.py): {"event", "eta_min", "km", "who"} with the shared
 * token. Never a position. Retries three times, 30 s apart, on a background thread (mobile data drops out on
 * the road home).
 */
final class Sender {
    interface Done { void result(boolean ok, String msg); }

    static void send(Context c, String event, Integer etaMin, Integer km) { send(c, event, etaMin, km, null); }

    static void send(Context c, String event, Integer etaMin, Integer km, Done done) {
        final Context app = c.getApplicationContext();
        new Thread(() -> {
            String msg = "";
            boolean ok = false;
            for (int attempt = 1; attempt <= 3 && !ok; attempt++) {
                try {
                    JSONObject body = new JSONObject().put("event", event).put("who", HomeService.prefs(app).getString("who", ""));
                    if (etaMin != null) body.put("eta_min", etaMin);
                    if (km != null) body.put("km", km);
                    HttpURLConnection h = (HttpURLConnection) new URL(url(app)).openConnection();
                    h.setRequestMethod("POST");
                    h.setConnectTimeout(10_000); h.setReadTimeout(10_000); h.setDoOutput(true);
                    h.setRequestProperty("Content-Type", "application/json");
                    h.setRequestProperty("X-Token", BuildConfig.HOMECOMING_TOKEN);
                    try (OutputStream o = h.getOutputStream()) { o.write(body.toString().getBytes(StandardCharsets.UTF_8)); }
                    int code = h.getResponseCode();
                    try (InputStream in = code < 400 ? h.getInputStream() : h.getErrorStream()) {
                        if (in == null) msg = "";
                        else {
                            java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
                            byte[] buf = new byte[1024]; int n;
                            while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
                            msg = bo.toString("UTF-8");
                        }
                    }
                    ok = code == 200;
                    if (!ok) msg = "farm said " + code + " " + msg;
                } catch (Exception e) {
                    msg = e.getClass().getSimpleName() + ": " + e.getMessage();
                }
                Log.i(HomeService.TAG, "send " + event + " attempt " + attempt + " ok=" + ok + " " + msg);
                if (!ok && attempt < 3) try { Thread.sleep(30_000); } catch (InterruptedException ignored) { }
            }
            String what = "coming_home".equals(event) ? "told the farm you're coming home" : "test reached the farm";
            String when = new java.text.SimpleDateFormat("h:mm a", java.util.Locale.US).format(new java.util.Date());
            HomeService.prefs(app).edit().putString("last_send", ok ? (Character.toUpperCase(what.charAt(0)) + what.substring(1) + " at " + when)
                    : "Couldn't reach the farm at " + when + " (" + what + "): " + msg).apply();
            if (done != null) done.result(ok, msg);
        }).start();
    }

    static String url(Context c) {
        return HomeService.prefs(c).getString("url", BuildConfig.HOMECOMING_URL);
    }
}
