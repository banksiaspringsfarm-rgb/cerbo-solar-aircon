package farm.bsf.homecoming;

import static org.junit.Assert.*;
import org.junit.Test;

public class HomeRuleTest {
    private static final long MIN = 60_000L;

    /** Drive from fromKm toward home at 1 km a minute; return the minute it fired, or -1. */
    private static int drive(HomeRule r, double fromKm, double toKm, long startMs) {
        int i = 0;
        for (double k = fromKm; k >= toKm; k -= 1.0, i++) if (r.onFix(k, startMs + i * MIN)) return i;
        return -1;
    }

    @Test public void comingBackFromTownFiresOnceInsideTwelveKm() {
        HomeRule r = HomeRule.standard();
        int at = drive(r, 20, 0, 0);
        assertEquals("fires at 12 km (minute 8)", 8, at);
        assertEquals("ETA ~12 min at 60 km/h", 12.0, r.lastEtaMin, 0.5);
        assertFalse("disarmed after firing", r.armed);
    }

    @Test public void drivingAroundNearHomeNeverFires() {
        HomeRule r = HomeRule.standard();
        for (int i = 0; i < 100; i++) assertFalse(r.onFix(5 + (i % 10), i * MIN));   // never further than 15 km
    }

    @Test public void leavingHomeDoesNotFire() {
        HomeRule r = HomeRule.standard();
        for (int i = 0; i <= 25; i++) assertFalse("heading out at " + i + " km", r.onFix(i, i * MIN));
    }

    @Test public void secondTripWithinThreeHoursDoesNotFireAgain() {
        HomeRule r = HomeRule.standard();
        assertTrue(drive(r, 20, 0, 0) >= 0);
        for (int i = 0; i <= 20; i++) r.onFix(i, (30 + i) * MIN);                    // back out to town
        assertEquals("cooldown", -1, drive(r, 20, 0, 60 * MIN));
        for (int i = 0; i <= 20; i++) r.onFix(i, (200 + i) * MIN);
        assertTrue("after 3 h it works again", drive(r, 20, 0, 240 * MIN) >= 0);
    }

    @Test public void parkedInsideTwelveKmWithGpsJitterDoesNotFireAgain() {
        HomeRule p = HomeRule.standard();
        p.onFix(18, 0);                                          // armed in town
        assertTrue("first fix inside 12 km while closing in: fires", p.onFix(11.5, 10 * MIN));
        for (int i = 0; i < 30; i++)                             // then parked at 11.5 km with GPS jitter
            assertFalse("jitter " + i, p.onFix(11.5 + ((i % 2) * 0.15), (11 + i) * MIN));
    }

    @Test public void jitterWhileArmedButNotApproachingDoesNotFire() {
        HomeRule p = HomeRule.standard();
        p.onFix(18, 0);
        p.onFix(11.50, MIN);                                     // fires (approach from 18)
        HomeRule q = HomeRule.standard();
        q.onFix(16, 0); q.lastKm = 11.55;                        // armed, last fix just outside the approach step
        assertFalse("0.05 km is GPS noise, not driving home", q.onFix(11.50, MIN));
    }

    @Test public void distanceIsRight() {
        assertEquals("one degree of latitude", 111.19, HomeRule.km(-35, 150, -36, 150), 0.05);
        assertEquals("one degree of longitude at 35 S", 91.1, HomeRule.km(-35, 149, -35, 150), 0.3);
    }
}
