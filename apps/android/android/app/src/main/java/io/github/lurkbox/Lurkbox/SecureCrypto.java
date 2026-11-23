package io.github.lurkbox.Lurkbox;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Encryption for the app's stored credentials (SecureStorePlugin's values, WebCookies' jars): AES-256-GCM with a key
 * generated in the Android Keystore, which never leaves it (not exportable). A value is "lb1:" + base64(iv | ciphertext
 * with the GCM tag). Any failure to use the key or to open a value (a key invalidated after a security change, a wiped
 * Keystore after a restore, a tampered value) is a {@link Unreadable}: callers drop the data and the user signs in again.
 */
final class SecureCrypto {
    static final String PREFIX = "lb1:";
    private static final String ALIAS = "lurkbox-store-v1";
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String TRANSFORM = "AES/GCM/NoPadding";
    private static final int IV_BYTES = 12;
    private static final int TAG_BITS = 128;

    /** The stored data can't be opened (or sealed) with the Keystore key. */
    static final class Unreadable extends Exception {
        Unreadable(String message, Throwable cause) { super(message, cause); }
    }

    private SecureCrypto() {}

    private static synchronized SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance(KEYSTORE);
        ks.load(null);
        KeyStore.Entry entry = ks.getEntry(ALIAS, null);
        if (entry instanceof KeyStore.SecretKeyEntry) return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
        KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        gen.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setRandomizedEncryptionRequired(true)
            .build());
        return gen.generateKey();
    }

    /** Deletes the Keystore key (after it stopped working); the next seal makes a new one. */
    static synchronized void resetKey() {
        try {
            KeyStore ks = KeyStore.getInstance(KEYSTORE);
            ks.load(null);
            if (ks.containsAlias(ALIAS)) ks.deleteEntry(ALIAS);
        } catch (Exception ignored) { /* nothing more to do */ }
    }

    static boolean isSealed(String s) { return s != null && s.startsWith(PREFIX); }

    static String seal(String plain) throws Unreadable {
        try {
            Cipher c = Cipher.getInstance(TRANSFORM);
            c.init(Cipher.ENCRYPT_MODE, key()); // the Keystore picks a random IV
            byte[] ct = c.doFinal(plain.getBytes(StandardCharsets.UTF_8));
            byte[] iv = c.getIV();
            if (iv == null || iv.length != IV_BYTES) throw new IllegalStateException("unexpected IV");
            byte[] out = ByteBuffer.allocate(iv.length + ct.length).put(iv).put(ct).array();
            return PREFIX + Base64.encodeToString(out, Base64.NO_WRAP);
        } catch (Exception e) {
            throw new Unreadable("could not encrypt", e);
        }
    }

    static String open(String sealed) throws Unreadable {
        if (!isSealed(sealed)) throw new Unreadable("not an encrypted value", null);
        try {
            byte[] all = Base64.decode(sealed.substring(PREFIX.length()), Base64.NO_WRAP);
            if (all.length <= IV_BYTES) throw new IllegalArgumentException("too short");
            Cipher c = Cipher.getInstance(TRANSFORM);
            c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(TAG_BITS, all, 0, IV_BYTES));
            return new String(c.doFinal(all, IV_BYTES, all.length - IV_BYTES), StandardCharsets.UTF_8);
        } catch (Exception e) {
            throw new Unreadable("could not decrypt", e);
        }
    }
}
