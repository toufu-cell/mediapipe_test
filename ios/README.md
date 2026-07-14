# iPhone Recorder App Scaffold

This folder contains the first iPhone-side scaffold for the capture system.

## Current Status

- `CaptureCore` is a Swift Package target that can be checked in this environment.
- `IPhoneRecorderApp/` contains SwiftUI / AVFoundation / Network / WatchConnectivity source files for an iOS app.
- The Swift self-test and code-signing-disabled simulator build have been verified for both iPhone and Watch targets.

## Transport

MVP transport is fixed as newline-delimited JSON over TCP.

- iPhone listens on TCP port `8765`.
- PC sends one token-authenticated JSON envelope per connection and then closes it.
- The iPhone rejects envelopes larger than 16 KiB or with a mismatched pairing token.
- The iPhone responds with one JSON line, for example `{"ok":true}`.

The iPhone app generates a persistent pairing token. Enter the token shown in the iPhone app into the PC Capture Session screen before sending a command.

Example start envelope:

```json
{"token":"<PAIRING_TOKEN>","command":{"type":"start","sessionId":"capture_20260524_203000","startAt":"2026-05-24T20:30:03.000+09:00","expectedDurationSec":180,"syncGesture":"wrist_shake_3_times","video":{"device":"iphone","filename":"capture_20260524_203000.mov"},"watch":{"device":"apple_watch","sampleRateHz":50,"filename":"capture_20260524_203000_wrist_imu.csv"}}}
```

Example stop envelope:

```json
{"token":"<PAIRING_TOKEN>","command":{"type":"stop","sessionId":"capture_20260524_203000","stopAt":"2026-05-24T20:33:03.000+09:00"}}
```

## Timing Contract

The iPhone must not start recording immediately when it receives `start`.

1. Receive `start`.
2. Prepare camera recording.
3. Wait until `startAt`.
4. Call `AVCaptureMovieFileOutput.startRecording(to:recordingDelegate:)`.
5. Forward the same start command to Apple Watch through WatchConnectivity if reachable.

If `startAt` is already in the past, the delay is clamped to zero and recording starts immediately.

## Local Verification

Run the command schema self-test:

```bash
cd ios
swift run CaptureCoreSelfTest
```

Reinstall the Watch recorder directly on the paired Apple Watch:

```bash
cd /path/to/mediapipe
xcodebuild -project ios/IPhoneRecorderApp.xcodeproj \
  -target WatchRecorderApp \
  -destination 'id=<WATCH_DESTINATION_ID>' \
  -quiet build

xcrun devicectl device install app \
  --device <WATCH_DEVICE_ID> \
  ios/build/Release-watchos/WatchRecorderApp.app
```

## Xcode Setup

On a machine with Xcode installed:

1. Create a new iOS App project named `IPhoneRecorderApp`.
2. Add this folder's local Swift Package (`ios/`) to the project.
3. Add the files from `ios/IPhoneRecorderApp/` to the app target.
4. Ensure the app target links:
   - `AVFoundation`
   - `Network`
   - `WatchConnectivity`
5. Merge the provided `Info.plist` usage descriptions into the app target.
6. Enable the WatchConnectivity capability when the Watch app target is added.

## References

- AVFoundation file recording uses `AVCaptureMovieFileOutput` / `AVCaptureFileOutput.startRecording(to:recordingDelegate:)`.
- TCP listener uses Network framework `NWListener`.
- Watch relay uses `WCSession.sendMessage`, which requires an active session and reachable counterpart.
