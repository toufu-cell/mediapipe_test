import AVFoundation
import Combine
import Foundation

enum IPhoneRecorderRole: String, CaseIterable, Identifiable {
    case cameraAndWatch
    case watchRelay

    var id: String { rawValue }

    var label: String {
        switch self {
        case .cameraAndWatch:
            "Camera + Watch"
        case .watchRelay:
            "Watch relay only"
        }
    }
}

private enum RecordingCoordinatorError: LocalizedError {
    case anotherSessionActive(String)
    case cameraNotReady(String)
    case commandInProgress(String)
    case conflictingDuplicateStart(String)
    case invalidWristSide(String)
    case roleMismatch
    case stoppedSession(String)

    var errorDescription: String? {
        switch self {
        case let .anotherSessionActive(sessionId):
            "Another session is already active: \(sessionId)"
        case let .cameraNotReady(sessionId):
            "Camera is not ready for session \(sessionId)"
        case let .commandInProgress(sessionId):
            "Start acceptance is still in progress: \(sessionId)"
        case let .conflictingDuplicateStart(sessionId):
            "Conflicting Start command for active session \(sessionId)"
        case let .invalidWristSide(wristSide):
            "Invalid wrist side: \(wristSide)"
        case .roleMismatch:
            "Command does not match this iPhone recorder role"
        case let .stoppedSession(sessionId):
            "Session has already stopped: \(sessionId)"
        }
    }
}

@MainActor
final class RecordingCoordinator: ObservableObject {
    private static let pairingCodeAlphabet = Array("23456789ABCDEFGHJKLMNPQRSTUVWXYZ")
    private static let pairingCodeLength = 8
    private static let commandTokenKey = "capture.commandToken"
    private static let recorderRoleKey = "capture.recorderRole"
    private static let activeSessionIdKey = "capture.activeSessionId"
    private static let stoppedSessionIdsKey = "capture.stoppedSessionIds"

    private let recorder = CameraRecorder()
    private let watchBridge = WatchSessionBridge()
    private var pendingStartTask: Task<Void, Never>?
    private var activeStart: StartCaptureCommand?
    private var activeSessionId: String?
    private var isStartAcceptancePending = false
    private var isCameraReady = false
    private var stoppedSessionIds: [String]
    private lazy var commandServer = CaptureCommandServer(
        port: 8765,
        token: commandToken,
        liveSnapshot: { [watchBridge] in watchBridge.liveBuffer.snapshot() }
    ) { [weak self] command, completion in
        Task { @MainActor in
            guard let self else {
                completion("Recording coordinator is unavailable")
                return
            }
            do {
                try await self.handle(command)
                completion(nil)
            } catch {
                self.errorMessage = error.localizedDescription
                completion(error.localizedDescription)
            }
        }
    }

    init() {
        let savedToken = UserDefaults.standard.string(forKey: Self.commandTokenKey)
        commandToken = savedToken ?? Self.makePairingCode()
        recorderRole = UserDefaults.standard.string(forKey: Self.recorderRoleKey)
            .flatMap(IPhoneRecorderRole.init(rawValue:)) ?? .cameraAndWatch
        activeSessionId = UserDefaults.standard.string(forKey: Self.activeSessionIdKey)
        stoppedSessionIds = UserDefaults.standard.stringArray(forKey: Self.stoppedSessionIdsKey) ?? []
        currentSessionId = activeSessionId
    }

    var cameraSession: AVCaptureSession {
        recorder.session
    }

    @Published private(set) var commandServerStatus = "Stopped"
    @Published private(set) var cameraStatus = "Not configured"
    @Published private(set) var watchStatus = "Not activated"
    @Published private(set) var currentSessionId: String?
    @Published private(set) var lastRecordedFilename: String?
    @Published private(set) var photoLibraryStatus = "Not saved"
    @Published private(set) var errorMessage: String?
    @Published private(set) var isRecording = false
    @Published private(set) var recorderRole: IPhoneRecorderRole
    @Published var commandToken: String {
        didSet {
            UserDefaults.standard.set(commandToken, forKey: Self.commandTokenKey)
            commandServer.updateToken(commandToken)
        }
    }

