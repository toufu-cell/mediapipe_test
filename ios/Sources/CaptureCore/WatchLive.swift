import Foundation

public struct WatchLiveSample: Codable, Equatable, Sendable {
    public static let applicationContextKey = "watchLiveSample"

    public let streamId: String
    public let sequence: Int
    public let timestampMs: Double
    public let motionTimestampSec: Double
    public let wristSide: String
    public let crownOrientation: String
    public let gravity: [Double]
    public let gyro: [Double]
    public let acceleration: [Double]
    public let quaternion: [Double]
    public let sampleRateHz: Int
    public let referenceFrame: String

    public init(
        streamId: String, sequence: Int, timestampMs: Double, motionTimestampSec: Double,
        wristSide: String, crownOrientation: String, gravity: [Double], gyro: [Double],
        acceleration: [Double], quaternion: [Double]
    ) {
        self.streamId = streamId
        self.sequence = sequence
        self.timestampMs = timestampMs
        self.motionTimestampSec = motionTimestampSec
        self.wristSide = wristSide
        self.crownOrientation = crownOrientation
        self.gravity = gravity
        self.gyro = gyro
        self.acceleration = acceleration
        self.quaternion = quaternion
        self.sampleRateHz = 10
        self.referenceFrame = "xArbitraryZVertical"
    }

    public var isValid: Bool {
        let vectors = gravity + gyro + acceleration + quaternion
        let quaternionNorm = sqrt(quaternion.reduce(0) { $0 + $1 * $1 })
        let gravityNorm = sqrt(gravity.reduce(0) { $0 + $1 * $1 })
        return UUID(uuidString: streamId) != nil
            && sequence >= 0 && sequence <= Int(Int32.max)
            && timestampMs.isFinite && timestampMs > 0
            && motionTimestampSec.isFinite && motionTimestampSec >= 0
            && ["left", "right"].contains(wristSide)
            && ["left", "right"].contains(crownOrientation)
            && gravity.count == 3 && gyro.count == 3 && acceleration.count == 3 && quaternion.count == 4
            && vectors.allSatisfy { $0.isFinite && abs($0) < 10_000 }
            && (0.9...1.1).contains(gravityNorm) && (0.9...1.1).contains(quaternionNorm)
            && sampleRateHz == 10 && referenceFrame == "xArbitraryZVertical"
    }
}

public struct WatchLiveSnapshot: Codable, Sendable {
    public let sample: WatchLiveSample?
    public let receivedAtMs: Double?
    public let ageMs: Double?
}

/// A latest-value monitor, not a lossless recorder. Receipt age uses the iPhone monotonic clock.
public final class WatchLiveBuffer: @unchecked Sendable {
    private let lock = NSLock()
    private var sample: WatchLiveSample?
    private var receivedAtMs: Double?
    private var receivedUptime: TimeInterval?
    private var retiredStreams: [String] = []

    public init() {}

    @discardableResult
    public func receiveApplicationContext(
        _ context: [String: Any],
        now: Date = Date(),
        uptime: TimeInterval = ProcessInfo.processInfo.systemUptime
    ) -> Bool {
        guard let data = context[WatchLiveSample.applicationContextKey] as? Data else { return false }
        return receive(data, now: now, uptime: uptime)
    }

    @discardableResult
    public func receive(
        _ data: Data,
        now: Date = Date(),
        uptime: TimeInterval = ProcessInfo.processInfo.systemUptime
    ) -> Bool {
        guard data.count <= 8192,
              let incoming = try? JSONDecoder().decode(WatchLiveSample.self, from: data),
              incoming.isValid else { return false }
        return lock.withLock {
            if let current = sample {
                if current.streamId == incoming.streamId {
                    guard incoming.sequence > current.sequence,
                          incoming.motionTimestampSec > current.motionTimestampSec else { return false }
                } else {
                    guard !retiredStreams.contains(incoming.streamId) else { return false }
                    retiredStreams.append(current.streamId)
                    if retiredStreams.count > 16 { retiredStreams.removeFirst() }
                }
            }
            sample = incoming
            receivedAtMs = now.timeIntervalSince1970 * 1000
            receivedUptime = uptime
            return true
        }
    }

    public func snapshot(uptime: TimeInterval = ProcessInfo.processInfo.systemUptime) -> WatchLiveSnapshot {
        lock.withLock {
            WatchLiveSnapshot(
                sample: sample,
                receivedAtMs: receivedAtMs,
                ageMs: receivedUptime.map { max(0, uptime - $0) * 1000 }
            )
        }
    }
}
