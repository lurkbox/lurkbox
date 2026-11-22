package io.github.lurkbox.Lurkbox;

import android.util.Log;
import android.webkit.WebResourceResponse;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;

/**
 * Twitch HLS through the app (the desktop's lbhls:// scheme): https://localhost/_lbhls/<host>/<path>?<query> is fetched
 * from https://<host>/<path>?<query> natively and streamed back on the page's own origin, so VOD playlists and
 * segments on Twitch's CloudFront CDN (CORS only for twitch.tv) load in hls.js. Not an open proxy: only Twitch's
 * playlist and segment hosts (packages/core/src/shared/hls-rewrite.js), and a cloudfront.net host only after the
 * platform layer saw it in a usher master playlist (proxyAllow). No cookies are sent, and redirects are followed here
 * one hop at a time, each checked like the first URL.
 */
final class HlsProxy {
    static final String PREFIX = "/_lbhls/";
    private static final String TAG = "Lurkbox";
    private static final Pattern STATIC_HOST = Pattern.compile("^(usher\\.ttvnw\\.net|([a-z0-9-]+\\.)+ttvnw\\.net)$");
    private static final Pattern CLOUDFRONT = Pattern.compile("^[a-z0-9]+\\.cloudfront\\.net$");
    private static final Set<String> seen = ConcurrentHashMap.newKeySet();
    private static final String[] FORWARD_REQ = { "Range", "Accept" };
    private static final String[] FORWARD_RES = { "Content-Range", "Accept-Ranges", "Cache-Control", "Last-Modified", "ETag" };
    private static final int MAX_REDIRECTS = 5;
    private static int denied = 0;

    private HlsProxy() {}

    static boolean handles(String encodedPath) {
        return encodedPath != null && encodedPath.startsWith(PREFIX);
    }

    static void allow(String host) {
        String h = host == null ? "" : host.toLowerCase(Locale.ROOT);
        if (CLOUDFRONT.matcher(h).matches()) seen.add(h);
    }

    static boolean allows(String host) {
        String h = host == null ? "" : host.toLowerCase(Locale.ROOT);
        return STATIC_HOST.matcher(h).matches() || (CLOUDFRONT.matcher(h).matches() && seen.contains(h));
    }

    /** https only, an allowed host, no credentials, the default port. */
    private static boolean allowedTarget(URL u) {
        return "https".equalsIgnoreCase(u.getProtocol()) && u.getUserInfo() == null && (u.getPort() == -1 || u.getPort() == 443) && allows(u.getHost());
    }

    private static Map<String, String> cors() {
        Map<String, String> h = new HashMap<>();
        h.put("Access-Control-Allow-Origin", "*");
        h.put("Access-Control-Expose-Headers", "Content-Length, Content-Range");
        return h;
    }

    private static WebResourceResponse plain(int status, String reason) {
        return new WebResourceResponse("text/plain", "utf-8", status, reason, cors(), new ByteArrayInputStream(new byte[0]));
    }

    static WebResourceResponse serve(String method, String encodedPath, String encodedQuery, Map<String, String> requestHeaders) {
        String rest = encodedPath.substring(PREFIX.length());
        int slash = rest.indexOf('/');
        String host = slash < 0 ? rest : rest.substring(0, slash);
        String path = slash < 0 ? "/" : rest.substring(slash);
        if (!allows(host)) {
            if (denied++ < 20) Log.w(TAG, "[hls-proxy] refused host " + host);
            return plain(403, "Forbidden");
        }
        if (!"GET".equals(method) && !"HEAD".equals(method)) return plain(405, "Method Not Allowed");
        URL target;
        HttpURLConnection c = null;
        try {
            target = new URL("https://" + host + path + (encodedQuery != null ? "?" + encodedQuery : ""));
            int status;
            for (int hop = 0; ; hop++) {
                c = (HttpURLConnection) target.openConnection();
                c.setRequestMethod(method);
                c.setInstanceFollowRedirects(false);
                c.setUseCaches(false);
                c.setConnectTimeout(15000);
                c.setReadTimeout(30000);
                for (String k : FORWARD_REQ) {
                    for (Map.Entry<String, String> e : requestHeaders.entrySet()) {
                        if (e.getKey().equalsIgnoreCase(k)) c.setRequestProperty(k, e.getValue());
                    }
                }
                status = c.getResponseCode();
                if (status < 300 || status >= 400 || status == 304) break;
                String location = c.getHeaderField("Location");
                c.disconnect();
                c = null;
                URL next = location == null ? null : new URL(target, location);
                if (next == null || hop >= MAX_REDIRECTS || !allowedTarget(next)) {
                    Log.w(TAG, "[hls-proxy] redirect from " + target.getHost() + " not followed");
                    return plain(502, "Bad Gateway");
                }
                target = next;
            }
            InputStream body = status >= 400 ? c.getErrorStream() : c.getInputStream();
            if (body == null) body = new ByteArrayInputStream(new byte[0]);
            Map<String, String> headers = cors();
            for (String k : FORWARD_RES) {
                String v = c.getHeaderField(k);
                if (v != null) headers.put(k, v);
            }
            String type = c.getContentType();
            String mime = target.getPath().endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : (type != null ? type.split(";")[0].trim() : "application/octet-stream");
            if (status >= 400) Log.w(TAG, "[hls-proxy] " + status + " from " + target.getHost());
            String reason = c.getResponseMessage();
            if (reason == null || reason.isEmpty()) reason = status < 400 ? "OK" : "Error";
            return new WebResourceResponse(mime, null, status, reason, headers, body);
        } catch (Exception e) {
            Log.w(TAG, "[hls-proxy] fetch failed for " + host + ": " + e.getMessage());
            if (c != null) c.disconnect();
            return plain(502, "Bad Gateway");
        }
    }
}
