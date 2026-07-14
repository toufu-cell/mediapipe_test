import AVFoundation
import Combine
import Foundation

@MainActor
final class RecordingCoordinator: ObservableObject {
    private static let commandTokenKey = "capture.commandToken"

    private let recorder = CameraRecorder()
    private let watchBridge = WatchSessionBridge()
    private var pendingStartTask: Task<Void, Never>?
    private lazy var commandServer = CaptureCommandServer(
        port: 8765,
        token: commandToken
    ) { [weak self] command in
        Task { @MainActor in
            self?.handle(command)
        }
    }

    init() {
        let savedToken = UserDefaults.standard.string(forKey: Self.commandTokenKey)
        commandToken = savedToken ?? UUID().uuidString.replacingOccurrences(of: "-", with: "")
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
    @Published var commandToken: String {
        didSet {
            UserDefaults.standard.set(commandToken, forKey: Self.commandTokenKey)
            commandServer.updateToken(commandToken)
        }
    }

    var recordingStateLabel: String {
        isRecording ? "Recording" : "Waiting"
    }

    func prepare() async {
        bindState()
        cameraStatus = "Preparing camera"
        do {
            try await recorder.configure()
            recorder.startPreview()
            watchBridge.activate()
            startCommandServer()
        } catch {
            errorMessage = "Camera setup failed: \(error.localizedDescription)"
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
        handle(.stop(StopCaptureCommand(sessionId: currentSessionId ?? "manual", stopAt: Date())))
    }

    func regenerateCommandToken() {
        commandToken = UUID().uuidString.replacingOccurrences(of: "-", with: "")
    }

    private func bindState() {
        recorder.onStateChange = { [weak self] isRecording, fileURL in
            Task { @MainActor in
                self?.isRecording = isRecording
                self?.lastRecordedFilename = fileURL?.lastPathComponent
            }
        }
        recorder.onError = { [weak self] message in
            Task { @MainActor in
                self?.errorMessage = message
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

    private func handle(_ command: CaptureCommand) {
        switch command {
        case let .start(start):
            cancelPendingStart()
            currentSessionId = start.sessionId
            photoLibraryStatus = "Not saved"
            watchBridge.sendStart(start)
            pendingStartTask = Task { [weak self] in
                await self?.startRecordingWhenScheduled(start)
            }
        case let .stop(stop):
            cancelPendingStart()
            watchBridge.sendStop(stop)
            recorder.stopRecording()
        }
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
            try recorder.startRecording(sessionId: command.sessionId)
            pendingStartTask = nil
        } catch {
            errorMessage = "Recording start failed: \(error.localizedDescription)"
            pendingStartTask = nil
        }
    }
}
