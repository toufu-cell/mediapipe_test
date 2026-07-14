import Foundation
import Network

final class CaptureCommandServer: @unchecked Sendable {
    let port: UInt16

    private let handler: @Sendable (CaptureCommand) -> Void
    private var token: String
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "app.mediapipe.capture.command-server")

    // Connection callbacks are confined to queue; start/stop lifecycle is called serially by the coordinator.
    init(
        port: UInt16,
        token: String,
        handler: @escaping @Sendable (CaptureCommand) -> Void
    ) {
        self.port = port
        self.token = token
        self.handler = handler
    }

    func updateToken(_ token: String) {
        queue.async { [weak self] in
            self?.token = token
        }
    }

    func start() throws {
        if listener != nil {
            return
        }

        guard let nwPort = NWEndpoint.Port(rawValue: port) else {
            throw NWError.posix(.EINVAL)
        }

        let listener = try NWListener(using: .tcp, on: nwPort)
        listener.newConnectionHandler = { [weak self] connection in
            self?.handle(connection)
        }
        listener.start(queue: queue)
        self.listener = listener
    }

    func stop() {
        listener?.cancel()
        listener = nil
    }

    private func handle(_ connection: NWConnection) {
        connection.start(queue: queue)
        receive(on: connection, buffer: "")
    }

    private func receive(on connection: NWConnection, buffer: String) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, isComplete, error in
            guard let self else {
                return
            }

            if let error {
                self.sendResponse(["ok": false, "error": error.localizedDescription], on: connection)
                return
            }

            var nextBuffer = buffer
            if let data, let chunk = String(data: data, encoding: .utf8) {
                nextBuffer += chunk
                let lines = nextBuffer.split(separator: "\n", omittingEmptySubsequences: false)
                let hasTrailingNewline = nextBuffer.hasSuffix("\n")
                let completeLines = hasTrailingNewline ? lines : lines.dropLast()
                nextBuffer = hasTrailingNewline ? "" : String(lines.last ?? "")

                for line in completeLines {
                    let lineText = String(line)
                    if !lineText.trimmingCharacters(in: .whitespaces).isEmpty {
                        self.handleLine(lineText, on: connection)
                    }
                }
            }

            if isComplete {
                connection.cancel()
            } else {
                self.receive(on: connection, buffer: nextBuffer)
            }
        }
    }

    private func handleLine(_ line: String, on connection: NWConnection) {
        do {
            let command = try AuthenticatedCaptureCommandLineDecoder.decodeCommandLine(
                line,
                expectedToken: token
            )
            handler(command)
            sendResponse(["ok": true], on: connection)
        } catch {
            sendResponse(["ok": false, "error": "\(error)"], on: connection)
        }
    }

    private func sendResponse(_ payload: [String: Any], on connection: NWConnection) {
        guard JSONSerialization.isValidJSONObject(payload),
              let data = try? JSONSerialization.data(withJSONObject: payload) else {
            return
        }
        var lineData = data
        lineData.append(0x0A)
        connection.send(content: lineData, completion: .contentProcessed { _ in })
    }
}
