#!/usr/bin/env node
// Patch the Android project that `tauri android init` just generated.
//
// Three things in the generated tree cannot survive a CI build as-is:
//
// 1. gradle-wrapper.properties points at services.gradle.org, which times out
//    from GitHub runners (java.net.SocketTimeoutException on the 8.14.3
//    distribution). The Tencent mirror serves the identical archive.
//
// 2. tauri-plugin-native-bridge publishes its Android library with two extra
//    flavour dimensions - store (foss | googleplay) and pen (genericPen |
//    booxPen) - so it has four variants. A freshly generated app module
//    declares neither dimension, Gradle cannot pick one, and the build dies
//    with:
//      Could not resolve project :tauri-plugin-native-bridge
//      There are several available matching variants
//    missingDimensionStrategy is how upstream readest resolves this too.
//
// Both patches are idempotent: running twice is a no-op.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const genDir = join(root, 'apps/readest-app/src-tauri/gen/android');

if (!existsSync(genDir)) {
  console.error(`patch-android: ${genDir} does not exist - run \`tauri android init\` first`);
  process.exit(1);
}

// --- 1. Gradle distribution mirror -----------------------------------------
const wrapperPath = join(genDir, 'gradle/wrapper/gradle-wrapper.properties');
if (existsSync(wrapperPath)) {
  const before = readFileSync(wrapperPath, 'utf8');
  const after = before.replace(
    /services\.gradle\.org\/distributions/g,
    'mirrors.cloud.tencent.com/gradle',
  );
  if (after !== before) {
    writeFileSync(wrapperPath, after);
    const line = after.split('\n').find((l) => l.startsWith('distributionUrl'));
    console.log(`patch-android: gradle -> ${line?.trim()}`);
  } else {
    console.log('patch-android: gradle distribution already mirrored');
  }
} else {
  console.warn(`patch-android: no wrapper properties at ${wrapperPath}`);
}

// --- 2. Flavour dimension strategies ---------------------------------------
const appGradlePath = join(genDir, 'app/build.gradle.kts');
const strategies = [
  'missingDimensionStrategy("store", "foss")',
  'missingDimensionStrategy("pen", "genericPen")',
];

if (!existsSync(appGradlePath)) {
  console.error(`patch-android: ${appGradlePath} missing`);
  process.exit(1);
}

let gradle = readFileSync(appGradlePath, 'utf8');

if (gradle.includes(strategies[0])) {
  console.log('patch-android: flavour strategies already present');
} else {
  // Insert as the first statements of defaultConfig { ... }: they must be set
  // before Gradle resolves the module's own configurations.
  const anchor = /defaultConfig\s*\{/;
  if (!anchor.test(gradle)) {
    console.error('patch-android: could not find defaultConfig block to patch');
    process.exit(1);
  }
  gradle = gradle.replace(
    anchor,
    `defaultConfig {\n        // Consume the plugin's store/pen variants explicitly; without this the\n        // app module cannot choose between foss/googleplay and pen flavours.\n        ${strategies.join('\n        ')}`,
  );
  writeFileSync(appGradlePath, gradle);
  console.log('patch-android: added missingDimensionStrategy for store + pen');
}

// --- 3. Release signing ----------------------------------------------------
// The generated template declares no signingConfigs, so `assembleRelease`
// emits app-universal-release-unsigned.apk - an APK nobody can install.
//
// A debug build is the obvious way out and it is what the first Read-EX APK
// used, but Rust debug profile leaves libreadestlib.so unstripped and the APK
// came out at 659 MB. A signed release variant lets Gradle strip the native
// libraries, which is the whole point of building release.
//
// The keystore is PKCS12, decoded from a repository secret by the workflow into
// app/readex.p12. Its alias and password go into keystore.properties at the
// android project root; keeping them out of this file means the build script
// itself carries no secret.
const SIGNING_BLOCK = `
// --- Read-EX release signing (added by scripts/patch-android-project.mjs) ---
val readexKeystoreProps = rootProject.file("keystore.properties")
val readexSigning = java.util.Properties()
if (readexKeystoreProps.exists()) {
    readexKeystoreProps.inputStream().use { readexSigning.load(it) }
}
android {
    signingConfigs {
        if (readexKeystoreProps.exists()) {
            create("readex") {
                storeFile = file(readexSigning.getProperty("storeFile"))
                storePassword = readexSigning.getProperty("password")
                keyAlias = readexSigning.getProperty("keyAlias")
                keyPassword = readexSigning.getProperty("password")
            }
        }
    }
    buildTypes {
        getByName("release") {
            if (readexKeystoreProps.exists()) {
                signingConfig = signingConfigs.getByName("readex")
            }
        }
    }
}
`;

gradle = readFileSync(appGradlePath, 'utf8');

if (gradle.includes('readexSigning')) {
  console.log('patch-android: signing block already present');
} else {
  writeFileSync(appGradlePath, `${gradle.trimEnd()}\n${SIGNING_BLOCK}`);
  console.log('patch-android: appended release signing block');
}

const keystoreFile = join(genDir, 'app/readex.p12');
const propsFile = join(genDir, 'keystore.properties');
const keystorePassword = process.env.ANDROID_KEYSTORE_PASSWORD ?? '';

if (existsSync(keystoreFile) && keystorePassword) {
  writeFileSync(
    propsFile,
    [
      'storeFile=readex.p12',
      'keyAlias=readex',
      `password=${keystorePassword}`,
      '',
    ].join('\n'),
  );
  console.log('patch-android: wrote keystore.properties (PKCS12, alias readex)');
} else if (existsSync(keystoreFile)) {
  console.warn('patch-android: ANDROID_KEYSTORE_PASSWORD unset - release APK will be unsigned');
} else {
  console.log('patch-android: no keystore decoded - release APK will be unsigned');
}
