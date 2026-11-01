package farm.bsf.homecoming;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.InputType;
import android.view.Gravity;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;

/**
 * One screen: where home is, whether it's watching, what it last did, and the three buttons.
 * Field-use: big targets, plain words, state you can read at a glance.
 */
public class MainActivity extends Activity {
    private static final int REQ_FG = 1, REQ_BG = 2, REQ_NOTE = 3;
    private TextView home, watching, status, sent;
    private Button startStop;
    private final Handler h = new Handler(Looper.getMainLooper());
    private final Runnable tick = new Runnable() { public void run() { refresh(); h.postDelayed(this, 2000); } };

    private boolean night() {
        return (getResources().getConfiguration().uiMode & android.content.res.Configuration.UI_MODE_NIGHT_MASK)
                == android.content.res.Configuration.UI_MODE_NIGHT_YES;
    }
    private int ink() { return night() ? 0xFFECEFF4 : 0xFF16202F; }
    private int mut() { return night() ? 0xFF9AA3B2 : 0xFF5D6B80; }

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        if (getActionBar() != null) getActionBar().hide();   // the screen has its own big title
        int pad = dp(20);
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setPadding(pad, pad, pad, pad);
        col.setBackgroundColor(night() ? 0xFF0D1117 : 0xFFF3F5F9);

        col.addView(text("Farm Homecoming", 26, ink(), true));
        col.addView(text("When you've been more than 15 km away and you're back inside 12 km and getting closer, "
                + "this tells the farm you're coming home so the aircon can get the house comfortable. "
                + "Only \"coming home\" and an ETA leave the phone, never your location.", 15, mut(), false));

