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
        receive(on: connection, buffer: CaptureCommandLineBuffer())
    }

    private func receive(on connection: NWConnection, buffer: CaptureCommandLineBuffer) {
        let maximumLength = max(1, min(4096, buffer.remainingCapacity))
        connection.receive(minimumIncompleteLength: 1, maximumLength: maximumLength) { [weak self] data, _, isComplete, error in
            guard let self else {
                return
            }

            if let error {
                self.sendResponse(["ok": false, "error": error.localizedDescription], on: connection)
                return
            }

            var nextBuffer = buffer
            do {
                if let data, let line = try nextBuffer.append(data) {
                    if line.trimmingCharacters(in: .whitespaces).isEmpty {
                        self.sendResponse(["ok": false, "error": "Empty command"], on: connection)
                    } else {
                        self.handleLine(line, on: connection)
                    }
                    return
                }
            } catch {
                self.sendResponse(["ok": false, "error": "\(error)"], on: connection)
                return
            }

            if isComplete {
                self.sendResponse(
                    ["ok": false, "error": "Connection ended before newline-delimited command"],
                    on: connection
                )
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
        connection.send(content: lineData, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }
}
