import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var coordinator: RecordingCoordinator

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                if coordinator.isCameraRole {
                    CameraPreviewView(session: coordinator.cameraSession)
                        .frame(maxWidth: .infinity)
                        .aspectRatio(9 / 16, contentMode: .fit)
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
                } else {
                    ContentUnavailableView(
                        "Watch relay mode",
                        systemImage: "applewatch.radiowaves.left.and.right",
                        description: Text("Camera and microphone are disabled on this iPhone.")
                    )
                    .frame(maxWidth: .infinity)
                    .aspectRatio(3 / 4, contentMode: .fit)
                }

                VStack(alignment: .leading, spacing: 10) {
                    Picker(
                        "Recorder role",
                        selection: Binding(
                            get: { coordinator.recorderRole },
                            set: { role in
                                Task {
                                    await coordinator.setRecorderRole(role)
                                }
                            }
                        )
                    ) {
                        ForEach(IPhoneRecorderRole.allCases) { role in
                            Text(role.label).tag(role)
                        }
                    }
                    .pickerStyle(.menu)

                    statusRow("Camera", coordinator.cameraStatus)
                    statusRow("Command server", coordinator.commandServerStatus)
                    statusRow("Watch session", coordinator.watchStatus)
                    statusRow("Session ID", coordinator.currentSessionId ?? "Not started")
                    statusRow("Last file", coordinator.lastRecordedFilename ?? "None")
                    statusRow("Photos", coordinator.photoLibraryStatus)

                    VStack(alignment: .leading, spacing: 6) {
                        Text("Pairing code")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        TextField("8 characters", text: $coordinator.commandToken)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .textFieldStyle(.roundedBorder)
                        Button("Generate new code") {
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
            .frame(maxWidth: .infinity)
            .padding()
        }
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
