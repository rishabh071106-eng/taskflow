package com.brodoit.app

import android.net.Uri
import android.os.Bundle
import android.content.Intent

/**
 * Opens brodoit.com as a Trusted Web Activity. On the very first open it detours through EnableStepsActivity
 * (one "Allow" for Physical activity). Until the phone is bound to an account, the launch URL carries the pairing
 * pair (device_id + ct) that the web app redeems silently after login — zero-tap pairing.
 */
class LauncherActivity : com.google.androidbrowserhelper.trusted.LauncherActivity() {
    private var detour = false

    override fun onCreate(savedInstanceState: Bundle?) {
        val prefs = Prefs(this)
        detour = !prefs.asked && savedInstanceState == null
        super.onCreate(savedInstanceState)
        if (detour) {
            prefs.asked = true
            startActivity(Intent(this, EnableStepsActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            finish(); return
        }
        if (prefs.enabled) { Scheduler.ensurePeriodic(this); Scheduler.soon(this, 3L, 45L) }
    }

    /** First run detours through the native "Allow" screen; it relaunches us afterwards. */
    override fun shouldLaunchImmediately(): Boolean = !detour

    override fun getLaunchingUrl(): Uri {
        val base = super.getLaunchingUrl()
        val prefs = Prefs(this)
        val b = base.buildUpon()
        if (base.getQueryParameter("twa") == null) b.appendQueryParameter("twa", "1")
        val id = prefs.deviceId; val ct = prefs.claimToken
        if (!prefs.bound && id != null && ct != null && base.getQueryParameter("device_id") == null) {
            b.appendQueryParameter("device_id", id).appendQueryParameter("ct", ct)
        }
        return b.build()
    }
}
