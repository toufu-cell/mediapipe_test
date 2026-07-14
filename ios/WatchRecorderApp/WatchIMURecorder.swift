import CoreMotion
import Foundation

final class WatchIMURecorder {
    private let motionManager = CMMotionManager()
    private let queue = OperationQueue()
    private let lock = NSLock()
    private var samples: [WatchIMUSample] = []
    private var sessionId: String?
    private var startedAt: Date?

    var isRecording: Bool {
        motionManager.isDeviceMotionActive
    }

    init() {
        queue.name = "app.mediapipe.watch-imu-recorder"
        queue.qualityOfService = .userInitiated
        queue.maxConcurrentOperationCount = 1
    }

    func start(sessionId: String, sampleRateHz: Int, startedAt: Date) throws {
        guard motionManager.isDeviceMotionAvailable else {
            throw WatchIMURecorderError.deviceMotionUnavailable
        }

        stop()
        self.sessionId = sessionId
        self.startedAt = startedAt
        lock.withLock {
            samples = []
        }

        let safeSampleRate = max(1, sampleRateHz)
        motionManager.deviceMotionUpdateInterval = 1.0 / Double(safeSampleRate)
        motionManager.startDeviceMotionUpdates(to: queue) { [weak self] motion, _ in
            guard let self, let motion, let sessionId = self.sessionId, let startedAt = self.startedAt else {
                return
            }

            let timestamp = Date()
            let sample = WatchIMUSample(
                sessionId: sessionId,
                timestamp: timestamp,
                startedAt: startedAt,
                accelX: motion.userAcceleration.x,
                accelY: motion.userAcceleration.y,
                accelZ: motion.userAcceleration.z,
                gyroX: motion.rotationRate.x,
                gyroY: motion.rotationRate.y,
                gyroZ: motion.rotationRate.z
            )

            self.lock.withLock {
                self.samples.append(sample)
            }
        }
    }

    func stop() {
        if motionManager.isDeviceMotionActive {
            motionManager.stopDeviceMotionUpdates()
        }
    }

    func makeCSVData() -> Data {
        let snapshot = lock.withLock {
            samples
        }
        return Data(WatchIMUCSVWriter.makeCSV(samples: snapshot).utf8)
    }
}

enum WatchIMURecorderError: LocalizedError {
    case deviceMotionUnavailable

    var errorDescription: String? {
        switch self {
        case .deviceMotionUnavailable:
            return "Device motion is unavailable on this Apple Watch."
        }
    }
}
