import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var coordinator: RecordingCoordinator

    var body: some View {
        VStack(spacing: 16) {
            CameraPreviewView(session: coordinator.cameraSession)
                .frame(maxWidth: .infinity)
                .aspectRatio(3 / 4, contentMode: .fit)
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .overlay(alignment: .topLeading) {
                    Text(coordinator.recordingStateLabel)
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(coordinator.isRecording ? Color.red : Color.black.opacity(0.65))
                        .foregroundStyle(.white)
                        .clipShape(Capsule())
                        .padding(10)
                }

            VStack(alignment: .leading, spacing: 10) {
                statusRow("Camera", coordinator.cameraStatus)
                statusRow("Command server", coordinator.commandServerStatus)
                statusRow("Watch session", coordinator.watchStatus)
                statusRow("Session ID", coordinator.currentSessionId ?? "Not started")
                statusRow("Last file", coordinator.lastRecordedFilename ?? "None")
                statusRow("Photos", coordinator.photoLibraryStatus)

                VStack(alignment: .leading, spacing: 6) {
                    Text("Pairing token")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    TextField("16 characters or more", text: $coordinator.commandToken)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .textFieldStyle(.roundedBorder)
                    Button("Generate new token") {
                        coordinator.regenerateCommandToken()
                    }
                    .buttonStyle(.bordered)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding()
            .background(Color(.secondarySystemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 12))

            if let errorMessage = coordinator.errorMessage {
                Text(errorMessage)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            HStack {
                Button("Start server") {
                    coordinator.startCommandServer()
                }
                .buttonStyle(.borderedProminent)

                Button("Stop recording") {
                    coordinator.stopRecordingFromUI()
                }
                .buttonStyle(.bordered)
                .disabled(!coordinator.isRecording)
            }
        }
        .padding()
    }

    private func statusRow(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(width: 110, alignment: .leading)
            Text(value)
                .font(.callout.monospaced())
                .lineLimit(2)
        }
    }
}
