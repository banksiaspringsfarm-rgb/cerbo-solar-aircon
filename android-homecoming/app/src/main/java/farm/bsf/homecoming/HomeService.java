package farm.bsf.homecoming;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.location.Location;
import android.os.Build;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;

import java.util.Locale;

/**
 * Watches for the trip home. Same shape as my trip-logging apps' location services,
 * which survive on the owner's test phone: a started (not bound) foreground service of type location,
 * START_STICKY, restarted by BootReceiver.
 *
 * Battery: how often it asks for a fix depends on how far from home it is.
 *   more than 25 km    balanced power, every 5 min       (town, Warwick, anywhere)
 *   1-25 km            high accuracy, every 20 s / 100 m  (the stretch where the rule can fire)
 *   inside 1 km        balanced power, every 10 min      (at home)
 * The rule (HomeRule) runs here on the phone. The only thing that leaves the phone is the "coming home"
 * message with an ETA and a whole-km distance; never a position.
 */
public class HomeService extends Service {
    static final String TAG = "Homecoming";
    static final String PREFS = "homecoming";
    static final String CHANNEL = "watch";
    static final int NOTE_ID = 7;

    private FusedLocationProviderClient client;
    private LocationCallback callback;
    private HomeRule rule;
    private int band = -1;   // 0 = home, 1 = near, 2 = far

    static SharedPreferences prefs(Context c) { return c.getSharedPreferences(PREFS, MODE_PRIVATE); }
    static boolean enabled(Context c) { return prefs(c).getBoolean("enabled", false); }
    static boolean hasHome(Context c) { return prefs(c).contains("home_lat"); }

    static void start(Context c) {
        prefs(c).edit().putBoolean("enabled", true).apply();
        Intent i = new Intent(c, HomeService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) c.startForegroundService(i); else c.startService(i);
    }

    static void stop(Context c) {
        prefs(c).edit().putBoolean("enabled", false).apply();
        c.stopService(new Intent(c, HomeService.class));
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        try {
            startForegroundCompat("Watching for the trip home");
        } catch (Exception e) {
            note(this, "Couldn't start: " + e.getMessage());
            stopSelf();
            return START_NOT_STICKY;
        }
        if (checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            note(this, "Location permission is off");
            stopSelf();
            return START_NOT_STICKY;
        }
        if (rule == null) rule = load(this);
        if (client == null) {
            client = LocationServices.getFusedLocationProviderClient(this);
            callback = new LocationCallback() {
                @Override public void onLocationResult(LocationResult r) {
                    Location l = r.getLastLocation();
                    if (l != null) onFix(l);
                }
            };
            request(1);   // start "near" until the first fix says where we are
        }
        return START_STICKY;
    }

    private void request(int newBand) {
        if (newBand == band) return;
        band = newBand;
        LocationRequest req;
        long fast = BuildConfig.DEBUG ? 5_000 : 20_000;
        if (newBand == 1) req = new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, fast)
                .setMinUpdateIntervalMillis(fast / 2).setMinUpdateDistanceMeters(BuildConfig.DEBUG ? 0f : 100f).build();
        else if (newBand == 2) req = new LocationRequest.Builder(Priority.PRIORITY_BALANCED_POWER_ACCURACY, BuildConfig.DEBUG ? 10_000 : 300_000)
                .setMinUpdateIntervalMillis(BuildConfig.DEBUG ? 5_000 : 120_000).build();
        else req = new LocationRequest.Builder(Priority.PRIORITY_BALANCED_POWER_ACCURACY, BuildConfig.DEBUG ? 10_000 : 600_000)
                .setMinUpdateIntervalMillis(BuildConfig.DEBUG ? 5_000 : 300_000).build();
        try {
            client.removeLocationUpdates(callback);
            client.requestLocationUpdates(req, callback, Looper.getMainLooper());
            Log.i(TAG, "location band " + newBand);
        } catch (SecurityException e) {
            note(this, "Location updates refused: " + e.getMessage());
        }
    }

    private void onFix(Location l) {
        SharedPreferences p = prefs(this);
        if (!hasHome(this)) { note(this, "Set home first"); return; }
        double km = HomeRule.km(l.getLatitude(), l.getLongitude(),
                Double.longBitsToDouble(p.getLong("home_lat", 0)), Double.longBitsToDouble(p.getLong("home_lon", 0)));
        boolean fire = rule.onFix(km, System.currentTimeMillis());
        save(this, rule);
        Log.i(TAG, String.format(Locale.US, "fix %.2f km armed=%b fire=%b", km, rule.armed, fire));
        request(km > 25 ? 2 : km < 1 ? 0 : 1);
        updateNotification(String.format(Locale.US, "%.0f km from home%s", km, rule.armed ? " · will tell the farm when you head back" : ""));
        p.edit().putString("last_status", String.format(Locale.US, "%.1f km from home, %s", km, rule.armed ? "armed" : "not armed"))
                .putLong("last_fix_ms", System.currentTimeMillis()).apply();
        if (fire) Sender.send(this, "coming_home", (int) Math.round(rule.lastEtaMin), (int) Math.round(km));
    }

    static HomeRule load(Context c) {
        SharedPreferences p = prefs(c);
        HomeRule r = HomeRule.standard();
        r.armed = p.getBoolean("armed", false);
        r.lastKm = p.contains("last_km") ? Double.longBitsToDouble(p.getLong("last_km", 0)) : Double.NaN;
        r.lastFixMs = p.getLong("last_fix_rule_ms", 0);
        r.lastTriggerMs = p.getLong("last_trigger_ms", HomeRule.NEVER);
        return r;
    }

    static void save(Context c, HomeRule r) {
        SharedPreferences.Editor e = prefs(c).edit()
                .putBoolean("armed", r.armed).putLong("last_fix_rule_ms", r.lastFixMs).putLong("last_trigger_ms", r.lastTriggerMs);
        if (!Double.isNaN(r.lastKm)) e.putLong("last_km", Double.doubleToRawLongBits(r.lastKm));
        e.apply();
    }

    static void note(Context c, String s) {
        Log.w(TAG, s);
        prefs(c).edit().putString("last_status", s).apply();
    }

    private Notification build(String text) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm != null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Watching for the trip home", NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        PendingIntent tap = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        return b.setContentTitle("Farm Homecoming").setContentText(text).setSmallIcon(R.drawable.ic_home)
                .setOngoing(true).setContentIntent(tap).build();
    }

    private void startForegroundCompat(String text) {
        Notification n = build(text);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) startForeground(NOTE_ID, n, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
        else startForeground(NOTE_ID, n);
    }

    private void updateNotification(String text) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(NOTE_ID, build(text));
    }

    @Override
    public void onDestroy() {
        if (client != null && callback != null) client.removeLocationUpdates(callback);
        super.onDestroy();
    }
}
