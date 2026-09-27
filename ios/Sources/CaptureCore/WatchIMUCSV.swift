import Foundation

public enum CaptureWristSide: String, Codable, Equatable, Sendable {
    case left
    case right
}

public struct WatchIMUSample: Equatable, Sendable {
    public let sessionId: String
    public let timestamp: Date
    public let startedAt: Date
    public let coreMotionTimestamp: TimeInterval
    public let coreMotionStartedAt: TimeInterval
    public let accelX: Double
    public let accelY: Double
    public let accelZ: Double
    public let gyroX: Double
    public let gyroY: Double
    public let gyroZ: Double
    public let gravityX: Double
    public let gravityY: Double
    public let gravityZ: Double
    public let quaternionX: Double
    public let quaternionY: Double
    public let quaternionZ: Double
    public let quaternionW: Double

    public init(
        sessionId: String,
        timestamp: Date,
        startedAt: Date,
        coreMotionTimestamp: TimeInterval,
        coreMotionStartedAt: TimeInterval,
        accelX: Double,
        accelY: Double,
        accelZ: Double,
        gyroX: Double,
        gyroY: Double,
        gyroZ: Double,
        gravityX: Double,
        gravityY: Double,
        gravityZ: Double,
        quaternionX: Double,
        quaternionY: Double,
        quaternionZ: Double,
        quaternionW: Double
    ) {
        self.sessionId = sessionId
        self.timestamp = timestamp
        self.startedAt = startedAt
        self.coreMotionTimestamp = coreMotionTimestamp
        self.coreMotionStartedAt = coreMotionStartedAt
        self.accelX = accelX
        self.accelY = accelY
        self.accelZ = accelZ
        self.gyroX = gyroX
        self.gyroY = gyroY
        self.gyroZ = gyroZ
        self.gravityX = gravityX
        self.gravityY = gravityY
        self.gravityZ = gravityZ
        self.quaternionX = quaternionX
        self.quaternionY = quaternionY
        self.quaternionZ = quaternionZ
        self.quaternionW = quaternionW
    }

    public var timestampMs: Int64 {
        Int64((timestamp.timeIntervalSince1970 * 1_000).rounded())
    }

    public var elapsedMs: Int64 {
        Int64((timestamp.timeIntervalSince(startedAt) * 1_000).rounded())
    }

    public var coreMotionElapsedMs: Int64 {
        Int64(((coreMotionTimestamp - coreMotionStartedAt) * 1_000).rounded())
    }

    public var accelNorm: Double {
        sqrt(accelX * accelX + accelY * accelY + accelZ * accelZ)
    }

    public var gyroNorm: Double {
        sqrt(gyroX * gyroX + gyroY * gyroY + gyroZ * gyroZ)
    }
}

public struct WatchIMURecordingTiming: Equatable, Sendable {
    public let delay: TimeInterval
    public let startedAt: Date

    public init(delay: TimeInterval, startedAt: Date) {
        self.delay = delay
        self.startedAt = startedAt
    }
}

public enum WatchIMUTimebase {
    public static func localDeviceTiming(commandStartAt: Date, watchNow: Date = Date()) -> WatchIMURecordingTiming {
        let delay = max(0, commandStartAt.timeIntervalSince(watchNow))
        return WatchIMURecordingTiming(
            delay: delay,
            startedAt: delay > 0 ? commandStartAt : watchNow
        )
    }
}

public enum WatchIMUExportDecision {
    public static func shouldExport(
        hadRecording: Bool,
        pendingExportSessionId: String?,
        finishedSessionId: String
    ) -> Bool {
        hadRecording || pendingExportSessionId == finishedSessionId
    }
}

public struct WatchCommandDeliveryState: Equatable, Sendable {
    private var stoppedSessionIds: Set<String> = []
    private var stoppedSessionOrder: [String] = []
    private let stoppedSessionHistoryLimit: Int

    public init(
        stoppedSessionHistoryLimit: Int = .max,
        stoppedSessionIds: [String] = []
    ) {
        self.stoppedSessionHistoryLimit = stoppedSessionHistoryLimit
        for sessionId in stoppedSessionIds {
            markStopped(sessionId)
        }
    }

    public var stoppedSessionHistory: [String] {
        stoppedSessionOrder
    }

    public func hasStopped(_ sessionId: String) -> Bool {
        stoppedSessionIds.contains(sessionId)
    }

    public func isCurrentOrPending(
        sessionId: String,
        currentSessionId: String?,
        pendingStartSessionId: String?
    ) -> Bool {
        sessionId == currentSessionId || sessionId == pendingStartSessionId
    }

    public func canAcceptStart(
        sessionId: String,
        currentSessionId: String?,
        pendingStartSessionId: String?
    ) -> Bool {
        !hasStopped(sessionId)
            && !isCurrentOrPending(
                sessionId: sessionId,
                currentSessionId: currentSessionId,
                pendingStartSessionId: pendingStartSessionId
            )
    }

    public mutating func markStopped(_ sessionId: String) {
        guard stoppedSessionIds.insert(sessionId).inserted else {
            return
        }

        stoppedSessionOrder.append(sessionId)
        while stoppedSessionOrder.count > stoppedSessionHistoryLimit {
            let removedSessionId = stoppedSessionOrder.removeFirst()
            stoppedSessionIds.remove(removedSessionId)
        }
    }
}

public enum WatchIMUCSVWriter {
    public static let header = "session_id,wrist_side,timestamp_ms,elapsed_ms,accel_x,accel_y,accel_z,gyro_x,gyro_y,gyro_z,accel_norm,gyro_norm,core_motion_timestamp_s,core_motion_elapsed_ms,gravity_x,gravity_y,gravity_z,quaternion_x,quaternion_y,quaternion_z,quaternion_w"

    public static func makeCSV(
        samples: [WatchIMUSample],
        wristSide: CaptureWristSide? = nil
    ) -> String {
        ([header] + samples.map { makeRow($0, wristSide: wristSide) }).joined(separator: "\n") + "\n"
    }

    private static func makeRow(_ sample: WatchIMUSample, wristSide: CaptureWristSide?) -> String {
        [
            sample.sessionId,
            wristSide?.rawValue ?? "unknown",
            String(sample.timestampMs),
            String(sample.elapsedMs),
            format(sample.accelX),
            format(sample.accelY),
            format(sample.accelZ),
            format(sample.gyroX),
            format(sample.gyroY),
            format(sample.gyroZ),
            format(sample.accelNorm),
            format(sample.gyroNorm),
            format(sample.coreMotionTimestamp),
            String(sample.coreMotionElapsedMs),
            format(sample.gravityX),
            format(sample.gravityY),
            format(sample.gravityZ),
            format(sample.quaternionX),
            format(sample.quaternionY),
            format(sample.quaternionZ),
            format(sample.quaternionW),
        ].joined(separator: ",")
    }

    private static func format(_ value: Double) -> String {
        String(format: "%.6f", locale: Locale(identifier: "en_US_POSIX"), value)
    }
}
