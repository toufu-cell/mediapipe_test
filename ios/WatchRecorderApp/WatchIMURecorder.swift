import CoreMotion
import Foundation

final class WatchIMURecorder {
    private struct ActiveSession {
        let id: String
        let startedAt: Date
        let generation: Int
        var coreMotionStartedAt: TimeInterval?
    }

    private let motionManager = CMMotionManager()
    private let queue = OperationQueue()
    private let lock = NSLock()
    private var samples: [WatchIMUSample] = []
    private var generation = 0
    private var activeSession: ActiveSession?
    var onError: ((String) -> Void)?

    var isRecording: Bool {
        motionManager.isDeviceMotionActive
    }

    init() {
        queue.name = "app.mediapipe.watch-imu-recorder"
        queue.qualityOfService = .userInitiated
        queue.maxConcurrentOperationCount = 1
    }

    func start(
        sessionId: String,
        sampleRateHz: Int,
        startedAt: Date,
        retainSamples: Bool = true,
        onSample: (@Sendable (WatchIMUSample) -> Void)? = nil
    ) throws {
        guard motionManager.isDeviceMotionAvailable else {
            throw WatchIMURecorderError.deviceMotionUnavailable
        }
        guard CMMotionManager.availableAttitudeReferenceFrames().contains(.xArbitraryZVertical) else {
            throw WatchIMURecorderError.referenceFrameUnavailable
        }

        stop()
        let activeGeneration = lock.withLock {
            generation += 1
            samples = []
            activeSession = ActiveSession(
                id: sessionId,
                startedAt: startedAt,
                generation: generation,
                coreMotionStartedAt: nil
            )
            return generation
        }

        let safeSampleRate = max(1, sampleRateHz)
        motionManager.deviceMotionUpdateInterval = 1.0 / Double(safeSampleRate)
        motionManager.startDeviceMotionUpdates(using: .xArbitraryZVertical, to: queue) { [weak self] motion, error in
            if let error {
                self?.report(error: error, generation: activeGeneration)
                return
            }
            guard let self, let motion else {
                return
            }

            let timestamp = Date()
            let sample: WatchIMUSample? = self.lock.withLock {
                guard
                    var activeSession = self.activeSession,
                    activeSession.generation == activeGeneration
                else {
                    return nil
                }
                let coreMotionStartedAt = activeSession.coreMotionStartedAt ?? motion.timestamp
                activeSession.coreMotionStartedAt = coreMotionStartedAt
                self.activeSession = activeSession
                let quaternion = motion.attitude.quaternion
                let sample = WatchIMUSample(
                    sessionId: activeSession.id,
                    timestamp: timestamp,
                    startedAt: activeSession.startedAt,
                    coreMotionTimestamp: motion.timestamp,
                    coreMotionStartedAt: coreMotionStartedAt,
                    accelX: motion.userAcceleration.x,
                    accelY: motion.userAcceleration.y,
                    accelZ: motion.userAcceleration.z,
                    gyroX: motion.rotationRate.x,
                    gyroY: motion.rotationRate.y,
                    gyroZ: motion.rotationRate.z,
                    gravityX: motion.gravity.x,
                    gravityY: motion.gravity.y,
                    gravityZ: motion.gravity.z,
                    quaternionX: quaternion.x,
                    quaternionY: quaternion.y,
                    quaternionZ: quaternion.z,
                    quaternionW: quaternion.w
                )
                if retainSamples { self.samples.append(sample) }
                return sample
            }
            if let sample { onSample?(sample) }
        }
    }

    private func report(error: Error, generation activeGeneration: Int) {
        let shouldReport = lock.withLock {
            activeSession?.generation == activeGeneration
        }
        if shouldReport {
            onError?(error.localizedDescription)
        }
    }

    func stop() {
        if motionManager.isDeviceMotionActive {
            motionManager.stopDeviceMotionUpdates()
        }
        lock.withLock {
            generation += 1
            activeSession = nil
        }
    }

    func discardSamples() {
        lock.withLock {
            samples = []
        }
    }

    func makeCSVData(wristSide: CaptureWristSide?) -> Data {
        let snapshot = lock.withLock {
            samples
        }
        return Data(WatchIMUCSVWriter.makeCSV(samples: snapshot, wristSide: wristSide).utf8)
    }
}

enum WatchIMURecorderError: LocalizedError {
    case deviceMotionUnavailable
    case referenceFrameUnavailable

    var errorDescription: String? {
        switch self {
        case .deviceMotionUnavailable:
            return "Device motion is unavailable on this Apple Watch."
        case .referenceFrameUnavailable:
            return "The xArbitraryZVertical reference frame is unavailable on this Apple Watch."
        }
    }
}
