#!/usr/bin/env bash
# The Google Play build (com.brodoit.android) on an emulator, the way a tester meets it (run by .github/workflows/android.yml):
#   install → first open asks for Physical activity → Allow → brodoit.com opens inside the app's own WebView
#   (WebAppActivity, not Chrome) → a periodic sync job is scheduled → https://brodoit.com links and the
#   brodoit://enable deep link open in the app → without internet the app shows its own "You're offline" screen,
#   and "Try again" brings the page back → nothing crashed.
#   bash android-smoke-play.sh <apk> <out dir>
set -u
APK="$1"; OUT="$2"; PKG=com.brodoit.android; ACT=com.brodoit.app.WebAppActivity
mkdir -p "$OUT"
fails=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fails=$((fails + 1)); }
shot() { adb exec-out screencap -p > "$OUT/$1.png" 2>/dev/null || true; }
front() { adb shell dumpsys activity activities | grep -E 'ResumedActivity' | head -1; }
# the screen as text (uiautomator); a dump sometimes fails mid-animation, so a few tries. When it keeps failing, say
# once what uiautomator said and what is in front (some emulator images leave a window out of the tree).
dump() {
  for _ in 1 2 3 4 5; do
    adb shell uiautomator dump /sdcard/ui.xml > "$OUT/dump.txt" 2>&1 && adb exec-out cat /sdcard/ui.xml > "$OUT/ui.xml" 2>/dev/null && grep -q '<node' "$OUT/ui.xml" && return 0
    sleep 2
  done
  [ -n "${dump_said:-}" ] || { dump_said=1; echo "     (uiautomator dump: $(tr -d '\r' < "$OUT/dump.txt" | tail -1 | cut -c1-160); front: $(front | cut -c1-120))"; }
  return 1
}
# the Physical activity dialog: Allow in the UI tree. On images where the dialog is in front but missing from the tree
# (API 35, Nov 2026), grant it the adb way and close the dialog; the app opens the page after a decline as well.
allow_activity() {
  { tap 'permission_allow_button' || tap 'Allow'; } && return 0
  if front | grep -q 'GrantPermissionsActivity'; then
    adb shell pm grant "$PKG" android.permission.ACTIVITY_RECOGNITION > /dev/null 2>&1; adb shell input keyevent KEYCODE_BACK; sleep 2
    echo "     (Allow given the adb way: the dialog is in front but not in the UI tree)"; return 0
  fi
  return 1
}
wait_for() {
  local t=0
  while [ "$t" -lt "$2" ]; do dump && grep -qiE "$1" "$OUT/ui.xml" && return 0; sleep 3; t=$((t + 3)); done
  return 1
}
tap() {
  dump || return 1
  local b
  b=$(grep -oE "<node [^>]*(text=\"$1\"|resource-id=\"[^\"]*$1\")[^>]*>" "$OUT/ui.xml" | head -1 | grep -oE 'bounds="\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]"' | grep -oE '[0-9]+' | tr '\n' ' ')
  [ -n "$b" ] || return 1
  set -- $b
  adb shell input tap $(( ($1 + $3) / 2 )) $(( ($2 + $4) / 2 ))
}
# the page is up when the WebView is on screen and shows text from brodoit.com
page_up() {
  local t=0
  while [ "$t" -lt "$1" ]; do
    if dump && grep -q 'android.webkit.WebView' "$OUT/ui.xml" && grep -qiE 'text="[^"]*(brodoit|bro|sign|continue|email|name|tasks|news)[^"]*"|content-desc="[^"]*(brodoit|bro)' "$OUT/ui.xml"; then return 0; fi
    sleep 3; t=$((t + 3))
  done
  return 1
}

adb logcat -c || true
adb install -r "$APK" > "$OUT/install.txt" 2>&1 && ok "installs ($(tail -1 "$OUT/install.txt"))" || { bad "install: $(cat "$OUT/install.txt")"; exit 1; }
adb shell pm list packages | grep -q "package:$PKG" && ok "the package is $PKG" || bad "package $PKG not listed"
adb shell cmd package resolve-activity --brief -c android.intent.category.LAUNCHER "$PKG" | tail -1 | grep -q "$PKG/$ACT" \
  && ok "the launcher opens $ACT (no Trusted Web Activity)" || bad "launcher: $(adb shell cmd package resolve-activity --brief -c android.intent.category.LAUNCHER "$PKG" | tail -1)"
adb shell dumpsys package "$PKG" | grep -q 'android.permission.RECORD_AUDIO' && ok "declares the microphone (Bro listens)" || bad "RECORD_AUDIO is missing"

