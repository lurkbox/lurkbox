package io.github.lurkbox.Lurkbox;

import android.util.Log;
import android.view.WindowManager;
import com.getcapacitor.JSArray;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/** The app's own native helpers for the Android platform layer (apps/android/src/platform-android.js). */
@CapacitorPlugin(name = "LurkboxNative")
public class LurkboxNativePlugin extends Plugin {
    private static final String TAG = "Lurkbox";
    private static final long MAX_LOG = 2 * 1024 * 1024;

    /** One log line: to logcat (tag "Lurkbox") and to files/lurkbox.log (2 MB, then rotated to lurkbox.log.1). */
    @PluginMethod
    public void log(PluginCall call) {
        String line = call.getString("line", "");
        Log.i(TAG, line);
        synchronized (this) {
            try {
                File file = new File(getContext().getFilesDir(), "lurkbox.log");
                if (file.length() > MAX_LOG) file.renameTo(new File(getContext().getFilesDir(), "lurkbox.log.1"));
                String stamp = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSZ", Locale.ROOT).format(new Date());
                try (FileOutputStream out = new FileOutputStream(file, true)) {
                    out.write((stamp + " " + line + "\n").getBytes(StandardCharsets.UTF_8));
                }
            } catch (Exception e) {
                Log.w(TAG, "log file: " + e.getMessage());
            }
        }
        call.resolve();
    }

    /** Keep the screen on (while a video plays) or let it sleep again. */
    @PluginMethod
    public void keepScreenOn(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        getActivity().runOnUiThread(() -> {
            if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
        call.resolve();
    }

    /** The cloudfront.net hosts a usher master playlist pointed at, for the HLS proxy. */
    @PluginMethod
    public void proxyAllow(PluginCall call) {
        JSArray hosts = call.getArray("hosts", new JSArray());
        for (int i = 0; i < hosts.length(); i++) HlsProxy.allow(hosts.optString(i, ""));
        call.resolve();
    }
}
