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
    private static let stoppedSessionIdsKey = "capture.stoppedSessionIds"

    @Published private(set) var status = "Activating"
    @Published private(set) var sessionId: String?
    @Published private(set) var isRecording = false
    @Published private(set) var isLive = false

    private let recorder = WatchIMURecorder()
    private var pendingStartTask: Task<Void, Never>?
    private var pendingStartSessionId: String?
    private var pendingStart: PendingStart?
    private var shouldRetryRuntimeStartWhenActive = false
    private var isSceneActive = true
    private var outputFilename = "watch_imu.csv"
    private var currentStartAt: Date?
    private var currentSampleRateHz = 50
    private var currentWristSide: CaptureWristSide?
    private var pendingExportSessionId: String?
    private var deliveryState: WatchCommandDeliveryState
    private var runtimeSession: WKExtendedRuntimeSession?
    private var liveStreamId: String?
    private var liveSequence = 0
    private var liveSendSequence: Int?
    private var liveSendTimeout: Task<Void, Never>?
    private var liveSendTimedOut = false
    private var lastBackgroundSampleTime: TimeInterval?

    var canStartLive: Bool {
        !isRecording && pendingStart == nil && pendingStartTask == nil && pendingExportSessionId == nil
    }

    func startLive() {
        guard !isLive, canStartLive else { return }
        guard isSceneActive, WCSession.default.activationState == .activated else {
            status = "Open this app and wait for activation"
            return
        }
        liveStreamId = UUID().uuidString
        liveSequence = 0
        liveSendSequence = nil
        liveSendTimedOut = false
        lastBackgroundSampleTime = nil
        isLive = true
        status = "Live runtime starting"
        startExtendedRuntimeSession()
    }

    func stopLive(status message: String = "Live stopped", invalidateRuntime: Bool = true) {
        guard isLive else { return }
        isLive = false
        liveStreamId = nil
        liveSendSequence = nil
        liveSendTimedOut = false
        lastBackgroundSampleTime = nil
        liveSendTimeout?.cancel()
        liveSendTimeout = nil
        recorder.stop()
        recorder.discardSamples()
        let session = WCSession.default
        if session.activationState == .activated,
           session.applicationContext[WatchLiveSample.applicationContextKey] != nil {
            try? session.updateApplicationContext([:])
        }
        status = message
        if invalidateRuntime { invalidateExtendedRuntimeSession() }
    }

    private func startLiveSampling() {
        guard isLive, let liveStreamId, runtimeSession?.state == .running else { return }
        do {
            try recorder.start(
                sessionId: liveStreamId,
                sampleRateHz: 10,
                startedAt: Date(),
                retainSamples: false
            ) { [weak self] sample in
                Task { @MainActor [weak self] in self?.sendLiveSample(sample) }
            }
            status = "Live: waiting for iPhone"
        } catch {
            stopLive(status: "Live failed: \(error.localizedDescription)")
        }
    }

    private func sendLiveSample(_ sample: WatchIMUSample) {
        guard isLive, sample.sessionId == liveStreamId else { return }
        guard liveSequence < Int(Int32.max) else {
            stopLive(status: "Restart live monitor to reset sequence")
            return
        }
        liveSequence += 1
        guard Date().timeIntervalSince(sample.timestamp) < 1 else { return }
        let session = WCSession.default
        guard session.activationState == .activated else {
            status = "Live: Watch connection not activated"
            return
        }
        let useBackground = !session.isReachable || liveSendTimedOut
        if useBackground {
            if let lastBackgroundSampleTime, sample.coreMotionTimestamp - lastBackgroundSampleTime < 0.5 {
                return
            }
        } else if liveSendSequence != nil {
            return
        }
        let device = WKInterfaceDevice.current()
        let payload = WatchLiveSample(
            streamId: sample.sessionId, sequence: liveSequence,
            timestampMs: Double(sample.timestampMs), motionTimestampSec: sample.coreMotionTimestamp,
            wristSide: device.wristLocation == .right ? "right" : "left",
            crownOrientation: device.crownOrientation == .right ? "right" : "left",
            gravity: [sample.gravityX, sample.gravityY, sample.gravityZ],
            gyro: [sample.gyroX, sample.gyroY, sample.gyroZ],
            acceleration: [sample.accelX, sample.accelY, sample.accelZ],
            quaternion: [sample.quaternionX, sample.quaternionY, sample.quaternionZ, sample.quaternionW]
        )
        guard payload.isValid, let data = try? JSONEncoder().encode(payload) else {
            stopLive(status: "Live sample is invalid")
            return
        }
        if useBackground {
            lastBackgroundSampleTime = sample.coreMotionTimestamp
            do {
                // Only the latest value is retained; delivery timing is controlled by watchOS.
                try session.updateApplicationContext([WatchLiveSample.applicationContextKey: data])
                status = "Live: background queued #\(liveSequence)"
            } catch {
                status = "Live background failed: \(error.localizedDescription)"
            }
            return
        }
        let streamId = sample.sessionId
        let sequence = liveSequence
        liveSendSequence = sequence
        liveSendTimeout = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(3)) } catch { return }
            guard let self, liveStreamId == streamId, liveSendSequence == sequence else { return }
            // Keep the outstanding message tracked so stalled replies cannot build an unbounded queue.
            liveSendTimedOut = true
            status = "Live: reply delayed; using background updates"
        }
        session.sendMessageData(data, replyHandler: { @Sendable [weak self] reply in
            Task { @MainActor [weak self] in
                self?.finishLiveSend(streamId: streamId, sequence: sequence, error: reply == Data([1]) ? nil : "iPhone rejected sample")
            }
        }, errorHandler: { @Sendable [weak self] error in
            let message = error.localizedDescription
            Task { @MainActor [weak self] in
                self?.finishLiveSend(streamId: streamId, sequence: sequence, error: message)
            }
        })
    }

    private func finishLiveSend(streamId: String, sequence: Int, error: String?) {
        guard isLive, liveStreamId == streamId, liveSendSequence == sequence else { return }
        liveSendSequence = nil
        liveSendTimedOut = false
        liveSendTimeout?.cancel()
        liveSendTimeout = nil
        status = error.map { "Live send failed: \($0)" } ?? "Live sent #\(sequence)"
    }

    override init() {
        deliveryState = WatchCommandDeliveryState(
            stoppedSessionIds: UserDefaults.standard.stringArray(forKey: Self.stoppedSessionIdsKey) ?? []
        )
        super.init()
        recorder.onError = { [weak self] message in
            DispatchQueue.main.async { [weak self] in
                self?.handleRecorderError(message)
            }
        }
        activateSession()
    }

    private func handleRecorderError(_ message: String) {
        if isLive {
            stopLive(status: "Live failed: \(message)")
            return
        }
        guard isRecording else {
            return
        }
        recorder.stop()
        isRecording = false
        status = "Recording failed: \(message)"
        invalidateExtendedRuntimeSession()
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

    @discardableResult
    private func handle(_ payload: WatchCommandPayload) -> String? {
        switch payload {
        case let .start(sessionId, startAt, sampleRateHz, filename, wristSide):
            return handleStart(
                sessionId: sessionId,
                startAt: startAt,
                sampleRateHz: sampleRateHz,
                filename: filename,
                wristSide: wristSide
            )
        case let .stop(sessionId):
            return handleStop(sessionId: sessionId)
        }
    }

    private func handleStart(
        sessionId: String,
        startAt: Date,
        sampleRateHz: Int,
        filename: String?,
        wristSide: CaptureWristSide?
    ) -> String? {
        guard !isLive else { return "Stop Watch live monitor before starting a recording" }
        if let wristSide {
            let configuredWristSide: CaptureWristSide = (
                WKInterfaceDevice.current().wristLocation == .right ? .right : .left
            )
            guard wristSide == configuredWristSide else {
                status = "Start rejected: Watch wrist setting is \(configuredWristSide.rawValue)"
                return status
            }
        }

        guard !deliveryState.hasStopped(sessionId) else {
            status = "Ignored stopped start"
            return "Session has already stopped: \(sessionId)"
        }

        let activeSessionId: String? = if let pendingExportSessionId {
            pendingExportSessionId
        } else if isRecording || pendingStart != nil || pendingStartTask != nil {
            pendingStart?.sessionId ?? pendingStartSessionId ?? self.sessionId
        } else {
            nil
        }
        guard activeSessionId == nil || activeSessionId == sessionId else {
            status = "Rejected Start; session \(activeSessionId ?? "unknown") is active"
            return status
        }

        guard !deliveryState.isCurrentOrPending(
            sessionId: sessionId,
            currentSessionId: self.sessionId,
            pendingStartSessionId: pendingStartSessionId
        ) else {
            status = "Ignored duplicate start"
            return nil
        }

        do {
            try validateOutputAvailable(filename: filename ?? "\(sessionId)_wrist_imu.csv")
        } catch {
            status = "Start rejected: \(error.localizedDescription)"
            return status
        }

        pendingStartTask?.cancel()
        pendingStartTask = nil
        pendingStartSessionId = sessionId
        pendingStart = PendingStart(
            sessionId: sessionId,
            startAt: startAt,
            sampleRateHz: sampleRateHz
        )
        shouldRetryRuntimeStartWhenActive = false
        recorder.stop()
        recorder.discardSamples()
        isRecording = false
        self.sessionId = sessionId
        outputFilename = filename ?? "\(sessionId)_wrist_imu.csv"
        currentStartAt = startAt
        currentSampleRateHz = sampleRateHz
        currentWristSide = wristSide

        startExtendedRuntimeSession()
        status = "Runtime starting"
        return nil
    }

    private func startRecording(sessionId: String, sampleRateHz: Int, startedAt: Date) {
        guard runtimeSession?.state == .running else {
            pendingStartTask = nil
            pendingStartSessionId = nil
            pendingStart = nil
            self.sessionId = nil
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
            self.sessionId = nil
            invalidateExtendedRuntimeSession()
        }
    }

    private func handleStop(sessionId stopSessionId: String) -> String? {
        if pendingExportSessionId == stopSessionId {
            return finishCapture(
                sessionId: stopSessionId,
                statusPrefix: "Transfer retry",
                invalidateRuntime: true
            )
        }

        let matchesCurrentOrPending = stopSessionId == sessionId
            || stopSessionId == pendingStart?.sessionId
            || stopSessionId == pendingStartSessionId

        markStoppedSession(stopSessionId)

        guard matchesCurrentOrPending else {
            status = "Marked stopped session"
            return nil
        }

        guard isRecording || pendingStart != nil || pendingStartTask != nil else {
            status = "Ignored duplicate stop"
            return nil
        }

        return finishCapture(sessionId: stopSessionId, statusPrefix: "Transferred", invalidateRuntime: true)
    }

    @discardableResult
    private func finishCapture(
        sessionId finishedSessionId: String,
        statusPrefix: String,
        invalidateRuntime: Bool
    ) -> String? {
        markStoppedSession(finishedSessionId)
        let hadRecording = isRecording
        pendingStartTask?.cancel()
        pendingStartTask = nil
        pendingStartSessionId = nil
        pendingStart = nil
        shouldRetryRuntimeStartWhenActive = false
        recorder.stop()
        isRecording = false
        var resultError: String?

        if WatchIMUExportDecision.shouldExport(
            hadRecording: hadRecording,
            pendingExportSessionId: pendingExportSessionId,
            finishedSessionId: finishedSessionId
        ) {
            do {
                let fileURL = try writeCSVFile()
                WCSession.default.transferFile(fileURL, metadata: [
                    "sessionId": sessionId ?? "",
                    "filename": fileURL.lastPathComponent,
                    "sampleRateHz": currentSampleRateHz,
                    "startAt": currentStartAt.map { ISO8601DateFormatter().string(from: $0) } ?? "",
                    "wristSide": currentWristSide?.rawValue ?? "unknown",
                ])
                pendingExportSessionId = nil
                status = "\(statusPrefix) \(fileURL.lastPathComponent)"
            } catch {
                pendingExportSessionId = finishedSessionId
                status = "\(statusPrefix) failed: \(error.localizedDescription)"
                resultError = status
            }
        } else {
            recorder.discardSamples()
            status = "Canceled pending Start"
        }

        sessionId = finishedSessionId

        if invalidateRuntime {
            invalidateExtendedRuntimeSession()
        }
        return resultError
    }

    private func startExtendedRuntimeSession() {
        if let runtimeSession, runtimeSession.state == .running {
            if isLive {
                startLiveSampling()
                return
            }
            if let pendingStart {
                schedulePendingStartIfReady(for: pendingStart.sessionId)
            }
            return
        }
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
        sessionId = nil
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
        UserDefaults.standard.set(
            deliveryState.stoppedSessionHistory,
            forKey: Self.stoppedSessionIdsKey
        )
    }

    private func writeCSVFile() throws -> URL {
        let fileURL = outputURL(filename: outputFilename)
        guard !FileManager.default.fileExists(atPath: fileURL.path) else {
            throw CocoaError(.fileWriteFileExists)
        }
        try recorder.makeCSVData(wristSide: currentWristSide).write(to: fileURL, options: .withoutOverwriting)
        return fileURL
    }

    private func validateOutputAvailable(filename: String) throws {
        let fileURL = outputURL(filename: filename)
        guard !FileManager.default.fileExists(atPath: fileURL.path) else {
            throw CocoaError(.fileWriteFileExists)
        }
    }

    private func outputURL(filename: String) -> URL {
        let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let safeFilename = filename.replacingOccurrences(of: "/", with: "_")
        return directory.appendingPathComponent(safeFilename)
    }
}

