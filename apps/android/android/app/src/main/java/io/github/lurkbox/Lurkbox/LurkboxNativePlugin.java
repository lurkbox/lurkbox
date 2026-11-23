package io.github.lurkbox.Lurkbox;

import android.util.Log;
import android.view.WindowManager;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.ByteArrayOutputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.Map;
import org.json.JSONObject;

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

    private static volatile LurkboxNativePlugin instance;

    @Override
    public void load() { instance = this; }

    /** An event for the page's listeners (MainActivity's picture-in-picture: pipMode, pipAction). */
    static void emit(String event, JSObject data) {
        LurkboxNativePlugin p = instance;
        if (p != null) p.notifyListeners(event, data);
    }

    /** Whether this device has picture-in-picture for the app (a phone or tablet on Android 8+, never a TV). */
    @PluginMethod
    public void pipSupported(PluginCall call) {
        JSObject r = new JSObject();
        r.put("supported", MainActivity.pipSupported(getActivity()));
        call.resolve(r);
    }

    /** { wanted, playing }: leaving the app enters picture-in-picture while wanted; playing sets the play/pause button. */
    @PluginMethod
    public void pip(PluginCall call) {
        boolean wanted = Boolean.TRUE.equals(call.getBoolean("wanted", false));
        boolean playing = Boolean.TRUE.equals(call.getBoolean("playing", false));
        if (getActivity() instanceof MainActivity) ((MainActivity) getActivity()).setPip(wanted, playing);
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

    // ---- update notifications (apps/android/src/updates.js, UpdateInstaller) ----

    /**
     * { url, sumsUrl, name }: downloads the release APK (GitHub's hosts only), checks it against SHA256SUMS.txt and
     * resolves { sha256: "ok", signature: "match" | "mismatch" | "unknown" }; "updateProgress" { received, total } meanwhile.
     */
    @PluginMethod
    public void updateDownload(PluginCall call) {
        String url = call.getString("url", "");
        String sumsUrl = call.getString("sumsUrl", "");
        String name = call.getString("name", "");
        new Thread(() -> {
            try {
                File apk = UpdateInstaller.download(getContext(), url, sumsUrl, name, (received, total) -> {
                    JSObject p = new JSObject();
                    p.put("received", received);
                    p.put("total", total);
                    notifyListeners("updateProgress", p);
                });
                JSObject r = new JSObject();
                r.put("sha256", "ok");
                r.put("signature", UpdateInstaller.signature(getContext(), apk));
                call.resolve(r);
            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : "download failed");
            }
        }).start();
    }

    /** { name }: opens the system installer for the downloaded APK; { permission: false } when Android's "install unknown apps" setting opened instead. */
    @PluginMethod
    public void updateInstall(PluginCall call) {
        String name = call.getString("name", "");
        getActivity().runOnUiThread(() -> {
            try {
                JSObject r = new JSObject();
                r.put("permission", UpdateInstaller.install(getActivity(), name));
                call.resolve(r);
            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : "install failed");
            }
        });
    }

    // ---- the twitch.tv web session (apps/android/src/web-session.js). Cookie values never go back to the page. ----

    private TwitchWebDialog webDialog;

    /** Opens the in-app twitch.tv window at url (only twitch.tv's own pages); "webClosed" {session} when it closes. */
    @PluginMethod
    public void webOpen(PluginCall call) {
        String url = call.getString("url", "");
        if (!TwitchWebDialog.allowed(url)) { call.reject("not a twitch.tv page"); return; }
        int session = call.getInt("session", 0);
        double zoom = call.getDouble("zoom", 1.0);
        String script = call.getString("script", "");
        String textScript = call.getString("textScript", "");
        getActivity().runOnUiThread(() -> {
            if (webDialog == null) webDialog = new TwitchWebDialog(getActivity());
            webDialog.open(url, session, zoom, script, textScript, (s) -> {
                JSObject ev = new JSObject();
                ev.put("session", s);
                WebCookies.keepThirdParty(); // a sign-in there may have written the session cookies Lax
                notifyListeners("webClosed", ev);
            });
            call.resolve();
        });
    }

    @PluginMethod
    public void webLoad(PluginCall call) {
        String url = call.getString("url", "");
        if (!TwitchWebDialog.allowed(url)) { call.reject("not a twitch.tv page"); return; }
        getActivity().runOnUiThread(() -> { if (webDialog != null) webDialog.load(url); call.resolve(); });
    }

    @PluginMethod
    public void webClose(PluginCall call) {
        getActivity().runOnUiThread(() -> { if (webDialog != null) webDialog.close(); call.resolve(); });
    }

    // ---- hidden twitch.tv pages (TwitchHiddenPages): points chat, follow, Drops auto-claim ----

    private TwitchHiddenPages hiddenPages;

    private TwitchHiddenPages pages() {
        if (hiddenPages == null) hiddenPages = new TwitchHiddenPages(getActivity());
        return hiddenPages;
    }

    /** Opens the hidden page of a kind ("points", "follow", "drops") at its url; resolves once it loaded. */
    @PluginMethod
    public void pageOpen(PluginCall call) {
        String kind = call.getString("kind", "");
        String url = call.getString("url", "");
        if (!TwitchHiddenPages.allowed(kind, url)) { call.reject("not this page's twitch.tv url"); return; }
        int width = call.getInt("width", 1280);
        int height = call.getInt("height", 900);
        getActivity().runOnUiThread(() -> pages().open(kind, url, width, height, new TwitchHiddenPages.Done() {
            @Override public void ok() { call.resolve(); }
            @Override public void fail(String reason) { call.reject(reason); }
        }));
    }

    /** Runs a source in a hidden page: { json } is evaluateJavascript's JSON answer (null without the page). */
    @PluginMethod
    public void pageEval(PluginCall call) {
        String kind = call.getString("kind", "");
        String source = call.getString("source", "");
        getActivity().runOnUiThread(() -> pages().eval(kind, source, (v) -> {
            JSObject r = new JSObject();
            r.put("json", v);
            call.resolve(r);
        }));
    }

    @PluginMethod
    public void pageClose(PluginCall call) {
        String kind = call.getString("kind", "");
        getActivity().runOnUiThread(() -> { pages().close(kind); WebCookies.keepThirdParty(); call.resolve(); });
    }

    /** { signedIn, login }: whether twitch.tv's auth-token cookie is there, and the public login name. */
    @PluginMethod
    public void webStatus(PluginCall call) {
        Map<String, String> c = WebCookies.current();
        JSObject r = new JSObject();
        boolean in = WebCookies.signedIn(c);
        r.put("signedIn", in);
        r.put("login", in ? WebCookies.login(c) : null);
        call.resolve(r);
    }

    /** Signs twitch.tv out: removes its cookies. */
    @PluginMethod
    public void webClear(PluginCall call) {
        WebCookies.clear();
        call.resolve();
    }

    /**
     * Sign-out of the active account: twitch.tv's own site data in the WebView (local storage, IndexedDB and the other
     * storage of its origins), and the WebView's HTTP cache. On the UI thread, as WebView APIs need.
     */
    @PluginMethod
    public void webClearSiteData(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try {
                android.webkit.WebStorage storage = android.webkit.WebStorage.getInstance();
                for (String origin : WebCookies.HOSTS) storage.deleteOrigin(origin);
                if (getBridge() != null && getBridge().getWebView() != null) getBridge().getWebView().clearCache(true);
                call.resolve();
            } catch (Exception e) { call.reject(e.getMessage()); }
        });
    }

    @PluginMethod
    public void webJarSave(PluginCall call) {
        try {
            JSObject r = new JSObject();
            r.put("saved", WebCookies.save(getContext().getFilesDir(), call.getString("id", "")));
            android.webkit.CookieManager.getInstance().flush();
            call.resolve(r);
        } catch (Exception e) { call.reject(e.getMessage()); }
    }

    @PluginMethod
    public void webJarRestore(PluginCall call) {
        try {
            JSObject r = new JSObject();
            r.put("count", WebCookies.restore(getContext().getFilesDir(), call.getString("id", "")));
            call.resolve(r);
        } catch (Exception e) { call.reject(e.getMessage()); }
    }

    /** { has, login }: whether this account's jar holds a web session, and its login name. */
    @PluginMethod
    public void webJarPeek(PluginCall call) {
        try {
            String login = WebCookies.peekLogin(getContext().getFilesDir(), call.getString("id", ""));
            JSObject r = new JSObject();
            r.put("has", login != null);
            r.put("login", login);
            call.resolve(r);
        } catch (Exception e) { call.reject(e.getMessage()); }
    }

    @PluginMethod
    public void webJarRemove(PluginCall call) {
        try { WebCookies.remove(getContext().getFilesDir(), call.getString("id", "")); call.resolve(); } catch (Exception e) { call.reject(e.getMessage()); }
    }

    /**
     * The direct engine's PlaybackAccessToken request with the web session: POSTed to Twitch's web GQL with the
     * auth-token cookie as Authorization, added here (the page never sees it). Only that one operation, and only the
     * Client-ID and Content-Type headers from the page. Resolves { status, data } (the response text).
     */
    @PluginMethod
    public void webGql(PluginCall call) {
        String body = call.getString("body", "");
        JSObject headers = call.getObject("headers", new JSObject());
        try {
            if (!"PlaybackAccessToken".equals(new JSONObject(body).optString("operationName"))) { call.reject("only PlaybackAccessToken"); return; }
        } catch (Exception e) { call.reject("bad body"); return; }
        new Thread(() -> {
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new URL("https://gql.twitch.tv/gql").openConnection();
                c.setRequestMethod("POST");
                c.setConnectTimeout(15000);
                c.setReadTimeout(15000);
                c.setDoOutput(true);
                c.setRequestProperty("Client-ID", headers.optString("Client-ID", ""));
                c.setRequestProperty("Content-Type", headers.optString("Content-Type", "text/plain;charset=UTF-8"));
                String token = WebCookies.authToken();
                if (token != null && token.matches("[A-Za-z0-9]+")) c.setRequestProperty("Authorization", "OAuth " + token);
                try (OutputStream out = c.getOutputStream()) { out.write(body.getBytes(StandardCharsets.UTF_8)); }
                int status = c.getResponseCode();
                InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
                ByteArrayOutputStream buf = new ByteArrayOutputStream();
                if (in != null) {
                    try (InputStream src = in) {
                        byte[] b = new byte[8192];
                        int n;
                        while ((n = src.read(b)) > 0 && buf.size() < 1024 * 1024) buf.write(b, 0, n);
                    }
                }
                JSObject r = new JSObject();
                r.put("status", status);
                r.put("data", buf.toString("UTF-8"));
                call.resolve(r);
            } catch (Exception e) {
                call.reject(e.getMessage());
            } finally {
                if (c != null) c.disconnect();
            }
        }).start();
    }
}
