package farm.bsf.homecoming;

/**
 * The owner's rule (2026-10-13), pure so it can be unit-tested: there's one road between the farm and town,
 * so "was more than ARM km away, now inside TRIGGER km and getting closer" means coming home.
 *
 *   arm      when a fix is further than armKm from home
 *   trigger  when armed, the fix is within triggerKm, and it is at least approachKm closer than the last fix
 *   then     disarm, and don't trigger again for cooldownMs (a dash back to town for something forgotten)
 *
 * ETA is the distance over the recent approach speed, clamped to 30-120 km/h (default 80 km/h).
 */
public final class HomeRule {
    public final double armKm, triggerKm, approachKm;
    public final long cooldownMs;

    public boolean armed;
    public double lastKm = Double.NaN;
    public long lastFixMs;
    public long lastTriggerMs = NEVER;   // "never fired", so the first trip home can fire at any clock time
    public static final long NEVER = Long.MIN_VALUE / 4;
    public double lastEtaMin = Double.NaN;

    public HomeRule(double armKm, double triggerKm, double approachKm, long cooldownMs) {
        this.armKm = armKm; this.triggerKm = triggerKm; this.approachKm = approachKm; this.cooldownMs = cooldownMs;
    }

    public static HomeRule standard() { return new HomeRule(15.0, 12.0, 0.1, 3L * 3600 * 1000); }

    /** Feed one fix (km from home at nowMs). Returns true exactly when "coming home" should be sent. */
    public boolean onFix(double km, long nowMs) {
        boolean fire = false;
        if (km > armKm) armed = true;
        if (armed && km <= triggerKm && !Double.isNaN(lastKm) && km <= lastKm - approachKm
                && nowMs - lastTriggerMs >= cooldownMs) {
            double hours = (nowMs - lastFixMs) / 3600000.0;
            double kmh = hours > 0 ? (lastKm - km) / hours : 80;
            kmh = Math.max(30, Math.min(120, Double.isNaN(kmh) || Double.isInfinite(kmh) ? 80 : kmh));
            lastEtaMin = km / kmh * 60.0;
            fire = true;
            armed = false;
            lastTriggerMs = nowMs;
        }
        lastKm = km;
        lastFixMs = nowMs;
        return fire;
    }

    /** Great-circle distance in km. */
    public static double km(double lat1, double lon1, double lat2, double lon2) {
        double r = 6371.0, dLat = Math.toRadians(lat2 - lat1), dLon = Math.toRadians(lon2 - lon1);
        double a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
                + Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return 2 * r * Math.asin(Math.sqrt(a));
    }
}
