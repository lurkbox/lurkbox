// npm run android:sync | android:build | android:release (from the repo root).
//   sync:    build the web assets (build-web.mjs) and copy them into the Android project (cap sync android);
//   build:   sync, then a debug APK (gradlew assembleDebug);
//   release: sync, then a release APK (debug-signed until there is a release key).
// JAVA_HOME must be a JDK 21 (the Android Gradle Plugin doesn't run on newer ones). When it isn't set, a portable JDK
// in ~/.cache/lurkbox-jdk21/ is used if present. ANDROID_HOME defaults to ~/Android/Sdk.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildWeb } from './build-web.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ANDROID = path.join(APP, 'android');

function javaHome() {
  if (process.env.JAVA_HOME) return process.env.JAVA_HOME;
  const dir = path.join(os.homedir(), '.cache', 'lurkbox-jdk21');
  const jdk = fs.existsSync(dir) && fs.readdirSync(dir).filter((d) => /^jdk-21/.test(d)).sort().pop();
  return jdk ? path.join(dir, jdk) : undefined;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) process.exit(r.status || 1);
}

/** The APK and its version from Gradle's output-metadata.json. */
export function apkInfo(variant) {
  const dir = path.join(ANDROID, 'app', 'build', 'outputs', 'apk', variant);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'output-metadata.json'), 'utf8'));
  const el = meta.elements[0];
  return { path: path.join(dir, el.outputFile), applicationId: meta.applicationId, versionName: el.versionName, versionCode: el.versionCode };
}

async function sync() {
  await buildWeb();
  run('npx', ['cap', 'sync', 'android'], { cwd: APP });
}

function gradle(task, variant) {
  const env = { ...process.env };
  const jh = javaHome();
  if (jh) env.JAVA_HOME = jh;
  if (!env.ANDROID_HOME && !env.ANDROID_SDK_ROOT) env.ANDROID_HOME = path.join(os.homedir(), 'Android', 'Sdk');
  run('./gradlew', ['--no-daemon', task], { cwd: ANDROID, env });
  const info = apkInfo(variant);
  console.log(`\nAPK: ${info.path}\napplicationId ${info.applicationId}  versionName ${info.versionName}  versionCode ${info.versionCode}`);
}

const cmd = process.argv[2];
if (cmd === 'sync') await sync();
else if (cmd === 'build') { await sync(); gradle('assembleDebug', 'debug'); }
else if (cmd === 'release') { await sync(); gradle('assembleRelease', 'release'); }
else { console.error('usage: android.mjs sync|build|release'); process.exit(2); }
