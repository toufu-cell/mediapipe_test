import Foundation

public enum CaptureCommand: Equatable, Sendable {
    case start(StartCaptureCommand)
    case stop(StopCaptureCommand)
}

public struct StartCaptureCommand: Codable, Equatable, Sendable {
    public let sessionId: String
    public let startAt: Date
    public let expectedDurationSec: Int
    public let syncGesture: String
    public let video: CaptureVideoTarget
    public let watch: CaptureWatchTarget

    public init(
        sessionId: String,
        startAt: Date,
        expectedDurationSec: Int,
        syncGesture: String,
        video: CaptureVideoTarget,
        watch: CaptureWatchTarget
    ) {
        self.sessionId = sessionId
        self.startAt = startAt
        self.expectedDurationSec = expectedDurationSec
        self.syncGesture = syncGesture
        self.video = video
        self.watch = watch
    }

    public func scheduledDelay(now: Date = Date()) -> TimeInterval {
        max(0, startAt.timeIntervalSince(now))
    }
}

public struct StopCaptureCommand: Codable, Equatable, Sendable {
    public let sessionId: String
    public let stopAt: Date

    public init(sessionId: String, stopAt: Date) {
        self.sessionId = sessionId
        self.stopAt = stopAt
    }
}

public struct CaptureVideoTarget: Codable, Equatable, Sendable {
    public let device: String
    public let filename: String

    public init(device: String, filename: String) {
        self.device = device
        self.filename = filename
    }
}

public struct CaptureWatchTarget: Codable, Equatable, Sendable {
    public let device: String
    public let sampleRateHz: Int
    public let filename: String

    public init(device: String, sampleRateHz: Int, filename: String) {
        self.device = device
        self.sampleRateHz = sampleRateHz
        self.filename = filename
    }
}

public enum CaptureCommandDecodeError: Error, Equatable {
    case emptyLine
    case unknownType(String)
}

public enum AuthenticatedCaptureCommandDecodeError: Error, Equatable {
    case invalidEnvelope
    case unauthorized
}

private struct CommandEnvelope: Decodable {
    let type: String
}

private struct StartCommandWire: Decodable {
    let type: String
    let sessionId: String
    let startAt: Date
    let expectedDurationSec: Int
    let syncGesture: String
    let video: CaptureVideoTarget
    let watch: CaptureWatchTarget
}

private struct StopCommandWire: Decodable {
    let type: String
    let sessionId: String
    let stopAt: Date
}

public enum CaptureCommandLineDecoder {
    public static func decodeCommandLine(_ line: String) throws -> CaptureCommand {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw CaptureCommandDecodeError.emptyLine
        }

        let data = Data(trimmed.utf8)
        let decoder = makeDecoder()
        let envelope = try decoder.decode(CommandEnvelope.self, from: data)

        switch envelope.type {
        case "start":
            let wire = try decoder.decode(StartCommandWire.self, from: data)
            return .start(StartCaptureCommand(
                sessionId: wire.sessionId,
                startAt: wire.startAt,
                expectedDurationSec: wire.expectedDurationSec,
                syncGesture: wire.syncGesture,
                video: wire.video,
                watch: wire.watch
            ))
        case "stop":
            let wire = try decoder.decode(StopCommandWire.self, from: data)
            return .stop(StopCaptureCommand(sessionId: wire.sessionId, stopAt: wire.stopAt))
        default:
            throw CaptureCommandDecodeError.unknownType(envelope.type)
        }
    }

    public static func makeDecoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let value = try container.decode(String.self)
            if let date = makeISO8601Formatter(withFractionalSeconds: true).date(from: value) {
                return date
            }
            if let date = makeISO8601Formatter(withFractionalSeconds: false).date(from: value) {
                return date
            }
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Invalid ISO 8601 date: \(value)"
            )
        }
        return decoder
    }
}

public enum AuthenticatedCaptureCommandLineDecoder {
    public static func decodeCommandLine(
        _ line: String,
        expectedToken: String
    ) throws -> CaptureCommand {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let data = trimmed.data(using: .utf8),
              let envelope = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let token = envelope["token"] as? String,
              let commandObject = envelope["command"],
              JSONSerialization.isValidJSONObject(commandObject) else {
            throw AuthenticatedCaptureCommandDecodeError.invalidEnvelope
        }

        guard expectedToken.utf8.count >= 16,
              tokensMatch(token, expectedToken) else {
            throw AuthenticatedCaptureCommandDecodeError.unauthorized
        }

        let commandData = try JSONSerialization.data(withJSONObject: commandObject)
        let commandLine = String(decoding: commandData, as: UTF8.self)
        return try CaptureCommandLineDecoder.decodeCommandLine(commandLine)
    }

    private static func tokensMatch(_ candidate: String, _ expected: String) -> Bool {
        let candidateBytes = Array(candidate.utf8)
        let expectedBytes = Array(expected.utf8)
        guard candidateBytes.count == expectedBytes.count else {
            return false
        }

        var difference: UInt8 = 0
        for (candidateByte, expectedByte) in zip(candidateBytes, expectedBytes) {
            difference |= candidateByte ^ expectedByte
        }
        return difference == 0
    }
}

private func makeISO8601Formatter(withFractionalSeconds: Bool) -> ISO8601DateFormatter {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = withFractionalSeconds
        ? [.withInternetDateTime, .withFractionalSeconds]
        : [.withInternetDateTime]
    return formatter
}
