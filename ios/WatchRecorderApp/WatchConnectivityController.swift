import Foundation
import WatchConnectivity
import WatchKit

private struct PendingStart {
    let sessionId: String
    let startAt: Date
    let sampleRateHz: Int
}

@MainActor
final class WatchConnectivityController: NSObject, ObservableObject {
    @Published private(set) var status = "Activating"
    @Published private(set) var sessionId: String?
    @Published private(set) var isRecording = false

    private let recorder = WatchIMURecorder()
    private var pendingStartTask: Task<Void, Never>?
    private var pendingStartSessionId: String?
    private var pendingStart: PendingStart?
    private var shouldRetryRuntimeStartWhenActive = false
    private var isSceneActive = true
    private var outputFilename = "watch_imu.csv"
    private var currentStartAt: Date?
    private var currentSampleRateHz = 50
    private var deliveryState = WatchCommandDeliveryState()
    private var runtimeSession: WKExtendedRuntimeSession?

    override init() {
        super.init()
        activateSession()
    }

    private func activateSession() {
        guard WCSession.isSupported() else {
            status = "WatchConnectivity unsupported"
            return
        }

        let session = WCSession.default
        session.delegate = self
        session.activate()
    }

    private func handle(_ payload: WatchCommandPayload) {
        switch payload {
        case let .start(sessionId, startAt, sampleRateHz, filename):
            handleStart(sessionId: sessionId, startAt: startAt, sampleRateHz: sampleRateHz, filename: filename)
        case let .stop(sessionId):
            handleStop(sessionId: sessionId)
        }
    }

    private func handleStart(sessionId: String, startAt: Date, sampleRateHz: Int, filename: String?) {
        guard !deliveryState.hasStopped(sessionId) else {
            status = "Ignored stopped start"
            return
        }

        guard !deliveryState.isCurrentOrPending(
            sessionId: sessionId,
            currentSessionId: self.sessionId,
            pendingStartSessionId: pendingStartSessionId
        ) else {
            status = "Ignored duplicate start"
            return
        }

        pendingStartTask?.cancel()
        pendingStartTask = nil
        pendingStartSessionId = sessionId
        pendingStart = PendingStart(sessionId: sessionId, startAt: startAt, sampleRateHz: sampleRateHz)
        shouldRetryRuntimeStartWhenActive = false
        recorder.stop()
        isRecording = false
        self.sessionId = sessionId
        outputFilename = filename ?? "\(sessionId)_wrist_imu.csv"
        currentStartAt = startAt
        currentSampleRateHz = sampleRateHz

        startExtendedRuntimeSession()
        status = "Runtime starting"
    }

    private func startRecording(sessionId: String, sampleRateHz: Int, startedAt: Date) {
        guard runtimeSession?.state == .running else {
            pendingStartTask = nil
            pendingStartSessionId = nil
            pendingStart = nil
            isRecording = false
            status = "Start failed: runtime not running"
            invalidateExtendedRuntimeSession()
            return
        }

        do {
            try recorder.start(sessionId: sessionId, sampleRateHz: sampleRateHz, startedAt: startedAt)
            currentStartAt = startedAt
            isRecording = true
            status = "Recording"
            pendingStartTask = nil
            pendingStartSessionId = nil
            pendingStart = nil
        } catch {
            isRecording = false
            status = "Start failed: \(error.localizedDescription)"
            pendingStartTask = nil
            pendingStartSessionId = nil
            pendingStart = nil
        }
    }

    private func handleStop(sessionId stopSessionId: String) {
        let matchesCurrentOrPending = stopSessionId == sessionId
            || stopSessionId == pendingStart?.sessionId
            || stopSessionId == pendingStartSessionId

        markStoppedSession(stopSessionId)

        guard stopSessionId == sessionId || stopSessionId == pendingStart?.sessionId || stopSessionId == pendingStartSessionId else {
            status = matchesCurrentOrPending ? "Ignored stale stop" : "Marked stopped session"
            return
        }

        guard isRecording || pendingStart != nil || pendingStartTask != nil else {
            status = "Ignored duplicate stop"
            return
        }

        finishCapture(sessionId: stopSessionId, statusPrefix: "Transferred", invalidateRuntime: true)
    }

