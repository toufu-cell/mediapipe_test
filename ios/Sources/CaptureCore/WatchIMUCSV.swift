import Foundation

public struct WatchIMUSample: Equatable, Sendable {
    public let sessionId: String
    public let timestamp: Date
    public let startedAt: Date
    public let accelX: Double
    public let accelY: Double
    public let accelZ: Double
    public let gyroX: Double
    public let gyroY: Double
    public let gyroZ: Double

    public init(
        sessionId: String,
        timestamp: Date,
        startedAt: Date,
        accelX: Double,
        accelY: Double,
        accelZ: Double,
        gyroX: Double,
        gyroY: Double,
        gyroZ: Double
    ) {
        self.sessionId = sessionId
        self.timestamp = timestamp
        self.startedAt = startedAt
        self.accelX = accelX
        self.accelY = accelY
        self.accelZ = accelZ
        self.gyroX = gyroX
        self.gyroY = gyroY
        self.gyroZ = gyroZ
    }

    public var timestampMs: Int64 {
        Int64((timestamp.timeIntervalSince1970 * 1_000).rounded())
    }

    public var elapsedMs: Int64 {
        Int64((timestamp.timeIntervalSince(startedAt) * 1_000).rounded())
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
        WatchIMURecordingTiming(delay: 0, startedAt: watchNow)
    }
}

public struct WatchCommandDeliveryState: Equatable, Sendable {
    private var stoppedSessionIds: Set<String> = []
    private var stoppedSessionOrder: [String] = []
    private let stoppedSessionHistoryLimit: Int

    public init(stoppedSessionHistoryLimit: Int = 32) {
        self.stoppedSessionHistoryLimit = stoppedSessionHistoryLimit
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
    public static let header = "session_id,timestamp_ms,elapsed_ms,accel_x,accel_y,accel_z,gyro_x,gyro_y,gyro_z,accel_norm,gyro_norm"

    public static func makeCSV(samples: [WatchIMUSample]) -> String {
        ([header] + samples.map(makeRow)).joined(separator: "\n") + "\n"
    }

    private static func makeRow(_ sample: WatchIMUSample) -> String {
        [
            sample.sessionId,
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
        ].joined(separator: ",")
    }

    private static func format(_ value: Double) -> String {
        String(format: "%.6f", locale: Locale(identifier: "en_US_POSIX"), value)
    }
}
