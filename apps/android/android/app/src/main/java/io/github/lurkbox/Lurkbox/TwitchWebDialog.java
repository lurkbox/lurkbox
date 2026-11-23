package io.github.lurkbox.Lurkbox;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.Dialog;
import android.content.Context;
import android.graphics.Color;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.KeyEvent;
import android.view.ViewGroup;
import android.view.inputmethod.InputMethodManager;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * The in-app twitch.tv window: a full-screen dialog with its own WebView, for the twitch.tv login and the Authorize
 * page (the TV sign-in, the player sign-in). Rules:
 *   - only twitch.tv's own sign-in, activation and site pages load in it (ALLOWED); anything else is blocked;
 *   - no JavaScript interface is added: the page can't call into the app;
 *   - its cookies are the app's CookieManager (shared with the app's other WebViews); values are never logged;
 *   - on a TV: the desktop layout at the TV zoom, and the shared controller navigation (frame-nav, injected by the
 *     platform as `script`) driven from the remote here, with the system keyboard for text boxes.
 */
public class TwitchWebDialog {
    private static final String TAG = "Lurkbox";
    /** The pages the window may show (as the desktop's TWITCH_WINDOW_URL). */
    static final Pattern ALLOWED = Pattern.compile("^https://((www|id|passport|m)\\.)?twitch\\.tv(/.*)?$");
    /** twitch.tv's desktop pages (the TV zoom expects them); phones and tablets get the WebView's own mobile agent. */
    static final String DESKTOP_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

    interface Listener { void onClosed(int session); }

    private final Activity activity;
    private final boolean tv;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private Dialog dialog;
    private WebView web;
    private int session;
    private double zoom = 1;
    private String script = "";
    /** Run when BACK leaves a text box in the page (frame-nav's back() answered "text"); "" for none. */
    private String textScript = "";

    TwitchWebDialog(Activity activity) {
        this.activity = activity;
        this.tv = MainActivity.isTelevision(activity);
    }

    static boolean allowed(String url) { return url != null && ALLOWED.matcher(url).matches(); }

    /** The URL without its query and fragment, for logs. */
    static String bare(String url) {
        String u = url == null ? "" : url.split("[?#]", 2)[0];
        return u.length() > 120 ? u.substring(0, 120) : u;
    }

    /** Opens the window at url (or loads url in the open one). UI thread. */
    @SuppressLint("SetJavaScriptEnabled")
    void open(String url, int session, double zoom, String script, String textScript, Listener listener) {
        this.zoom = zoom > 0 && zoom <= 4 ? zoom : 1;
        this.script = script == null ? "" : script;
        this.textScript = textScript == null ? "" : textScript;
        if (dialog != null) { this.session = session; load(url); return; }
        this.session = session;
        web = new WebView(activity);
        web.setBackgroundColor(Color.rgb(14, 14, 16));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportMultipleWindows(false); // window.open() and target=_blank load here, through the allowlist
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        if (tv) s.setUserAgentString(DESKTOP_UA);
        CookieManager.getInstance().setAcceptCookie(true);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                if (!req.isForMainFrame()) return false; // sub-frames (a captcha) are left alone
                String u = req.getUrl().toString();
                if (allowed(u)) return false;
                Log.i(TAG, "[web] blocked navigation to " + bare(u));
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String u) {
                if (!allowed(u)) { Log.i(TAG, "[web] left the allowed pages (" + bare(u) + "); closing"); close(); return; }
                prepare();
            }
        });
        dialog = new Dialog(activity, android.R.style.Theme_Black_NoTitleBar_Fullscreen) {
            @Override
            public boolean dispatchKeyEvent(KeyEvent event) {
                if (tv && handleKey(event)) return true;
                return super.dispatchKeyEvent(event);
            }
        };
        dialog.setContentView(web, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        dialog.setOnDismissListener((d) -> {
            int was = this.session;
            CookieManager.getInstance().flush();
            if (web != null) { web.stopLoading(); web.destroy(); }
            web = null;
            dialog = null;
            listener.onClosed(was);
        });
        dialog.show();
        web.requestFocus();
        load(url);
    }

    /** UI thread. */
    void load(String url) {
        if (web == null) return;
        if (!allowed(url)) { Log.i(TAG, "[web] refused to load " + bare(url)); return; }
        web.loadUrl(url);
    }

    /** UI thread. */
    void close() { if (dialog != null) dialog.dismiss(); }

    /** The TV zoom and the controller navigation, after each page load; Twitch renders its form late, so retry start(). */
    private void prepare() {
        if (web == null || !tv) return;
        web.evaluateJavascript(String.format(Locale.ROOT, "document.documentElement.style.zoom='%.2f';", zoom), null);
        if (script.isEmpty()) return;
        web.evaluateJavascript(script, null);
        final WebView w = web;
        final int[] n = {0};
        Runnable start = new Runnable() {
            @Override public void run() {
                if (web != w || ++n[0] > 60) return;
                w.evaluateJavascript("window.__lbNav ? window.__lbNav.start() : false", (r) -> { if (!"true".equals(r)) ui.postDelayed(this, 250); });
            }
        };
        ui.postDelayed(start, 250);
    }

    /** D-pad, OK and BACK (and a controller's A/B) drive the page's navigation; true when handled. */
    private boolean handleKey(KeyEvent e) {
        String key = keyName(e.getKeyCode());
        if (key == null || web == null) return false;
        if (e.getAction() != KeyEvent.ACTION_DOWN) return true;
        if ("b".equals(key)) {
            web.evaluateJavascript("(window.__lbNav ? window.__lbNav.back() : 'close')", (r) -> {
                if ("\"close\"".equals(r)) close();
                else if ("\"text\"".equals(r) && web != null && !textScript.isEmpty()) web.evaluateJavascript(textScript, null);
            });
            return true;
        }
        web.evaluateJavascript("(window.__lbNav ? window.__lbNav.press('" + key + "') : 'no-nav')", (r) -> {
            if ("\"keyboard\"".equals(r) && web != null) {
                InputMethodManager imm = (InputMethodManager) activity.getSystemService(Context.INPUT_METHOD_SERVICE);
                web.requestFocus();
                if (imm != null) imm.showSoftInput(web, InputMethodManager.SHOW_IMPLICIT);
            }
        });
        return true;
    }

    static String keyName(int code) {
        switch (code) {
            case KeyEvent.KEYCODE_DPAD_UP: return "up";
            case KeyEvent.KEYCODE_DPAD_DOWN: return "down";
            case KeyEvent.KEYCODE_DPAD_LEFT: return "left";
            case KeyEvent.KEYCODE_DPAD_RIGHT: return "right";
            case KeyEvent.KEYCODE_DPAD_CENTER:
            case KeyEvent.KEYCODE_ENTER:
            case KeyEvent.KEYCODE_BUTTON_A: return "a";
            case KeyEvent.KEYCODE_BACK:
            case KeyEvent.KEYCODE_BUTTON_B: return "b";
            default: return null;
        }
    }
}
