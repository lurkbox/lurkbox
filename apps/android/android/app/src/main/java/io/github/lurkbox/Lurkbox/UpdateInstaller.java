package io.github.lurkbox.Lurkbox;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Update notifications: downloads the release APK from GitHub, checks it against the release's SHA256SUMS.txt, compares
 * its signing certificate with this install's, and opens the system installer for it through the FileProvider. Only
 * GitHub's hosts (packages/core/src/shared/updates.js UPDATE_HOSTS), https on the default port, no credentials; redirects
 * are followed here one hop at a time, each checked like the first URL (as HlsProxy does). No cookies are sent.
 */
final class UpdateInstaller {
    private static final Set<String> HOSTS = new HashSet<>(Arrays.asList("api.github.com", "github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"));
    private static final Pattern NAME = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}\\.apk$");
    private static final Pattern SUM_LINE = Pattern.compile("^([0-9a-fA-F]{64}) [ *]?(\\S.*)$");
    private static final int MAX_REDIRECTS = 5;
    private static final long MAX_APK = 512L * 1024 * 1024;
    private static final int MAX_SUMS = 64 * 1024;

    interface Progress { void update(long received, long total); }

    private UpdateInstaller() {}

    static boolean allowed(URL u) {
        return u != null && "https".equalsIgnoreCase(u.getProtocol()) && u.getUserInfo() == null && (u.getPort() == -1 || u.getPort() == 443)
            && HOSTS.contains(u.getHost().toLowerCase(Locale.ROOT));
    }

    static boolean validName(String name) { return name != null && NAME.matcher(name).matches(); }

    static File dir(Context ctx) { return new File(ctx.getCacheDir(), "updates"); }

    /** An open connection to url after following (checked) redirects; the caller disconnects it. */
    private static HttpURLConnection open(String url) throws Exception {
        URL target = new URL(url);
        if (!allowed(target)) throw new Exception("update URL not allowed");
        for (int hop = 0; ; hop++) {
            HttpURLConnection c = (HttpURLConnection) target.openConnection();
            c.setInstanceFollowRedirects(false);
            c.setUseCaches(false);
            c.setConnectTimeout(15000);
            c.setReadTimeout(30000);
            c.setRequestProperty("User-Agent", "Lurkbox-updater");
            int status = c.getResponseCode();
            if (status < 300 || status >= 400 || status == 304) {
                if (status != 200) { c.disconnect(); throw new Exception("HTTP " + status + " from " + target.getHost()); }
                return c;
            }
            String location = c.getHeaderField("Location");
            c.disconnect();
            URL next = location == null ? null : new URL(target, location);
            if (next == null || !allowed(next)) throw new Exception("redirect from " + target.getHost() + " not followed");
            if (hop >= MAX_REDIRECTS) throw new Exception("too many redirects");
            target = next;
        }
    }

    /** The SHA-256 for name in the release's SHA256SUMS.txt. */
    static String expectedSha(String sumsUrl, String name) throws Exception {
        HttpURLConnection c = open(sumsUrl);
        try (InputStream in = c.getInputStream()) {
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] b = new byte[8192];
            int n;
            while ((n = in.read(b)) > 0) {
                buf.write(b, 0, n);
                if (buf.size() > MAX_SUMS) throw new Exception("checksums too large");
            }
            for (String line : buf.toString("UTF-8").split("\\r?\\n")) {
                Matcher m = SUM_LINE.matcher(line.trim());
                if (m.matches() && m.group(2).trim().equals(name)) return m.group(1).toLowerCase(Locale.ROOT);
            }
        } finally { c.disconnect(); }
        throw new Exception("no checksum for " + name);
    }

    private static String hex(byte[] d) {
        StringBuilder sb = new StringBuilder();
        for (byte x : d) sb.append(String.format(Locale.ROOT, "%02x", x));
        return sb.toString();
    }

    /**
     * Downloads url to cache/updates/name (a .part file first, renamed once its SHA-256 matches). Returns the file.
     * Older downloads in that folder are deleted.
     */
    static File download(Context ctx, String url, String sumsUrl, String name, Progress progress) throws Exception {
        if (!validName(name)) throw new Exception("bad file name");
        String sha = expectedSha(sumsUrl, name);
        File dir = dir(ctx);
        if (!dir.isDirectory() && !dir.mkdirs()) throw new Exception("no cache folder");
        File[] old = dir.listFiles();
        if (old != null) for (File f : old) f.delete();
        File part = new File(dir, name + ".part");
        File out = new File(dir, name);
        HttpURLConnection c = open(url);
        try {
            long total = c.getContentLengthLong();
            if (total > MAX_APK) throw new Exception("the APK is too large");
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            long received = 0;
            long last = 0;
            try (InputStream in = c.getInputStream(); OutputStream os = new FileOutputStream(part)) {
                byte[] b = new byte[65536];
                int n;
                while ((n = in.read(b)) > 0) {
                    received += n;
                    if (received > MAX_APK) throw new Exception("the APK is too large");
                    md.update(b, 0, n);
                    os.write(b, 0, n);
                    if (received - last >= 512 * 1024) { last = received; progress.update(received, total); }
                }
            }
            progress.update(received, total);
            if (!hex(md.digest()).equals(sha)) throw new Exception("the download does not match its SHA-256 checksum");
            if (!part.renameTo(out)) throw new Exception("could not save the APK");
            return out;
        } catch (Exception e) {
            part.delete();
            throw e;
        } finally { c.disconnect(); }
    }

    @SuppressWarnings("deprecation")
    private static Set<String> certs(PackageInfo info) {
        Set<String> out = new HashSet<>();
        if (info == null) return out;
        Signature[] sigs = null;
        if (Build.VERSION.SDK_INT >= 28 && info.signingInfo != null) {
            sigs = info.signingInfo.hasMultipleSigners() ? info.signingInfo.getApkContentsSigners() : info.signingInfo.getSigningCertificateHistory();
        } else {
            sigs = info.signatures;
        }
        if (sigs == null) return out;
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            for (Signature s : sigs) out.add(hex(md.digest(s.toByteArray())));
        } catch (Exception ignored) { /* none */ }
        return out;
    }

    /** "match", "mismatch" or "unknown": is the APK signed with (one of) this install's signing certificates? */
    @SuppressWarnings("deprecation")
    static String signature(Context ctx, File apk) {
        try {
            PackageManager pm = ctx.getPackageManager();
            int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
            Set<String> mine = certs(pm.getPackageInfo(ctx.getPackageName(), flags));
            PackageInfo theirs = pm.getPackageArchiveInfo(apk.getAbsolutePath(), flags);
            if (theirs == null || !ctx.getPackageName().equals(theirs.packageName)) return theirs == null ? "unknown" : "mismatch";
            Set<String> other = certs(theirs);
            if (mine.isEmpty() || other.isEmpty()) return "unknown";
            for (String s : other) if (mine.contains(s)) return "match";
            return "mismatch";
        } catch (Exception e) {
            return "unknown";
        }
    }

    /**
     * Opens the system installer for the downloaded APK. Android 8+ needs "install unknown apps" for Lurkbox: without it
     * this opens that setting instead and returns false.
     */
    static boolean install(Activity activity, String name) throws Exception {
        if (!validName(name)) throw new Exception("bad file name");
        File apk = new File(dir(activity), name);
        if (!apk.isFile()) throw new Exception("the download is gone");
        if (Build.VERSION.SDK_INT >= 26 && !activity.getPackageManager().canRequestPackageInstalls()) {
            try {
                activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + activity.getPackageName())));
            } catch (ActivityNotFoundException e) {
                activity.startActivity(new Intent(Settings.ACTION_SECURITY_SETTINGS));
            }
            return false;
        }
        Uri uri = FileProvider.getUriForFile(activity, activity.getPackageName() + ".fileprovider", apk);
        Intent i = new Intent(Intent.ACTION_VIEW);
        i.setDataAndType(uri, "application/vnd.android.package-archive");
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        activity.startActivity(i);
        return true;
    }
}