    private func finishCapture(sessionId finishedSessionId: String, statusPrefix: String, invalidateRuntime: Bool) {
        markStoppedSession(finishedSessionId)
        pendingStartTask?.cancel()
        pendingStartTask = nil
        pendingStartSessionId = nil
        pendingStart = nil
        shouldRetryRuntimeStartWhenActive = false
        recorder.stop()
        isRecording = false

        do {
            let fileURL = try writeCSVFile()
            WCSession.default.transferFile(fileURL, metadata: [
                "sessionId": sessionId ?? "",
                "filename": fileURL.lastPathComponent,
                "sampleRateHz": currentSampleRateHz,
                "startAt": currentStartAt.map { ISO8601DateFormatter().string(from: $0) } ?? "",
            ])
            status = "\(statusPrefix) \(fileURL.lastPathComponent)"
        } catch {
            status = "\(statusPrefix) failed: \(error.localizedDescription)"
        }

        sessionId = finishedSessionId

        if invalidateRuntime {
            invalidateExtendedRuntimeSession()
        }
    }

    private func startExtendedRuntimeSession() {
        if let runtimeSession, runtimeSession.state != .invalid {
            return
        }

        guard isSceneActive else {
            shouldRetryRuntimeStartWhenActive = true
            status = "Open Watch Recorder to start"
            return
        }

        let session = WKExtendedRuntimeSession()
        session.delegate = self
        runtimeSession = session
        session.start()
    }

    private func invalidateExtendedRuntimeSession() {
        guard let session = runtimeSession else {
            return
        }

        runtimeSession = nil
        if session.state != .invalid {
            session.invalidate()
        }
    }

    private func cancelPendingStartAfterRuntimeInvalidation(_ message: String) {
        pendingStartTask?.cancel()
        pendingStartTask = nil
        pendingStartSessionId = nil
        pendingStart = nil
        shouldRetryRuntimeStartWhenActive = false
        isRecording = false
        status = "\(message); start canceled"
    }

    func updateSceneActive(_ active: Bool) {
        isSceneActive = active
        guard active, pendingStart != nil, shouldRetryRuntimeStartWhenActive else {
            return
        }

        shouldRetryRuntimeStartWhenActive = false
        status = "Runtime retrying"
        startExtendedRuntimeSession()
    }

    private func schedulePendingStartIfReady(for sessionId: String) {
        guard
            let pendingStart,
            pendingStart.sessionId == sessionId,
            self.sessionId == sessionId,
            runtimeSession?.state == .running
        else {
            return
        }

        pendingStartTask?.cancel()
        let timing = WatchIMUTimebase.localDeviceTiming(commandStartAt: pendingStart.startAt)
        status = timing.delay > 0 ? "Scheduled" : "Starting"
        pendingStartTask = Task { [weak self] in
            if timing.delay > 0 {
                do {
                    try await Task.sleep(nanoseconds: UInt64(timing.delay * 1_000_000_000))
                } catch {
                    return
                }
            }

            guard !Task.isCancelled else {
                return
            }

            self?.startRecording(
                sessionId: pendingStart.sessionId,
                sampleRateHz: pendingStart.sampleRateHz,
                startedAt: timing.startedAt
            )
        }
    }

    private func markStoppedSession(_ sessionId: String) {
        deliveryState.markStopped(sessionId)
    }

    private func writeCSVFile() throws -> URL {
        let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let safeFilename = outputFilename.replacingOccurrences(of: "/", with: "_")
        let fileURL = directory.appendingPathComponent(safeFilename)
        try recorder.makeCSVData().write(to: fileURL, options: .atomic)
        return fileURL
    }
}

extension WatchConnectivityController: WKExtendedRuntimeSessionDelegate {
    nonisolated func extendedRuntimeSessionDidStart(_ extendedRuntimeSession: WKExtendedRuntimeSession) {
        let sessionIdentifier = ObjectIdentifier(extendedRuntimeSession)
        Task { @MainActor in
            guard runtimeSession.map(ObjectIdentifier.init) == sessionIdentifier else {
                return
            }

            if let pendingStart {
                schedulePendingStartIfReady(for: pendingStart.sessionId)
            } else {
                status = isRecording ? "Recording; runtime active" : "Runtime active"
            }
        }
    }

    nonisolated func extendedRuntimeSessionWillExpire(_ extendedRuntimeSession: WKExtendedRuntimeSession) {
        let sessionIdentifier = ObjectIdentifier(extendedRuntimeSession)
        Task { @MainActor in
            guard runtimeSession.map(ObjectIdentifier.init) == sessionIdentifier else {
                return
            }

            status = "Runtime will expire"
        }
    }

