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
    try expect(start.video.isEnabled, "legacy video target should default to enabled")
    try expect(start.watch.sampleRateHz == 50, "watch sampleRateHz mismatch")
    try expect(start.watch.wristSide == nil, "legacy Watch target should not require wristSide")
}

func testDecodeDualWatchFields() throws {
    let line = """
    {"type":"start","sessionId":"capture_dual","startAt":"2026-05-24T20:30:03.000+09:00","expectedDurationSec":180,"syncGesture":"wrist_shake_3_times","video":{"device":"iphone","filename":"capture_dual_relay.mov","enabled":false},"watch":{"device":"apple_watch","sampleRateHz":50,"filename":"capture_dual_right_wrist_imu.csv","wristSide":"right"}}
    """
    let command = try CaptureCommandLineDecoder.decodeCommandLine(line)
    guard case let .start(start) = command else {
        throw SelfTestError.assertionFailed("Expected dual start command")
    }
    try expect(!start.video.isEnabled, "relay video should be disabled")
    try expect(start.watch.wristSide == "right", "right wristSide mismatch")
}

func testAuthenticatedCommandRequiresMatchingToken() throws {
    let command = """
    {"type":"stop","sessionId":"capture_test","stopAt":"2026-05-24T20:31:03.000+09:00"}
    """
    let envelope = """
    {"token":"ABCD2345","command":\(command)}
    """

    let decoded = try AuthenticatedCaptureCommandLineDecoder.decodeCommandLine(
        envelope,
        expectedToken: "ABCD2345"
    )
    guard case let .stop(stop) = decoded else {
        throw SelfTestError.assertionFailed("Expected stop command")
    }
    try expect(stop.sessionId == "capture_test", "authenticated sessionId mismatch")

    do {
        _ = try AuthenticatedCaptureCommandLineDecoder.decodeCommandLine(
            envelope,
            expectedToken: "WXYZ6789"
        )
        throw SelfTestError.assertionFailed("Mismatched token should be rejected")
    } catch AuthenticatedCaptureCommandDecodeError.unauthorized {
        // Expected.
    }
}

func testCommandLineBufferEnforcesRequestLimit() throws {
    var buffer = CaptureCommandLineBuffer(maxBytes: 8)
    let partial = try buffer.append(Data("1234".utf8))
    try expect(partial == nil, "partial command should wait")
    let line = try buffer.append(Data("567\n".utf8))
    try expect(line == "1234567", "framed command mismatch")

    var oversized = CaptureCommandLineBuffer(maxBytes: 8)
    do {
        _ = try oversized.append(Data("12345678".utf8))
        throw SelfTestError.assertionFailed("Command without newline at the byte limit should fail")
    } catch CaptureCommandLineBufferError.requestTooLarge {
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
            coreMotionTimestamp: 1_234.5,
            coreMotionStartedAt: 1_234.4,
            accelX: 0.01,
            accelY: 0.98,
            accelZ: 0.03,
            gyroX: 0.10,
            gyroY: 0.02,
            gyroZ: 0.01,
            gravityX: 0.0,
            gravityY: 0.0,
            gravityZ: -1.0,
            quaternionX: 0.0,
            quaternionY: 0.0,
            quaternionZ: 0.0,
            quaternionW: 1.0
        ),
    ]

    let csv = WatchIMUCSVWriter.makeCSV(samples: samples)
    let lines = csv.split(separator: "\n").map(String.init)

    try expect(lines.count == 2, "CSV should contain header and one sample")
    try expect(
        lines[0] == "session_id,wrist_side,timestamp_ms,elapsed_ms,accel_x,accel_y,accel_z,gyro_x,gyro_y,gyro_z,accel_norm,gyro_norm,core_motion_timestamp_s,core_motion_elapsed_ms,gravity_x,gravity_y,gravity_z,quaternion_x,quaternion_y,quaternion_z,quaternion_w",
        "CSV header mismatch"
    )
    try expect(
        lines[1] == "capture_20260524_203000,unknown,1000100,100,0.010000,0.980000,0.030000,0.100000,0.020000,0.010000,0.980510,0.102470,1234.500000,100,0.000000,0.000000,-1.000000,0.000000,0.000000,0.000000,1.000000",
        "CSV row mismatch: \(lines[1])"
    )
}

