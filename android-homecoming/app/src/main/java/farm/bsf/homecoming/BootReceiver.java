package farm.bsf.homecoming;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/** Restarts the watcher after a reboot or an app update, if it was on (same pattern as my trip-logging app's BootReceiver). */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent intent) {
        String a = intent == null ? null : intent.getAction();
        Log.i(HomeService.TAG, "boot receiver " + a);
        if (!Intent.ACTION_BOOT_COMPLETED.equals(a) && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)) return;
        if (!HomeService.enabled(c)) return;
        try {
            HomeService.start(c);
        } catch (Exception e) {
            // MY_PACKAGE_REPLACED isn't an allowed background-FGS start on Android 12+; opening the app restarts it.
            HomeService.note(c, "Restart after update needs the app opened once: " + e.getMessage());
        }
    }
}
