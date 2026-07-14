import SwiftUI

@main
struct WatchRecorderApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var controller = WatchConnectivityController()

    var body: some Scene {
        WindowGroup {
            WatchRecorderView()
                .environmentObject(controller)
                .onChange(of: scenePhase) { _, newPhase in
                    controller.updateSceneActive(newPhase == .active)
                }
        }
    }
}
