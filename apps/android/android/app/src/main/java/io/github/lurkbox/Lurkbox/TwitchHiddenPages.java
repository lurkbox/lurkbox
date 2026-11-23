package io.github.lurkbox.Lurkbox;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.graphics.Color;
import android.net.Uri;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import java.io.ByteArrayInputStream;
import java.util.HashMap;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Hidden twitch.tv pages in the user's web session (the app's CookieManager), for the features Twitch's public API
 * doesn't offer: channel points (the channel's embedded chat page), follow/unfollow (the channel page) and Drops
 * auto-claim (the inventory page). Each is a real WebView at a real size, off-screen behind the app, never focusable.
 * Rules, as for the visible twitch.tv window:
 *   - each kind loads only its own twitch.tv page in the top frame (KIND patterns); other navigations are blocked, and
 *     a page that ends up elsewhere is blanked;
 *   - no JavaScript interface is added: the pages can't call into the app;
 *   - the platform runs fixed sources (packages/core/src/shared/*) in them with evaluateJavascript and reads the JSON
 *     answer; cookie values are never read or logged here;
 *   - video (Twitch's player on the channel page) is not loaded.
 */
public class TwitchHiddenPages {
    private static final String TAG = "Lurkbox";

    /** The one page each kind may show in its top frame. */
    static Pattern pattern(String kind) {
        if (kind == null) return null;
        switch (kind) {
            case "points": return Pattern.compile("^https://www\\.twitch\\.tv/embed/[a-z0-9_]{1,25}/chat(\\?[^#]*)?$");
            case "follow": return Pattern.compile("^https://www\\.twitch\\.tv/[a-z0-9_]{1,25}/?$");
            case "drops": return Pattern.compile("^https://www\\.twitch\\.tv/drops/(inventory|campaigns)/?$");
            default: return null;
        }
    }

    static boolean allowed(String kind, String url) {
        Pattern p = pattern(kind);
        return p != null && url != null && p.matcher(url).matches();
    }

    /** Twitch's video hosts: the hidden pages never play video. */
    static boolean isVideoHost(String host) {
        return host != null && (host.equals("ttvnw.net") || host.endsWith(".ttvnw.net"));
    }

    interface Done { void ok(); void fail(String reason); }

    private static class Page {
        WebView web;
        Done pending;
    }

    private final Activity activity;
    private final Map<String, Page> pages = new HashMap<>();

    TwitchHiddenPages(Activity activity) { this.activity = activity; }

    /** Opens (or replaces) the page of this kind at url, widthCss × heightCss CSS px at zoom 1. UI thread. */
    @SuppressLint("SetJavaScriptEnabled")
    void open(String kind, String url, int widthCss, int heightCss, Done done) {
        if (!allowed(kind, url)) { done.fail("not this page's twitch.tv url"); return; }
        close(kind);
        Page page = new Page();
        page.pending = done;
        WebView web = new WebView(activity);
        page.web = web;
        web.setBackgroundColor(Color.BLACK);
        web.setFocusable(false);
        web.setFocusableInTouchMode(false);
        web.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportMultipleWindows(false); // window.open() navigates here, through the allowlist (and is blocked)
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setUseWideViewPort(false); // CSS px = dp, zoom 1
        s.setLoadWithOverviewMode(false);
        s.setTextZoom(100);
        s.setUserAgentString(TwitchWebDialog.DESKTOP_UA); // the selectors follow twitch.tv's desktop pages
        CookieManager.getInstance().setAcceptCookie(true);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                if (!req.isForMainFrame()) return false;
                String u = req.getUrl().toString();
                if (allowed(kind, u)) return false;
                Log.i(TAG, "[web:" + kind + "] blocked navigation to " + TwitchWebDialog.bare(u));
                return true;
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (isVideoHost(u.getHost())) {
                    return new WebResourceResponse("text/plain", "utf-8", 403, "Blocked", new HashMap<>(), new ByteArrayInputStream(new byte[0]));
                }
                return null;
            }

            @Override
            public void onPageFinished(WebView view, String u) {
                if (pages.get(kind) != page) return;
                if ("about:blank".equals(u)) return;
                if (!allowed(kind, u)) {
                    Log.i(TAG, "[web:" + kind + "] left its page (" + TwitchWebDialog.bare(u) + "); blanked");
                    view.loadUrl("about:blank");
                    finish(page, "left the page");
                    return;
                }
                finish(page, null);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame() && pages.get(kind) == page) finish(page, "load failed (" + err.getErrorCode() + ")");
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                // Never take the app down with it: drop the page; the platform opens a new one next time.
                Log.w(TAG, "[web:" + kind + "] renderer gone; page dropped");
                if (pages.get(kind) == page) { finish(page, "renderer gone"); remove(kind); }
                return true;
            }
        });
        float density = activity.getResources().getDisplayMetrics().density;
        int w = Math.round(clamp(widthCss, 200, 2000) * density);
        int h = Math.round(clamp(heightCss, 200, 2000) * density);
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(w, h);
        web.setTranslationX(-(w + 64)); // off-screen, left of the app
        ViewGroup root = activity.findViewById(android.R.id.content);
        root.addView(web, 0, lp);
        pages.put(kind, page);
        web.loadUrl(url);
    }

    private static int clamp(int v, int lo, int hi) { return Math.max(lo, Math.min(hi, v)); }

    private void finish(Page page, String error) {
        Done d = page.pending;
        page.pending = null;
        if (d == null) return;
        if (error == null) d.ok(); else d.fail(error);
    }

    /** Runs source in the page; cb gets evaluateJavascript's JSON text ("null" without a page). UI thread. */
    void eval(String kind, String source, android.webkit.ValueCallback<String> cb) {
        Page page = pages.get(kind);
        if (page == null || page.web == null) { cb.onReceiveValue(null); return; }
        page.web.evaluateJavascript(source, cb);
    }

    boolean has(String kind) { return pages.containsKey(kind); }

    /** UI thread. */
    void close(String kind) {
        Page page = pages.get(kind);
        if (page == null) return;
        finish(page, "closed");
        remove(kind);
    }

    private void remove(String kind) {
        Page page = pages.remove(kind);
        if (page == null || page.web == null) return;
        WebView web = page.web;
        page.web = null;
        CookieManager.getInstance().flush();
        ViewGroup parent = (ViewGroup) web.getParent();
        if (parent != null) parent.removeView(web);
        web.stopLoading();
        web.destroy();
    }
}