extension WatchConnectivityController: WKExtendedRuntimeSessionDelegate {
    nonisolated func extendedRuntimeSessionDidStart(_ extendedRuntimeSession: WKExtendedRuntimeSession) {
        let sessionIdentifier = ObjectIdentifier(extendedRuntimeSession)
        Task { @MainActor in
            guard runtimeSession.map(ObjectIdentifier.init) == sessionIdentifier else {
                return
            }

            if isLive {
                startLiveSampling()
            } else if let pendingStart {
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

            if isLive {
                stopLive(status: message, invalidateRuntime: false)
            } else if isRecording, let sessionId {
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

        let reply = WatchReplyHandler(replyHandler)
        Task { @MainActor in
            if let errorMessage = handle(payload) {
                reply.send(["ok": false, "error": errorMessage])
            } else {
                reply.send(["ok": true, "status": "accepted"])
            }
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

private final class WatchReplyHandler: @unchecked Sendable {
    private let handler: ([String: Any]) -> Void

    init(_ handler: @escaping ([String: Any]) -> Void) {
        self.handler = handler
    }

    func send(_ payload: [String: Any]) {
        handler(payload)
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
    case start(
        sessionId: String,
        startAt: Date,
        sampleRateHz: Int,
        filename: String?,
        wristSide: CaptureWristSide?
    )
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
                filename: message["filename"] as? String,
                wristSide: (message["wristSide"] as? String).flatMap(CaptureWristSide.init(rawValue:))
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
