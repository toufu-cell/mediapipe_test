import Foundation
import WatchConnectivity

final class WatchSessionBridge: NSObject, WCSessionDelegate {
    var onStatusChange: ((String) -> Void)?

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

    func sendStart(_ command: StartCaptureCommand) {
        let message: [String: Any] = [
            "type": "start",
            "sessionId": command.sessionId,
            "startAt": ISO8601DateFormatter().string(from: command.startAt),
            "expectedDurationSec": command.expectedDurationSec,
            "syncGesture": command.syncGesture,
            "sampleRateHz": command.watch.sampleRateHz,
            "filename": command.watch.filename,
        ]
        sendCommand(message)
    }

    func sendStop(_ command: StopCaptureCommand) {
        let message: [String: Any] = [
            "type": "stop",
            "sessionId": command.sessionId,
            "stopAt": ISO8601DateFormatter().string(from: command.stopAt),
        ]
        sendCommand(message)
    }

    private func sendCommand(_ message: [String: Any]) {
        let immediateStatus = send(message)
        let queueStatus = enqueue(message)

        if let queueStatus {
            onStatusChange?("\(immediateStatus); \(queueStatus)")
        } else {
            onStatusChange?(immediateStatus)
        }
    }

    private func send(_ message: [String: Any]) -> String {
        guard let session else {
            return "WatchConnectivity unsupported"
        }

        guard session.activationState == .activated else {
            return "Watch session not activated"
        }

        guard session.isReachable else {
            return "Watch not reachable"
        }

        session.sendMessage(message, replyHandler: { [weak self] _ in
            self?.onStatusChange?("Watch message accepted")
        }, errorHandler: { [weak self] error in
            self?.onStatusChange?("Watch send failed: \(error.localizedDescription)")
        })
        return "Watch message sent"
    }

    private func enqueue(_ message: [String: Any]) -> String? {
        guard let session else {
            return nil
        }

        guard session.activationState == .activated else {
            return nil
        }

        do {
            try session.updateApplicationContext(message)
        } catch {
            session.transferUserInfo(message)
            return "Watch queued; context failed: \(error.localizedDescription)"
        }

        session.transferUserInfo(message)
        return "Watch queued"
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

    private func saveTransferredFile(_ file: WCSessionFile) throws -> URL {
        let filename = (file.metadata?["filename"] as? String) ?? file.fileURL.lastPathComponent
        let safeFilename = filename.replacingOccurrences(of: "/", with: "_")
        let documentsURL = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let destinationURL = documentsURL.appendingPathComponent(safeFilename)

        if FileManager.default.fileExists(atPath: destinationURL.path) {
            try FileManager.default.removeItem(at: destinationURL)
        }

        try FileManager.default.moveItem(at: file.fileURL, to: destinationURL)
        return destinationURL
    }
}