        home = text("", 17, ink(), true); watching = text("", 17, ink(), true);
        status = text("", 15, mut(), false); sent = text("", 15, mut(), false);
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(16), dp(14), dp(16), dp(14));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(night() ? 0xFF161B22 : Color.WHITE); bg.setCornerRadius(dp(14)); bg.setStroke(dp(1), night() ? 0xFF30363D : 0xFFDDE3EC);
        card.setBackground(bg);
        card.addView(home); card.addView(watching); card.addView(status); card.addView(sent);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2);
        lp.topMargin = dp(16);
        col.addView(card, lp);

        Button setHome = button("Set home here", 0xFF0E7C99);
        setHome.setOnClickListener(v -> setHomeHere());
        startStop = button("Start watching", 0xFF1A9C5B);
        startStop.setOnClickListener(v -> {
            if (HomeService.enabled(this)) { HomeService.stop(this); refresh(); } else startWatching();
        });
        Button test = button("Send a test to the farm", 0xFF5D6B80);
        test.setOnClickListener(v -> {
            sent.setText("Sending a test…");
            Sender.send(this, "test", null, null, (ok, msg) -> runOnUiThread(() -> sent.setText(ok ? "The farm got the test." : "Test failed: " + msg)));
        });
        for (Button bt : new Button[]{setHome, startStop, test}) col.addView(bt, buttonLp());

        col.addView(text("Who's driving (shown in the farm's message)", 14, mut(), false), topLp(20));
        EditText who = new EditText(this);
        who.setText(HomeService.prefs(this).getString("who", ""));
        who.setTextColor(ink()); who.setTextSize(17); who.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_WORDS);
        who.setOnFocusChangeListener((v, f) -> { if (!f) HomeService.prefs(this).edit().putString("who", who.getText().toString().trim()).apply(); });
        col.addView(who);
        col.addView(text("Farm address", 14, mut(), false), topLp(12));
        EditText url = new EditText(this);
        url.setText(Sender.url(this)); url.setTextColor(ink()); url.setTextSize(14);
        url.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        url.setOnFocusChangeListener((v, f) -> { if (!f) HomeService.prefs(this).edit().putString("url", url.getText().toString().trim()).apply(); });
        col.addView(url);

        ScrollView sv = new ScrollView(this);
        sv.setBackgroundColor(night() ? 0xFF0D1117 : 0xFFF3F5F9);
        sv.addView(col);
        setContentView(sv);
        debugIntent(getIntent());
    }

    @Override protected void onNewIntent(Intent i) { super.onNewIntent(i); debugIntent(i); }
    @Override protected void onResume() { super.onResume(); h.post(tick); }
    @Override protected void onPause() { super.onPause(); h.removeCallbacks(tick); }

    /** Emulator tests only: adb shell am start ... --ed home_lat X --ed home_lon Y --ez start true */
    private void debugIntent(Intent i) {
        if (!BuildConfig.DEBUG || i == null) return;
        if (i.hasExtra("home_lat") && i.hasExtra("home_lon")) saveHome(i.getDoubleExtra("home_lat", 0), i.getDoubleExtra("home_lon", 0));
        if (i.getBooleanExtra("start", false) && hasFg()) HomeService.start(this);
    }

    private void refresh() {
        SharedPreferences p = HomeService.prefs(this);
        home.setText(HomeService.hasHome(this) ? "✓ Home is set" : "Home isn't set yet — tap Set home here at the house");
        boolean on = HomeService.enabled(this);
        watching.setText(on ? "✓ Watching for the trip home" : "Not watching");
        watching.setTextColor(on ? (night() ? 0xFF34D399 : 0xFF1A9C5B) : mut());
        status.setText(p.getString("last_status", "No location yet"));
        String s = p.getString("last_send", null);
        if (s != null && !sent.getText().toString().startsWith("Sending")) sent.setText(s);
        startStop.setText(on ? "Stop watching" : "Start watching");
    }

    private boolean hasFg() { return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED; }

    private void setHomeHere() {
        if (!hasFg()) { requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, REQ_FG); return; }
        home.setText("Finding where you are…");
        try {
            LocationServices.getFusedLocationProviderClient(this).getCurrentLocation(Priority.PRIORITY_HIGH_ACCURACY, null)
                    .addOnSuccessListener(l -> { if (l != null) saveHome(l.getLatitude(), l.getLongitude()); else home.setText("No fix yet — try again outside"); });
        } catch (SecurityException e) { home.setText("Location permission is off"); }
    }

    private void saveHome(double lat, double lon) {
        HomeService.prefs(this).edit().putLong("home_lat", Double.doubleToRawLongBits(lat)).putLong("home_lon", Double.doubleToRawLongBits(lon))
                .remove("last_km").putBoolean("armed", false).apply();
        refresh();
    }

    private void startWatching() {
        if (!hasFg()) { requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, REQ_FG); return; }
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTE); return;
        }
        if (Build.VERSION.SDK_INT >= 29 && checkSelfPermission(Manifest.permission.ACCESS_BACKGROUND_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            status.setText("Next screen: Location → choose \"Allow all the time\", then come back and tap Start watching.");
            if (Build.VERSION.SDK_INT >= 30) {
                startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", getPackageName(), null)));
            } else requestPermissions(new String[]{Manifest.permission.ACCESS_BACKGROUND_LOCATION}, REQ_BG);
            return;
        }
        HomeService.start(this);
        refresh();
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] perms, int[] res) {
        super.onRequestPermissionsResult(req, perms, res);
        boolean granted = res.length > 0 && res[0] == PackageManager.PERMISSION_GRANTED;
        if (req == REQ_FG && granted) refresh();
        if ((req == REQ_NOTE || req == REQ_BG) && granted) startWatching();
    }

    private TextView text(String s, int sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s); t.setTextSize(sp); t.setTextColor(color); t.setLineSpacing(0, 1.15f);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setPadding(0, dp(4), 0, dp(4));
        return t;
    }

    private Button button(String s, int color) {
        Button b = new Button(this);
        b.setText(s); b.setTextSize(17); b.setAllCaps(false); b.setTextColor(Color.WHITE); b.setTypeface(Typeface.DEFAULT_BOLD);
        GradientDrawable g = new GradientDrawable(); g.setColor(color); g.setCornerRadius(dp(14));
        b.setBackground(g); b.setMinHeight(dp(56)); b.setGravity(Gravity.CENTER);
        return b;
    }

    private LinearLayout.LayoutParams buttonLp() { LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, dp(56)); lp.topMargin = dp(12); return lp; }
    private LinearLayout.LayoutParams topLp(int top) { LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2); lp.topMargin = dp(top); return lp; }
    private int dp(int v) { return Math.round(v * getResources().getDisplayMetrics().density); }
}