# first open: the app asks for Physical activity straight away
adb shell am start -W -n "$PKG/$ACT" > "$OUT/start.txt" 2>&1
asked=0
wait_for 'physical activity' 120 && asked=1
# the dialog in front counts too: on some images it never appears in the UI tree
[ "$asked" = 0 ] && front | grep -q 'GrantPermissionsActivity' && asked=2
case $asked in 1) ok "first open asks for Physical activity";; 2) ok "first open asks for Physical activity (the dialog is in front; this image keeps it out of the UI tree)";; *) bad "no Physical activity request on first open (front: $(front | cut -c1-120))";; esac
shot 1-permission
allow_activity || bad "could not tap Allow"
sleep 3
adb shell dumpsys package "$PKG" | grep -q 'android.permission.ACTIVITY_RECOGNITION: granted=true' && ok "Physical activity allowed" || bad "Physical activity not granted"

# then brodoit.com opens inside the app itself
if page_up 120; then ok "brodoit.com opens inside the app's WebView"; else bad "the page did not show (front: $(front))"; fi
front | grep -q "$PKG/$ACT" && ok "the app stays in front ($ACT), not Chrome" || bad "front is $(front)"
shot 2-app

adb shell dumpsys jobscheduler | grep -q "$PKG" && ok "a background sync job is scheduled" || bad "no background job for $PKG"

# brodoit.com links open in the app (shortcuts, shared news links)
adb shell am start -W -a android.intent.action.VIEW -d 'https://brodoit.com/?tab=steps' "$PKG" > "$OUT/applink.txt" 2>&1
sleep 5
front | grep -q "$PKG/$ACT" && ok "https://brodoit.com links open in the app" || bad "link: $(front)"
shot 3-link

# the steps deep link the web app uses (brodoit://enable) opens the app's steps screen
adb shell am start -W -a android.intent.action.VIEW -d 'brodoit://enable' "$PKG" > "$OUT/deeplink.txt" 2>&1
grep -qE 'Status: ok|EnableStepsActivity|WebAppActivity' "$OUT/deeplink.txt" && ok "brodoit://enable opens the app" || bad "deep link: $(tr '\n' ' ' < "$OUT/deeplink.txt")"
sleep 8; shot 4-deeplink

# no internet. offline(): airplane mode plus wifi and mobile data off, and say if the emulator still gets out.
offline() { adb shell cmd connectivity airplane-mode enable > /dev/null 2>&1; adb shell svc wifi disable > /dev/null 2>&1; adb shell svc data disable > /dev/null 2>&1; sleep 5
  adb shell ping -c 1 -W 3 8.8.8.8 > /dev/null 2>&1 && echo "note: the emulator still reaches the internet"; true; }
online() { adb shell cmd connectivity airplane-mode disable > /dev/null 2>&1; adb shell svc wifi enable > /dev/null 2>&1; adb shell svc data enable > /dev/null 2>&1; sleep 10; }
# 1) opened before: brodoit.com's service worker serves the app it saved (or the offline screen)
adb shell am force-stop "$PKG"; offline
adb shell am start -W -n "$PKG/$ACT" > /dev/null 2>&1
if wait_for "Brodoit needs the internet" 40; then ok "without internet (opened before): the app's offline screen"
elif page_up 20; then ok "without internet (opened before): Brodoit opens from what it saved"
else bad "without internet (opened before): neither the page nor the offline screen"; fi
shot 5-offline-saved
# 2) nothing saved (app data cleared): the app's own offline screen, then "Try again" once the internet is back
adb shell am force-stop "$PKG"; adb shell pm clear "$PKG" > /dev/null 2>&1
adb shell am start -W -n "$PKG/$ACT" > /dev/null 2>&1
if wait_for 'physical activity' 60 || front | grep -q 'GrantPermissionsActivity'; then allow_activity || true; fi
if wait_for "Brodoit needs the internet" 60; then ok "without internet (first open): the app's offline screen"; else bad "no offline screen on a first open without internet"; fi
shot 6-offline-first
online
tap 'Try again' || bad "could not tap Try again"
if page_up 90; then ok "Try again brings brodoit.com back"; else bad "the page did not come back after Try again"; fi
shot 7-back-online

adb shell dumpsys package "$PKG" | grep -q 'android.permission.POST_NOTIFICATIONS' && ok "asks for notifications (POST_NOTIFICATIONS)" || bad "POST_NOTIFICATIONS is missing"

adb logcat -d > "$OUT/logcat.txt" 2>&1
grep -E 'BrodoitWeb' "$OUT/logcat.txt" | head -20 > "$OUT/page-errors.txt" || true
if grep -E 'FATAL EXCEPTION' -A3 "$OUT/logcat.txt" | grep -q "$PKG"; then bad "the app crashed: $(grep -A6 'FATAL EXCEPTION' "$OUT/logcat.txt" | head -8 | tr '\n' ' ')"; else ok "no crash"; fi

echo "android smoke (Play build): $fails failed"
[ "$fails" -eq 0 ]
