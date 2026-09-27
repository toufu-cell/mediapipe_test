import SwiftUI

struct WatchRecorderView: View {
    @EnvironmentObject private var controller: WatchConnectivityController

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(controller.isRecording ? "Recording" : controller.isLive ? "Live monitor" : "Waiting")
                .font(.headline)
                .foregroundStyle(controller.isRecording ? .red : .primary)

            Text(controller.sessionId ?? "No session")
                .font(.caption2.monospaced())
                .lineLimit(2)

            Text(controller.status)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(3)

            Button(controller.isLive ? "Stop live" : "Start live") {
                if controller.isLive {
                    controller.stopLive()
                } else {
                    controller.startLive()
                }
            }
            .buttonStyle(.bordered)
            .disabled(!controller.isLive && !controller.canStartLive)
        }
        .padding()
    }
}
