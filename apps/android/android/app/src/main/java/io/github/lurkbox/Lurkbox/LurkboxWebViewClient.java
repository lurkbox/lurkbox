package io.github.lurkbox.Lurkbox;

import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

/** Capacitor's WebView client plus the HLS proxy path on the app's own origin (https://localhost/_lbhls/...). */
public class LurkboxWebViewClient extends BridgeWebViewClient {

    public LurkboxWebViewClient(Bridge bridge) {
        super(bridge);
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        Uri url = request.getUrl();
        if ("https".equals(url.getScheme()) && "localhost".equals(url.getHost()) && HlsProxy.handles(url.getEncodedPath())) {
            return HlsProxy.serve(request.getMethod(), url.getEncodedPath(), url.getEncodedQuery(), request.getRequestHeaders());
        }
        return super.shouldInterceptRequest(view, request);
    }
}
