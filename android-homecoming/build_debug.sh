#!/bin/bash
# Build the Farm Homecoming debug APK. The shared token is read from local.properties (never committed).
#   bash build_debug.sh                       (endpoint from local.properties HOMECOMING_URL)
#   bash build_debug.sh -PHOMECOMING_URL=http://10.0.2.2:8791/homecoming   (emulator -> this Mac)
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export ANDROID_HOME="$HOME/Library/Android/sdk"
cd "$(dirname "$0")"
./gradlew assembleDebug testDebugUnitTest --no-daemon "$@" 2>&1