func testWatchLocalTimebaseWaitsForCommandStartAt() throws {
    let commandStartAt = Date(timeIntervalSince1970: 2_000)
    let watchNow = Date(timeIntervalSince1970: 1_000)

    let timing = WatchIMUTimebase.localDeviceTiming(commandStartAt: commandStartAt, watchNow: watchNow)

    try expect(timing.delay == 1_000, "Watch local timebase should wait for PC command startAt")
    try expect(timing.startedAt == commandStartAt, "Watch local timebase should use command startAt")
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

func testWatchCommandDeliveryStateRestoresStoppedSessions() throws {
    var deliveryState = WatchCommandDeliveryState()
    deliveryState.markStopped("capture_stopped_before_restart")

    let restoredState = WatchCommandDeliveryState(
        stoppedSessionIds: deliveryState.stoppedSessionHistory
    )

    try expect(
        restoredState.hasStopped("capture_stopped_before_restart"),
        "Stopped session should survive state restoration"
    )
}

func testWatchPendingStartCancellationDoesNotExport() throws {
    try expect(
        !WatchIMUExportDecision.shouldExport(
            hadRecording: false,
            pendingExportSessionId: nil,
            finishedSessionId: "capture_pending"
        ),
        "Canceling a pending Start must not export an old sample buffer"
    )
    try expect(
        WatchIMUExportDecision.shouldExport(
            hadRecording: false,
            pendingExportSessionId: "capture_retry",
            finishedSessionId: "capture_retry"
        ),
        "A failed export must remain retryable"
    )
}

func testCaptureCommandDateCodecPreservesMilliseconds() throws {
    let date = Date(timeIntervalSince1970: 1_000.987)
    let encoded = CaptureCommandDateCodec.encode(date)

    try expect(encoded.contains(".987"), "Relay timestamp must preserve milliseconds: \(encoded)")
}

func testWatchStoppedSessionHistoryDoesNotExpire() throws {
    var deliveryState = WatchCommandDeliveryState()
    for index in 0..<40 {
        deliveryState.markStopped("capture_\(index)")
    }

    let restoredState = WatchCommandDeliveryState(
        stoppedSessionIds: deliveryState.stoppedSessionHistory
    )
    try expect(
        restoredState.hasStopped("capture_0"),
        "The oldest Stop tombstone must survive more than 32 sessions"
    )
}

func testWatchLiveReadRequiresAuthentication() throws {
    let envelope = """
    {"token":"ABCD2345","command":{"type":"watch-live"}}
    """
    let command = try AuthenticatedCaptureCommandLineDecoder.decodeCommandLine(envelope, expectedToken: "ABCD2345")
    try expect(command == .watchLive, "Live snapshot must decode as a read-only command")
    do {
        _ = try AuthenticatedCaptureCommandLineDecoder.decodeCommandLine(envelope, expectedToken: "OTHER123")
        throw SelfTestError.assertionFailed("Live snapshot must require matching authentication")
    } catch AuthenticatedCaptureCommandDecodeError.unauthorized {}
}

func testWatchLiveBufferKeepsOnlyValidNewSamplesAndTheirAge() throws {
    let streamA = "00000000-0000-4000-8000-000000000001"
    let streamB = "00000000-0000-4000-8000-000000000002"
    func encode(_ streamId: String, _ sequence: Int, gravity: [Double] = [0, 0, -1]) throws -> Data {
        try JSONEncoder().encode(WatchLiveSample(
            streamId: streamId, sequence: sequence, timestampMs: 1_000_000,
            motionTimestampSec: Double(sequence), wristSide: "right", crownOrientation: "left",
            gravity: gravity, gyro: [1, 2, 3], acceleration: [0, 0, 0], quaternion: [0, 0, 0, 1]
        ))
    }
    let buffer = WatchLiveBuffer()
    try expect(buffer.snapshot(uptime: 10).sample == nil, "No synthetic sample before Watch data")
    let first = try encode(streamA, 1)
    try expect(buffer.receive(first, now: Date(timeIntervalSince1970: 1000), uptime: 10), "Valid wire sample should be accepted")
    try expect(!buffer.receive(first, uptime: 11), "Duplicate must not reset freshness")
    try expect(buffer.snapshot(uptime: 12).ageMs == 2000, "Receipt age must use monotonic elapsed time")
    try expect(buffer.snapshot(uptime: 12).sample?.gyro == [1, 2, 3], "Gyro values must survive the wire format")
    let older = try encode(streamA, 0)
    let malformed = try encode(streamA, 2, gravity: [0, 0])
    let zero = try encode(streamA, 2, gravity: [0, 0, 0])
    try expect(!buffer.receive(older), "Out-of-order sample must be rejected")
    try expect(!buffer.receive(malformed), "Incomplete sensor vector must be rejected")
    try expect(!buffer.receive(zero), "Zero gravity must not be shown as a valid pose")
    try expect(!buffer.receive(Data(repeating: 32, count: 8193)), "Oversized wire data must be rejected")
    try expect(buffer.snapshot(uptime: 12).sample?.sequence == 1, "Invalid values must not replace valid data")
    let restart = try encode(streamB, 0)
    try expect(buffer.receive(restart, now: Date(timeIntervalSince1970: 1005), uptime: 15), "A restarted stream may reset its sequence")
    let delayedOldStream = try encode(streamA, 99)
    try expect(!buffer.receive(delayedOldStream), "Retired stream must not replace the new stream")
    let wire = try JSONEncoder().encode(buffer.snapshot(uptime: 16))
    let decoded = try JSONDecoder().decode(WatchLiveSnapshot.self, from: wire)
    try expect(decoded.sample?.streamId == streamB && decoded.ageMs == 1000, "Snapshot must expose source identity and freshness")

    let background = try encode(streamB, 2)
    let context = [WatchLiveSample.applicationContextKey: background]
    try expect(buffer.receiveApplicationContext(context, now: Date(timeIntervalSince1970: 1007), uptime: 17), "Background context must reach the same validated live buffer")
    try expect(!buffer.receive(restart, uptime: 18), "An older immediate reply must not replace newer background data")
    try expect(!buffer.receiveApplicationContext(context, uptime: 18), "Duplicate background delivery must not refresh the sample age")
    try expect(!buffer.receiveApplicationContext([WatchLiveSample.applicationContextKey: malformed]), "Background transport must not bypass sensor validation")
    try expect(!buffer.receiveApplicationContext(["type": "start"]), "Other application contexts must not be treated as live data")
    try expect(buffer.snapshot(uptime: 19).sample?.sequence == 2 && buffer.snapshot(uptime: 19).ageMs == 2000, "Cross-transport duplicates and invalid data must preserve age and values")
}

let tests: [(String, () throws -> Void)] = [
    ("Watch live read requires authentication", testWatchLiveReadRequiresAuthentication),
    ("Watch live buffer preserves only valid fresh samples", testWatchLiveBufferKeepsOnlyValidNewSamplesAndTheirAge),
    ("decode start command from newline-delimited JSON", testDecodeStartCommandFromNewlineDelimitedJson),
    ("decode dual Watch command fields", testDecodeDualWatchFields),
    ("authenticated command requires matching token", testAuthenticatedCommandRequiresMatchingToken),
    ("command line buffer enforces request limit", testCommandLineBufferEnforcesRequestLimit),
    ("scheduled delay uses future startAt", testScheduledDelayUsesFutureStartAt),
    ("scheduled delay clamps past startAt to zero", testScheduledDelayClampsPastStartAtToZero),
    ("IMU CSV writer formats samples", testIMUCSVWriterFormatsSamples),
    ("Watch local timebase waits for command startAt", testWatchLocalTimebaseWaitsForCommandStartAt),
    ("Watch command delivery state rejects start after unknown stop", testWatchCommandDeliveryStateRejectsStartAfterUnknownStop),
    ("Watch command delivery state restores stopped sessions", testWatchCommandDeliveryStateRestoresStoppedSessions),
    ("Watch pending Start cancellation does not export", testWatchPendingStartCancellationDoesNotExport),
    ("Capture command date codec preserves milliseconds", testCaptureCommandDateCodecPreservesMilliseconds),
    ("Watch stopped session history does not expire", testWatchStoppedSessionHistoryDoesNotExpire),
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
