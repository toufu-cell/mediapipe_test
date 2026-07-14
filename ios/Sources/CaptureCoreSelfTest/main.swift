import CaptureCore
import Foundation

enum SelfTestError: Error, CustomStringConvertible {
    case assertionFailed(String)

    var description: String {
        switch self {
        case let .assertionFailed(message):
            return message
        }
    }
}

func expect(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    guard condition() else {
        throw SelfTestError.assertionFailed(message)
    }
}

func testDecodeStartCommandFromNewlineDelimitedJson() throws {
    let line = """
    {"type":"start","sessionId":"capture_20260524_203000","startAt":"2026-05-24T20:30:03.000+09:00","expectedDurationSec":180,"syncGesture":"wrist_shake_3_times","video":{"device":"iphone","filename":"capture_20260524_203000.mov"},"watch":{"device":"apple_watch","sampleRateHz":50,"filename":"capture_20260524_203000_wrist_imu.csv"}}
    \n
    """

    let command = try CaptureCommandLineDecoder.decodeCommandLine(line)

    guard case let .start(start) = command else {
        throw SelfTestError.assertionFailed("Expected start command")
    }

    try expect(start.sessionId == "capture_20260524_203000", "sessionId mismatch")
    try expect(start.syncGesture == "wrist_shake_3_times", "syncGesture mismatch")
    try expect(start.video.filename == "capture_20260524_203000.mov", "video filename mismatch")
    try expect(start.watch.sampleRateHz == 50, "watch sampleRateHz mismatch")
}

func testAuthenticatedCommandRequiresMatchingToken() throws {
    let command = """
    {"type":"stop","sessionId":"capture_test","stopAt":"2026-05-24T20:31:03.000+09:00"}
    """
    let envelope = """
    {"token":"capture-test-token-1234","command":\(command)}
    """

    let decoded = try AuthenticatedCaptureCommandLineDecoder.decodeCommandLine(
        envelope,
        expectedToken: "capture-test-token-1234"
    )
    guard case let .stop(stop) = decoded else {
        throw SelfTestError.assertionFailed("Expected stop command")
    }
    try expect(stop.sessionId == "capture_test", "authenticated sessionId mismatch")

    do {
        _ = try AuthenticatedCaptureCommandLineDecoder.decodeCommandLine(
            envelope,
            expectedToken: "different-test-token-1234"
        )
        throw SelfTestError.assertionFailed("Mismatched token should be rejected")
    } catch AuthenticatedCaptureCommandDecodeError.unauthorized {
        // Expected.
    }
}

func testScheduledDelayUsesFutureStartAt() throws {
    let command = StartCaptureCommand(
        sessionId: "capture_future",
        startAt: Date(timeIntervalSince1970: 1003),
        expectedDurationSec: 180,
        syncGesture: "wrist_shake_3_times",
        video: CaptureVideoTarget(device: "iphone", filename: "capture_future.mov"),
        watch: CaptureWatchTarget(device: "apple_watch", sampleRateHz: 50, filename: "capture_future_wrist_imu.csv")
    )

    try expect(command.scheduledDelay(now: Date(timeIntervalSince1970: 1000)) == 3.0, "future delay mismatch")
}

func testScheduledDelayClampsPastStartAtToZero() throws {
    let command = StartCaptureCommand(
        sessionId: "capture_past",
        startAt: Date(timeIntervalSince1970: 997),
        expectedDurationSec: 180,
        syncGesture: "wrist_shake_3_times",
        video: CaptureVideoTarget(device: "iphone", filename: "capture_past.mov"),
        watch: CaptureWatchTarget(device: "apple_watch", sampleRateHz: 50, filename: "capture_past_wrist_imu.csv")
    )

    try expect(command.scheduledDelay(now: Date(timeIntervalSince1970: 1000)) == 0.0, "past delay should clamp to zero")
}

func testIMUCSVWriterFormatsSamples() throws {
    let samples = [
        WatchIMUSample(
            sessionId: "capture_20260524_203000",
            timestamp: Date(timeIntervalSince1970: 1_000.100),
            startedAt: Date(timeIntervalSince1970: 1_000.000),
            accelX: 0.01,
            accelY: 0.98,
            accelZ: 0.03,
            gyroX: 0.10,
            gyroY: 0.02,
            gyroZ: 0.01
        ),
    ]

    let csv = WatchIMUCSVWriter.makeCSV(samples: samples)
    let lines = csv.split(separator: "\n").map(String.init)

    try expect(lines.count == 2, "CSV should contain header and one sample")
    try expect(
        lines[0] == "session_id,timestamp_ms,elapsed_ms,accel_x,accel_y,accel_z,gyro_x,gyro_y,gyro_z,accel_norm,gyro_norm",
        "CSV header mismatch"
    )
    try expect(
        lines[1] == "capture_20260524_203000,1000100,100,0.010000,0.980000,0.030000,0.100000,0.020000,0.010000,0.980510,0.102470",
        "CSV row mismatch: \(lines[1])"
    )
}

func testWatchLocalTimebaseIgnoresCommandStartAt() throws {
    let commandStartAt = Date(timeIntervalSince1970: 2_000)
    let watchNow = Date(timeIntervalSince1970: 1_000)

    let timing = WatchIMUTimebase.localDeviceTiming(commandStartAt: commandStartAt, watchNow: watchNow)

    try expect(timing.delay == 0, "Watch local timebase should not wait for PC command startAt")
    try expect(timing.startedAt == watchNow, "Watch local timebase should use current Watch time")
}

func testWatchCommandDeliveryStateRejectsStartAfterUnknownStop() throws {
    var deliveryState = WatchCommandDeliveryState()

    deliveryState.markStopped("capture_stopped_before_start")

    try expect(
        deliveryState.canAcceptStart(
            sessionId: "capture_stopped_before_start",
            currentSessionId: nil,
            pendingStartSessionId: nil
        ) == false,
        "Start should be rejected after an earlier stop for the same session"
    )
}

let tests: [(String, () throws -> Void)] = [
    ("decode start command from newline-delimited JSON", testDecodeStartCommandFromNewlineDelimitedJson),
    ("authenticated command requires matching token", testAuthenticatedCommandRequiresMatchingToken),
    ("scheduled delay uses future startAt", testScheduledDelayUsesFutureStartAt),
    ("scheduled delay clamps past startAt to zero", testScheduledDelayClampsPastStartAtToZero),
    ("IMU CSV writer formats samples", testIMUCSVWriterFormatsSamples),
    ("Watch local timebase ignores command startAt", testWatchLocalTimebaseIgnoresCommandStartAt),
    ("Watch command delivery state rejects start after unknown stop", testWatchCommandDeliveryStateRejectsStartAfterUnknownStop),
]

do {
    for (name, test) in tests {
        try test()
        print("PASS: \(name)")
    }
} catch {
    fputs("FAIL: \(error)\n", stderr)
    exit(1)
}
