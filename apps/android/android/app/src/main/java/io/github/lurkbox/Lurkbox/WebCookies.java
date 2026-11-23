package io.github.lurkbox.Lurkbox;

import android.webkit.CookieManager;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import org.json.JSONObject;

/**
 * The twitch.tv web session in Android's CookieManager (shared by the app's WebViews) and the per-account jars in the
 * app's private storage (files/webjars/<user id>.json, like the tokens: private to the app, not encrypted).
 * Cookie values stay on the native side: callers get "signed in" and the public login name only. Never log values.
 */
final class WebCookies {
    static final String SITE = "https://www.twitch.tv";
    static final String[] HOSTS = { "https://www.twitch.tv", "https://twitch.tv", "https://id.twitch.tv", "https://passport.twitch.tv", "https://m.twitch.tv", "https://gql.twitch.tv" };
    /** The web-session cookies a jar keeps (as the desktop's CHAT_FRAME_COOKIES); the rest are left to twitch.tv. */
    static final Set<String> SESSION = new HashSet<>(Arrays.asList("auth-token", "login", "name", "persistent", "twilight-user", "api_token", "server_session_id", "unique_id", "unique_id_durable", "KP_UIDz", "KP_UIDz-ssn"));

    private WebCookies() {}

    /** "a=b; c=d" (CookieManager.getCookie) → name → value; the first one of a name wins. */
    static Map<String, String> parse(String header) {
        Map<String, String> out = new LinkedHashMap<>();
        if (header == null) return out;
        for (String part : header.split(";")) {
            String p = part.trim();
            int eq = p.indexOf('=');
            if (eq <= 0) continue;
            String name = p.substring(0, eq).trim();
            if (!out.containsKey(name)) out.put(name, p.substring(eq + 1).trim());
        }
        return out;
    }

    static Map<String, String> current() { return parse(CookieManager.getInstance().getCookie(SITE)); }

    /** The auth-token for the native GQL request, or null. Never returned to the page. */
    static String authToken() {
        String v = current().get("auth-token");
        return v == null || v.isEmpty() ? null : v;
    }

    /** The public login name from a cookie map (login, else name), or "" when only the auth-token is there. */
    static String login(Map<String, String> c) {
        String v = c.containsKey("login") ? c.get("login") : c.get("name");
        if (v == null) return "";
        try { return URLDecoder.decode(v, "UTF-8"); } catch (Exception e) { return v; }
    }

    static boolean signedIn(Map<String, String> c) {
        String v = c.get("auth-token");
        return v != null && !v.isEmpty();
    }

    /** Removes every twitch.tv cookie (host-only and domain cookies on the hosts we know; path /). */
    static void clear() {
        CookieManager cm = CookieManager.getInstance();
        for (String host : HOSTS) {
            String domain = host.substring("https://".length());
            for (String name : parse(cm.getCookie(host)).keySet()) {
                String gone = name + "=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/";
                cm.setCookie(host, gone);
                cm.setCookie(host, gone + "; Domain=.twitch.tv");
                cm.setCookie(host, gone + "; Domain=" + domain);
            }
        }
        cm.flush();
    }

    static File jarFile(File filesDir, String id) {
        if (id == null || !id.matches("\\d{1,20}")) throw new IllegalArgumentException("bad user id");
        return new File(new File(filesDir, "webjars"), id + ".json");
    }

    /** Saves the session cookies of the current web session for this account; false when there is none. */
    static boolean save(File filesDir, String id) throws Exception {
        Map<String, String> c = current();
        if (!signedIn(c)) return false;
        JSONObject jar = new JSONObject();
        for (Map.Entry<String, String> e : c.entrySet()) if (SESSION.contains(e.getKey())) jar.put(e.getKey(), e.getValue());
        File f = jarFile(filesDir, id);
        File dir = f.getParentFile();
        if (dir != null && !dir.isDirectory() && !dir.mkdirs()) throw new Exception("could not make the jar folder");
        File tmp = new File(f.getPath() + ".tmp");
        try (OutputStream out = new FileOutputStream(tmp)) { out.write(jar.toString().getBytes(StandardCharsets.UTF_8)); }
        if (!tmp.renameTo(f)) throw new Exception("could not write the jar");
        return true;
    }

    static JSONObject read(File filesDir, String id) {
        File f = jarFile(filesDir, id);
        if (!f.isFile()) return null;
        try (InputStream in = new FileInputStream(f)) {
            byte[] buf = new byte[(int) Math.min(f.length(), 256 * 1024)];
            int n = 0;
            while (n < buf.length) { int r = in.read(buf, n, buf.length - n); if (r < 0) break; n += r; }
            return new JSONObject(new String(buf, 0, n, StandardCharsets.UTF_8));
        } catch (Exception e) {
            return null;
        }
    }

    /** Clears the session and puts this account's jar in; the number of cookies set. */
    static int restore(File filesDir, String id) {
        clear();
        JSONObject jar = read(filesDir, id);
        if (jar == null) return 0;
        CookieManager cm = CookieManager.getInstance();
        int n = 0;
        for (java.util.Iterator<String> it = jar.keys(); it.hasNext(); ) {
            String name = it.next();
            if (!SESSION.contains(name)) continue;
            String value = jar.optString(name, "");
            if (value.isEmpty() || !value.matches("[^;\\s]*")) continue;
            // SameSite=None + Secure: Twitch's chat frame (a third-party frame of the app's page) gets them too.
            cm.setCookie(SITE, name + "=" + value + "; Domain=.twitch.tv; Path=/; Max-Age=31536000; Secure; SameSite=None");
            n++;
        }
        cm.flush();
        return n;
    }

    /** The login saved in this account's jar: null without a web session there, "" when it has no login cookie. */
    static String peekLogin(File filesDir, String id) {
        JSONObject jar = read(filesDir, id);
        if (jar == null || jar.optString("auth-token", "").isEmpty()) return null;
        Map<String, String> c = new LinkedHashMap<>();
        if (jar.has("login")) c.put("login", jar.optString("login"));
        if (jar.has("name")) c.put("name", jar.optString("name"));
        return login(c);
    }

    static void remove(File filesDir, String id) {
        File f = jarFile(filesDir, id);
        if (f.exists() && !f.delete()) f.deleteOnExit();
    }
}
