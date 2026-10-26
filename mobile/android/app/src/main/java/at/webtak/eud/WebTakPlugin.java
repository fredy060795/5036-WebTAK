package at.webtak.eud;

import android.content.Context;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// for the start page and the EUD: choose / change the WebTAK server (the app then starts again on it)
@CapacitorPlugin(name = "WebTak")
public class WebTakPlugin extends Plugin {

    @PluginMethod
    public void setServer(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            getContext().getSharedPreferences(MainActivity.PREFS, Context.MODE_PRIVATE).edit().remove("server").remove("once").apply();
        } else if (!MainActivity.remember(getContext(), url)) {
            call.reject("Only https addresses are possible.");
            return;
        }
        call.resolve();
        getActivity().runOnUiThread(() -> getActivity().recreate());
    }

    @PluginMethod
    public void getInfo(PluginCall call) {
        JSObject r = new JSObject();
        r.put("server", getContext().getSharedPreferences(MainActivity.PREFS, Context.MODE_PRIVATE).getString("server", null));
        r.put("version", BuildConfig.VERSION_NAME);
        call.resolve(r);
    }
}
