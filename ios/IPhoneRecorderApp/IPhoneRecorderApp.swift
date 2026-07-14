import SwiftUI

@main
struct IPhoneRecorderApp: App {
    @StateObject private var coordinator = RecordingCoordinator()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(coordinator)
                .task {
                    await coordinator.prepare()
                }
        }
    }
}
