package io.github.lurkbox.Lurkbox;

import android.app.UiModeManager;
import android.content.Context;
import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import android.os.Bundle;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.webkit.WebSettings;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

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
        // The HLS proxy (https://localhost/_lbhls/...) next to Capacitor's own asset server.
        bridge.setWebViewClient(new LurkboxWebViewClient(bridge));
        // D-pad focus works from the first screen: the page has the key focus, not the activity's frame.
        webView.setFocusable(true);
        webView.setFocusableInTouchMode(true);
        webView.requestFocus();
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
