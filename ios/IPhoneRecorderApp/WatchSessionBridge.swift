import Foundation
import WatchConnectivity

private enum WatchSessionBridgeError: LocalizedError {
    case notActivated
    case rejected(String)
    case unsupported

    var errorDescription: String? {
        switch self {
        case .notActivated:
            "Watch session is not activated"
        case let .rejected(message):
            "Watch rejected command: \(message)"
        case .unsupported:
            "WatchConnectivity is unsupported"
        }
    }
}

final class WatchSessionBridge: NSObject, WCSessionDelegate, @unchecked Sendable {
    var onStatusChange: ((String) -> Void)?
    let liveBuffer = WatchLiveBuffer()

    private var session: WCSession? {
        WCSession.isSupported() ? WCSession.default : nil
    }

    func activate() {
        guard let session else {
            onStatusChange?("WatchConnectivity unsupported")
            return
        }

        session.delegate = self
        session.activate()
        publishStatus()
    }

    func sendStart(_ command: StartCaptureCommand) async throws {
        let message: [String: Any] = [
            "type": "start",
            "sessionId": command.sessionId,
            "startAt": CaptureCommandDateCodec.encode(command.startAt),
            "expectedDurationSec": command.expectedDurationSec,
            "syncGesture": command.syncGesture,
            "sampleRateHz": command.watch.sampleRateHz,
            "filename": command.watch.filename,
            "wristSide": command.watch.wristSide ?? "unknown",
        ]
        try await sendCommand(message)
    }

    func sendStop(_ command: StopCaptureCommand) async throws {
        let message: [String: Any] = [
            "type": "stop",
            "sessionId": command.sessionId,
            "stopAt": CaptureCommandDateCodec.encode(command.stopAt),
        ]
        try await sendCommand(message)
    }

    private func sendCommand(_ message: [String: Any]) async throws {
        guard let session else {
            throw WatchSessionBridgeError.unsupported
        }
        guard session.activationState == .activated else {
            throw WatchSessionBridgeError.notActivated
        }

        if session.isReachable {
            do {
                try await sendAndAwaitSemanticAcceptance(message, on: session)
                enqueueBestEffort(message, on: session)
                onStatusChange?("Watch accepted command")
                return
            } catch let error as WatchSessionBridgeError {
                if case .rejected = error {
                    throw error
                }
            } catch {
                // A reachability race falls through to the durable queue below.
            }
        }

        try enqueueDurably(message, on: session)
        onStatusChange?("Watch command queued")
    }

    private func sendAndAwaitSemanticAcceptance(
        _ message: [String: Any],
        on session: WCSession
    ) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            session.sendMessage(message, replyHandler: { reply in
                if reply["ok"] as? Bool == true {
                    continuation.resume()
                } else {
                    let message = (reply["error"] as? String) ?? "unknown reason"
                    continuation.resume(throwing: WatchSessionBridgeError.rejected(message))
                }
            }, errorHandler: { error in
                continuation.resume(throwing: error)
            })
        }
    }

    private func enqueueDurably(_ message: [String: Any], on session: WCSession) throws {
        do {
            try session.updateApplicationContext(message)
        } catch {
            throw error
        }
        session.transferUserInfo(message)
    }

    private func enqueueBestEffort(_ message: [String: Any], on session: WCSession) {
        try? session.updateApplicationContext(message)
        session.transferUserInfo(message)
    }

    private func publishStatus() {
        guard let session else {
            onStatusChange?("WatchConnectivity unsupported")
            return
        }

        let activation: String
        switch session.activationState {
        case .activated:
            activation = "activated"
        case .inactive:
            activation = "inactive"
        case .notActivated:
            activation = "not activated"
        @unknown default:
            activation = "unknown"
        }

        let reachable = session.isReachable ? "reachable" : "not reachable"
        onStatusChange?("\(activation), \(reachable)")
    }

    func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {
        if let error {
            onStatusChange?("Watch activation failed: \(error.localizedDescription)")
        } else {
            publishStatus()
        }
    }

    func sessionReachabilityDidChange(_ session: WCSession) {
        publishStatus()
    }

    func sessionDidBecomeInactive(_ session: WCSession) {
        publishStatus()
    }

    func sessionDidDeactivate(_ session: WCSession) {
        session.activate()
        publishStatus()
    }

    func session(_ session: WCSession, didReceive file: WCSessionFile) {
        do {
            let savedURL = try saveTransferredFile(file)
            onStatusChange?("Received \(savedURL.lastPathComponent)")
        } catch {
            onStatusChange?("Watch file save failed: \(error.localizedDescription)")
        }
    }

    func session(
        _ session: WCSession,
        didReceiveMessageData messageData: Data,
        replyHandler: @escaping (Data) -> Void
    ) {
        let accepted = liveBuffer.receive(messageData)
        replyHandler(Data([accepted ? 1 : 0]))
    }

    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        if liveBuffer.receiveApplicationContext(applicationContext) {
            onStatusChange?("Watch live received in background")
        }
    }

    private func saveTransferredFile(_ file: WCSessionFile) throws -> URL {
        let filename = (file.metadata?["filename"] as? String) ?? file.fileURL.lastPathComponent
        let safeFilename = filename.replacingOccurrences(of: "/", with: "_")
        let documentsURL = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let destinationURL = documentsURL.appendingPathComponent(safeFilename)

        if FileManager.default.fileExists(atPath: destinationURL.path) {
            throw CocoaError(.fileWriteFileExists)
        }

        try FileManager.default.moveItem(at: file.fileURL, to: destinationURL)
        return destinationURL
    }
}