    nonisolated func extendedRuntimeSession(
        _ extendedRuntimeSession: WKExtendedRuntimeSession,
        didInvalidateWith reason: WKExtendedRuntimeSessionInvalidationReason,
        error: Error?
    ) {
        let sessionIdentifier = ObjectIdentifier(extendedRuntimeSession)
        Task { @MainActor in
            guard runtimeSession.map(ObjectIdentifier.init) == sessionIdentifier else {
                return
            }

            runtimeSession = nil
            let message = runtimeInvalidationMessage(reason: reason, error: error)

            if isRecording, let sessionId {
                finishCapture(sessionId: sessionId, statusPrefix: message, invalidateRuntime: false)
            } else if pendingStart != nil || pendingStartTask != nil {
                pendingStartTask?.cancel()
                pendingStartTask = nil
                if shouldRetryRuntimeStart(reason: reason, error: error) {
                    if isSceneActive {
                        shouldRetryRuntimeStartWhenActive = false
                        status = "Runtime retrying"
                        startExtendedRuntimeSession()
                    } else {
                        shouldRetryRuntimeStartWhenActive = true
                        status = "Open Watch Recorder to start"
                    }
                } else {
                    cancelPendingStartAfterRuntimeInvalidation(message)
                }
            } else {
                status = message
            }
        }
    }
}

extension WatchConnectivityController: WCSessionDelegate {
    nonisolated func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {
        Task { @MainActor in
            if let error {
                status = "Activation failed: \(error.localizedDescription)"
            } else {
                status = "Activated"
            }
        }
    }

    nonisolated func session(
        _ session: WCSession,
        didReceiveMessage message: [String: Any]
    ) {
        guard let payload = WatchCommandPayload(message: message) else {
            return
        }

        Task { @MainActor in
            handle(payload)
        }
    }

    nonisolated func session(
        _ session: WCSession,
        didReceiveMessage message: [String: Any],
        replyHandler: @escaping ([String: Any]) -> Void
    ) {
        guard let payload = WatchCommandPayload(message: message) else {
            replyHandler(["ok": false, "error": "invalid command"])
            return
        }

        replyHandler(["ok": true, "status": "accepted"])
        Task { @MainActor in
            handle(payload)
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        guard let payload = WatchCommandPayload(message: userInfo) else {
            return
        }

        Task { @MainActor in
            handle(payload)
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        guard let payload = WatchCommandPayload(message: applicationContext) else {
            return
        }

        Task { @MainActor in
            handle(payload)
        }
    }
}

private func runtimeInvalidationMessage(reason: WKExtendedRuntimeSessionInvalidationReason, error: Error?) -> String {
    if let error {
        return "Runtime ended: \(error.localizedDescription)"
    }

    switch reason {
    case .none:
        return "Runtime ended"
    case .sessionInProgress:
        return "Runtime session already running"
    case .expired:
        return "Runtime expired"
    case .resignedFrontmost:
        return "Runtime ended: app not frontmost"
    case .suppressedBySystem:
        return "Runtime suppressed by system"
    case .error:
        return "Runtime ended with error"
    @unknown default:
        return "Runtime ended: unknown reason"
    }
}

private func shouldRetryRuntimeStart(reason: WKExtendedRuntimeSessionInvalidationReason, error: Error?) -> Bool {
    guard reason == .error, let nsError = error as NSError? else {
        return false
    }

    return nsError.domain == WKExtendedRuntimeSessionErrorDomain
        && nsError.code == WKExtendedRuntimeSessionErrorCode.mustBeActiveToStartOrSchedule.rawValue
}

private enum WatchCommandPayload: Sendable {
    case start(sessionId: String, startAt: Date, sampleRateHz: Int, filename: String?)
    case stop(sessionId: String)

    init?(message: [String: Any]) {
        guard let type = message["type"] as? String else {
            return nil
        }

        switch type {
        case "start":
            guard
                let sessionId = message["sessionId"] as? String,
                let startAtText = message["startAt"] as? String,
                let startAt = parseWatchDate(startAtText)
            else {
                return nil
            }

            self = .start(
                sessionId: sessionId,
                startAt: startAt,
                sampleRateHz: (message["sampleRateHz"] as? Int) ?? 50,
                filename: message["filename"] as? String
            )
        case "stop":
            guard let sessionId = message["sessionId"] as? String else {
                return nil
            }
            self = .stop(sessionId: sessionId)
        default:
            return nil
        }
    }
}

private func parseWatchDate(_ value: String) -> Date? {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = fractional.date(from: value) {
        return date
    }

    let plain = ISO8601DateFormatter()
    plain.formatOptions = [.withInternetDateTime]
    return plain.date(from: value)
}
