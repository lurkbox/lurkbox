package io.github.lurkbox.Lurkbox;

import android.app.Activity;
import android.app.PendingIntent;
import android.app.PictureInPictureParams;
import android.app.RemoteAction;
import android.app.UiModeManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.drawable.Icon;
import android.os.Build;
import android.os.Bundle;
import android.util.Rational;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.webkit.WebSettings;
import android.webkit.CookieManager;
import android.webkit.WebView;
import androidx.annotation.RequiresApi;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.JSObject;
import java.util.ArrayList;
import java.util.List;

public class MainActivity extends BridgeActivity {
    /** The picture-in-picture window's buttons (a broadcast to this app only). */
    static final String PIP_ACTION = "io.github.lurkbox.Lurkbox.PIP_ACTION";
    /** Set by the page (LurkboxNative.pip): a video plays in the player and the setting is on. */
    private boolean pipWanted = false;
    private boolean pipPlaying = false;
    /** Left the picture-in-picture window: onResume (expanded) or onStop (dismissed) tells which. */
    private boolean leftPip = false;
    private BroadcastReceiver pipReceiver;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LurkboxNativePlugin.class);
        registerPlugin(SecureStorePlugin.class);
        super.onCreate(savedInstanceState);
        // Phones and tablets rotate freely (the core has portrait and landscape layouts); a TV stays landscape.
        if (isTelevision(this)) setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
        WebView webView = bridge.getWebView();
        WebSettings settings = webView.getSettings();
        // Streams start with sound when opened from the remote or a controller (no tap on the page).
        settings.setMediaPlaybackRequiresUserGesture(false);
        // Twitch's chat frame ("Twitch chat" style) is a third-party frame of the app's page: let it have the twitch.tv
        // session (only this WebView; the cookies it needs are SameSite=None, WebCookies.keepThirdParty).
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);
        WebCookies.keepThirdParty();
        // The HLS proxy (https://localhost/_lbhls/...) next to Capacitor's own asset server.
        bridge.setWebViewClient(new LurkboxWebViewClient(bridge));
        // D-pad focus works from the first screen: the page has the key focus, not the activity's frame.
        webView.setFocusable(true);
        webView.setFocusableInTouchMode(true);
        webView.requestFocus();
        if (pipSupported(this)) {
            pipReceiver = new BroadcastReceiver() {
                @Override
                public void onReceive(Context context, Intent intent) {
                    String action = intent.getStringExtra("action");
                    if (action == null || !action.matches("[a-z-]{1,20}")) return;
                    JSObject data = new JSObject();
                    data.put("action", action);
                    LurkboxNativePlugin.emit("pipAction", data);
                }
            };
            ContextCompat.registerReceiver(this, pipReceiver, new IntentFilter(PIP_ACTION), ContextCompat.RECEIVER_NOT_EXPORTED);
        }
    }

    @Override
    public void onDestroy() {
        if (pipReceiver != null) { try { unregisterReceiver(pipReceiver); } catch (Exception ignored) { /* not registered */ } pipReceiver = null; }
        super.onDestroy();
    }

    /** Phones and tablets with picture-in-picture (Android 8+); never on a TV. */
    static boolean pipSupported(Activity a) {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !isTelevision(a)
            && a.getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE);
    }

    /** From the page: whether leaving the app should go to picture-in-picture, and the play/pause button's state. */
    void setPip(boolean wanted, boolean playing) {
        runOnUiThread(() -> {
            pipWanted = wanted;
            pipPlaying = playing;
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || !pipSupported(this)) return;
            try { setPictureInPictureParams(pipParams()); } catch (Exception ignored) { /* the system refused; nothing to do */ }
        });
    }

    @RequiresApi(Build.VERSION_CODES.O)
    private PictureInPictureParams pipParams() {
        PictureInPictureParams.Builder b = new PictureInPictureParams.Builder().setAspectRatio(new Rational(16, 9));
        List<RemoteAction> actions = new ArrayList<>();
        Intent toggle = new Intent(PIP_ACTION).setPackage(getPackageName()).putExtra("action", "toggle-pause");
        PendingIntent pi = PendingIntent.getBroadcast(this, 1, toggle, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        String label = pipPlaying ? "Pause" : "Play";
        Icon icon = Icon.createWithResource(this, pipPlaying ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play);
        actions.add(new RemoteAction(icon, label, label, pi));
        b.setActions(actions);
        // Android 12+: the system enters picture-in-picture itself on Home or the swipe up, with a smooth animation.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) b.setAutoEnterEnabled(pipWanted).setSeamlessResizeEnabled(true);
        return b.build();
    }

    /** Home or the recents button (Android 8 to 11; 12+ enters by itself, setAutoEnterEnabled). */
    @Override
    protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        if (!pipWanted || Build.VERSION.SDK_INT < Build.VERSION_CODES.O || Build.VERSION.SDK_INT >= Build.VERSION_CODES.S || !pipSupported(this)) return;
        try { enterPictureInPictureMode(pipParams()); } catch (Exception ignored) { /* not allowed right now */ }
    }

    @Override
    public void onPictureInPictureModeChanged(boolean inPip, Configuration newConfig) {
        super.onPictureInPictureModeChanged(inPip, newConfig);
        leftPip = !inPip;
        JSObject data = new JSObject();
        data.put("inPip", inPip);
        LurkboxNativePlugin.emit("pipMode", data);
    }

    @Override
    public void onResume() {
        super.onResume();
        leftPip = false; // expanded back to full screen
    }

    @Override
    public void onStop() {
        super.onStop();
        // The picture-in-picture window was closed: stop the video (nothing should play with no window).
        if (leftPip || (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && isInPictureInPictureMode())) {
            leftPip = false;
            JSObject data = new JSObject();
            data.put("action", "pause");
            LurkboxNativePlugin.emit("pipAction", data);
        }
    }

    static boolean isTelevision(Context context) {
        UiModeManager ui = (UiModeManager) context.getSystemService(Context.UI_MODE_SERVICE);
        return ui != null && ui.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION;
    }

    /** TV remotes send DPAD_CENTER for OK; the page understands Enter (the core's A). Game controllers are left alone. */
    static int remap(int keyCode, int source) {
        boolean gamepad = (source & InputDevice.SOURCE_GAMEPAD) == InputDevice.SOURCE_GAMEPAD
            || (source & InputDevice.SOURCE_JOYSTICK) == InputDevice.SOURCE_JOYSTICK;
        if (!gamepad && keyCode == KeyEvent.KEYCODE_DPAD_CENTER) return KeyEvent.KEYCODE_ENTER;
        return keyCode;
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        int code = remap(event.getKeyCode(), event.getSource());
        if (code != event.getKeyCode()) {
            event = new KeyEvent(event.getDownTime(), event.getEventTime(), event.getAction(), code, event.getRepeatCount(),
                event.getMetaState(), event.getDeviceId(), event.getScanCode(), event.getFlags(), event.getSource());
        }
        return super.dispatchKeyEvent(event);
    }
}
