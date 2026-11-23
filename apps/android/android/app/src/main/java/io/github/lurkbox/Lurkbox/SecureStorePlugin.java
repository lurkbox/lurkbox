package io.github.lurkbox.Lurkbox;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Encrypted key/value storage for credentials (the platform layer's tokens), with the same get/set/remove shape as
 * Capacitor Preferences. Values are sealed with the Android Keystore key (SecureCrypto) and kept in the app's private
 * SharedPreferences file "lurkbox_secure". When a value can't be opened (the key was invalidated or lost), every
 * stored credential is dropped (this store, the web-session jars and cookies) and get resolves { value: null, reset: true },
 * so the app is signed out and asks for a sign-in. Values are never logged.
 */
@CapacitorPlugin(name = "SecureStore")
public class SecureStorePlugin extends Plugin {
    private static final String TAG = "Lurkbox";
    private static final String FILE = "lurkbox_secure";
    private static final String KEY = "[A-Za-z0-9_.-]{1,64}";

    @Override
    public void load() {
        // Jars written before encryption: encrypt them in place (the plaintext file is replaced).
        try {
            int n = WebCookies.migrateAll(getContext().getFilesDir());
            if (n > 0) Log.i(TAG, "[secure] encrypted " + n + " web-session jar(s)");
        } catch (Exception e) {
            Log.w(TAG, "[secure] jar migration failed: " + e.getClass().getSimpleName());
        }
    }

    private SharedPreferences prefs() { return getContext().getSharedPreferences(FILE, Context.MODE_PRIVATE); }

    private static String key(PluginCall call) {
        String k = call.getString("key", "");
        if (k == null || !k.matches(KEY)) throw new IllegalArgumentException("bad key");
        return k;
    }

    /** The key stopped working: forget everything it protected. */
    private void wipe() {
        prefs().edit().clear().commit();
        try { WebCookies.removeAll(getContext().getFilesDir()); } catch (Exception ignored) { /* best effort */ }
        try { WebCookies.clear(); } catch (Exception ignored) { /* best effort */ }
        SecureCrypto.resetKey();
    }

    @PluginMethod
    public void get(PluginCall call) {
        JSObject r = new JSObject();
        try {
            String stored = prefs().getString(key(call), null);
            if (stored == null) { r.put("value", null); call.resolve(r); return; }
            try {
                r.put("value", SecureCrypto.open(stored));
            } catch (SecureCrypto.Unreadable e) {
                Log.w(TAG, "[secure] stored credentials could not be decrypted (" + causeName(e) + "); cleared, sign in again");
                wipe();
                r.put("value", null);
                r.put("reset", true);
            }
            call.resolve(r);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void set(PluginCall call) {
        try {
            String k = key(call);
            String value = call.getString("value", "");
            String sealed;
            try {
                sealed = SecureCrypto.seal(value);
            } catch (SecureCrypto.Unreadable e) {
                // A broken key: start over with a new one (what it protected can't be opened any more either).
                Log.w(TAG, "[secure] could not encrypt (" + causeName(e) + "); making a new key");
                wipe();
                sealed = SecureCrypto.seal(value);
            }
            if (!prefs().edit().putString(k, sealed).commit()) throw new Exception("could not save");
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage() == null ? "could not save" : e.getMessage());
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        try {
            prefs().edit().remove(key(call)).commit();
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    private static String causeName(Exception e) {
        Throwable c = e.getCause();
        return c == null ? e.getMessage() : c.getClass().getSimpleName();
    }
}