    var recordingStateLabel: String {
        isRecording ? "Recording" : "Waiting"
    }

    var isCameraRole: Bool {
        recorderRole == .cameraAndWatch
    }

    func prepare() async {
        bindState()
        watchBridge.activate()
        startCommandServer()
        if isCameraRole {
            await configureCamera()
        } else {
            cameraStatus = "Disabled for Watch relay"
        }
    }

    func startCommandServer() {
        do {
            try commandServer.start()
            commandServerStatus = "Listening on TCP :\(commandServer.port)"
        } catch {
            commandServerStatus = "Failed"
            errorMessage = "Command server failed: \(error.localizedDescription)"
        }
    }

    func stopRecordingFromUI() {
        cancelPendingStart()
        Task { @MainActor in
            do {
                try await handle(.stop(StopCaptureCommand(
                    sessionId: currentSessionId ?? "manual",
                    stopAt: Date()
                )))
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    func setRecorderRole(_ role: IPhoneRecorderRole) async {
        guard activeSessionId == nil else {
            errorMessage = "Stop the active session before changing role"
            return
        }
        recorderRole = role
        UserDefaults.standard.set(role.rawValue, forKey: Self.recorderRoleKey)
        if role == .cameraAndWatch {
            await configureCamera()
        } else {
            isCameraReady = false
            recorder.stopPreview()
            cameraStatus = "Disabled for Watch relay"
        }
    }

    func regenerateCommandToken() {
        commandToken = Self.makePairingCode()
    }

    private static func makePairingCode() -> String {
        var generator = SystemRandomNumberGenerator()
        return String((0..<pairingCodeLength).map { _ in
            pairingCodeAlphabet.randomElement(using: &generator)!
        })
    }

    private func bindState() {
        recorder.onStateChange = { [weak self] isRecording, fileURL in
            Task { @MainActor in
                self?.isRecording = isRecording
                self?.lastRecordedFilename = fileURL?.lastPathComponent
                if !isRecording,
                   let sessionId = self?.activeSessionId,
                   self?.activeStart?.video.isEnabled == true,
                   self?.pendingStartTask == nil {
                    await self?.abortActiveSession(
                        sessionId: sessionId,
                        reason: "Camera recording ended unexpectedly"
                    )
                }
            }
        }
        recorder.onError = { [weak self] message in
            Task { @MainActor in
                self?.errorMessage = message
                if let sessionId = self?.activeSessionId {
                    await self?.abortActiveSession(sessionId: sessionId, reason: message)
                }
            }
        }
        recorder.onCameraStatusChange = { [weak self] status in
            Task { @MainActor in
                self?.cameraStatus = status
            }
        }
        recorder.onPhotoLibraryStatusChange = { [weak self] status in
            Task { @MainActor in
                self?.photoLibraryStatus = status
            }
        }
        watchBridge.onStatusChange = { [weak self] status in
            Task { @MainActor in
                self?.watchStatus = status
            }
        }
    }

    private func handle(_ command: CaptureCommand) async throws {
        switch command {
        case .watchLive:
            // Read-only snapshots are handled by CaptureCommandServer after authentication.
            return
        case let .start(start):
            if stoppedSessionIds.contains(start.sessionId) {
                throw RecordingCoordinatorError.stoppedSession(start.sessionId)
            }
            if let activeSessionId {
                if let activeStart, activeStart == start {
                    if isStartAcceptancePending {
                        throw RecordingCoordinatorError.commandInProgress(start.sessionId)
                    }
                    watchStatus = "Ignored duplicate start"
                    return
                }
                if activeSessionId == start.sessionId {
                    throw RecordingCoordinatorError.conflictingDuplicateStart(start.sessionId)
                }
                throw RecordingCoordinatorError.anotherSessionActive(activeSessionId)
            }
            let expectedRole: IPhoneRecorderRole = start.video.isEnabled
                ? .cameraAndWatch
                : .watchRelay
            guard recorderRole == expectedRole else {
                throw RecordingCoordinatorError.roleMismatch
            }
            if start.video.isEnabled, !isCameraReady {
                throw RecordingCoordinatorError.cameraNotReady(start.sessionId)
            }
            if let wristSide = start.watch.wristSide,
               wristSide != "left",
               wristSide != "right" {
                throw RecordingCoordinatorError.invalidWristSide(wristSide)
            }
            if start.video.isEnabled {
                try recorder.validateOutputAvailable(sessionId: start.sessionId)
            }
            cancelPendingStart()
            activeStart = start
            activeSessionId = start.sessionId
            isStartAcceptancePending = true
            UserDefaults.standard.set(start.sessionId, forKey: Self.activeSessionIdKey)
            currentSessionId = start.sessionId
            photoLibraryStatus = "Not saved"
            do {
                try await watchBridge.sendStart(start)
            } catch {
                await abortActiveSession(
                    sessionId: start.sessionId,
                    reason: "Watch Start failed: \(error.localizedDescription)"
                )
                throw error
            }
            guard activeSessionId == start.sessionId,
                  !stoppedSessionIds.contains(start.sessionId) else {
                throw RecordingCoordinatorError.stoppedSession(start.sessionId)
            }
            isStartAcceptancePending = false
            if start.video.isEnabled {
                pendingStartTask = Task { [weak self] in
                    await self?.startRecordingWhenScheduled(start)
                }
            } else {
                cameraStatus = "Disabled for Watch relay"
            }
        case let .stop(stop):
            markStoppedSession(stop.sessionId)
            if stop.sessionId == activeSessionId {
                cancelPendingStart()
                clearActiveSession()
                recorder.stopRecording()
            } else {
                watchStatus = "Ignored stale stop for camera"
            }
            try await watchBridge.sendStop(stop)
        }
    }

    private func configureCamera() async {
        cameraStatus = "Preparing camera"
        do {
            try await recorder.configure()
            guard recorderRole == .cameraAndWatch else {
                return
            }
            isCameraReady = true
            recorder.startPreview()
        } catch {
            isCameraReady = false
            cameraStatus = "Camera unavailable"
            errorMessage = "Camera setup failed: \(error.localizedDescription)"
        }
    }

    private func clearActiveSession() {
        activeStart = nil
        activeSessionId = nil
        isStartAcceptancePending = false
        UserDefaults.standard.removeObject(forKey: Self.activeSessionIdKey)
    }

    private func abortActiveSession(sessionId: String, reason: String) async {
        guard activeSessionId == sessionId else {
            return
        }
        cancelPendingStart()
        clearActiveSession()
        markStoppedSession(sessionId)
        recorder.stopRecording()
        let stop = StopCaptureCommand(sessionId: sessionId, stopAt: Date())
        try? await watchBridge.sendStop(stop)
        errorMessage = reason
    }

    private func markStoppedSession(_ sessionId: String) {
        guard !stoppedSessionIds.contains(sessionId) else {
            return
        }
        stoppedSessionIds.append(sessionId)
        UserDefaults.standard.set(stoppedSessionIds, forKey: Self.stoppedSessionIdsKey)
    }

    private func cancelPendingStart() {
        pendingStartTask?.cancel()
        pendingStartTask = nil
    }

    private func startRecordingWhenScheduled(_ command: StartCaptureCommand) async {
        let delay = command.scheduledDelay(now: Date())
        if delay > 0 {
            do {
                try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            } catch {
                return
            }
        }

        guard !Task.isCancelled else {
            return
        }

        do {
            try await recorder.startRecording(sessionId: command.sessionId)
            pendingStartTask = nil
        } catch {
            pendingStartTask = nil
            await abortActiveSession(
                sessionId: command.sessionId,
                reason: "Recording start failed: \(error.localizedDescription)"
            )
        }
    }
}
