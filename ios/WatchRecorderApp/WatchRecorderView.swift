import SwiftUI

struct WatchRecorderView: View {
    @EnvironmentObject private var controller: WatchConnectivityController

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(controller.isRecording ? "Recording" : "Waiting")
                .font(.headline)
                .foregroundStyle(controller.isRecording ? .red : .primary)

            Text(controller.sessionId ?? "No session")
                .font(.caption2.monospaced())
                .lineLimit(2)

            Text(controller.status)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(3)
        }
        .padding()
    }
}
