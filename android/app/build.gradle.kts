plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val buildNumber = (System.getenv("BRODOIT_BUILD_NUMBER") ?: "1").toIntOrNull() ?: 1
// above the Play listing's earlier builds (made outside this repo) and the first sideload builds (1–7)
val versionCodeBase = 1000
val siteUrl = System.getenv("BRODOIT_SITE_URL") ?: "https://brodoit.com"

android {
    namespace = "com.brodoit.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.brodoit.app"
        minSdk = 26
        targetSdk = 36
        versionCode = versionCodeBase + buildNumber
        versionName = "1.0.$buildNumber"
        resValue("string", "site_url", siteUrl)
        resValue("string", "site_host", siteUrl.removePrefix("https://").removePrefix("http://").trimEnd('/'))
        manifestPlaceholders["siteHost"] = siteUrl.removePrefix("https://").removePrefix("http://").trimEnd('/')
    }

    // direct: the APK served at brodoit.com/android (sideload). play: the bundle for the existing Play listing.
    flavorDimensions += "store"
    productFlavors {
        // direct: a Trusted Web Activity. play: brodoit.com in the app's own WebView (WebAppActivity, src/play manifest)
        create("direct") { dimension = "store"; applicationId = "com.brodoit.app"; resValue("string", "app_activity", "com.brodoit.app.LauncherActivity") }
        create("play") { dimension = "store"; applicationId = "com.brodoit.twa"; resValue("string", "app_activity", "com.brodoit.app.WebAppActivity") }
    }

    buildTypes {
        release {
            // Signed later by the Brodoit server with its own upload key (see modules/android.js).
            isMinifyEnabled = false
            isShrinkResources = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    packaging { resources.excludes += setOf("META-INF/AL2.0", "META-INF/LGPL2.1") }
}

dependencies {
    // the Trusted Web Activity library: the direct APK only (the Play build is a plain WebView app)
    "directImplementation"("com.google.androidbrowserhelper:androidbrowserhelper:2.5.0")
    // the Play build's WebView: Chrome tabs, the page bridge (web message listener, document-start script), back
    implementation("androidx.browser:browser:1.8.0")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.fragment:fragment:1.8.5") // Play services pull an old Fragment; the result APIs need 1.3+
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("com.google.android.gms:play-services-fitness:21.2.0")
    implementation("com.google.android.gms:play-services-base:18.5.0")
}
