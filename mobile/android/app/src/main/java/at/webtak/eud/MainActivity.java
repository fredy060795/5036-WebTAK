package at.webtak.eud;

import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.CapConfig;

// WebTAK for Android: one app for every WebTAK server. The server comes from the invitation link
// (webtak://open?u=https://server/eud/#…) or the start page, and becomes the app's start address –
// only there Capacitor puts its plugins (background location) into the page.
public class MainActivity extends BridgeActivity {

    static final String PREFS = "webtak";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(WebTakPlugin.class);
        takeLink(getIntent());
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        // the full invitation link (with the login) only once, afterwards the server's EUD address
        String once = prefs.getString("once", null);
        String start = once != null ? once : prefs.getString("server", null);
        if (once != null) prefs.edit().remove("once").apply();
        if (start != null) {
            Uri u = Uri.parse(start);
            config = new CapConfig.Builder(this)
                .setServerUrl(start)
                .setAllowNavigation(new String[] { u.getHost() })
                .setAndroidScheme("https")
                .create();
        }
        super.onCreate(savedInstanceState);
    }

    // app already open and a new invitation link is tapped: take it over and start again on it
    @Override
    protected void onNewIntent(Intent intent) {
        if (takeLink(intent)) {
            setIntent(intent);
            recreate();
            return;
        }
        super.onNewIntent(intent);
    }

    // webtak://open?u=<https link> -> remembered; the intent loses its data so it is not handled twice
    private boolean takeLink(Intent intent) {
        Uri data = intent != null ? intent.getData() : null;
        if (data == null || !"webtak".equals(data.getScheme())) return false;
        intent.setData(null);
        String u = data.getQueryParameter("u");
        if (u == null) return false;
        return remember(this, u);
    }

    static boolean remember(android.content.Context ctx, String url) {
        Uri u = Uri.parse(url);
        if (!"https".equals(u.getScheme()) || u.getHost() == null) return false;
        String base = "https://" + u.getEncodedAuthority() + "/eud/";
        ctx.getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString("server", base).putString("once", url).apply();
        return true;
    }
}
