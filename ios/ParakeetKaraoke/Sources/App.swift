import SwiftUI
import SwiftData
import AVFoundation

@main
struct ParakeetKaraokeApp: App {
    @AppStorage("appearance") private var appearance = Appearance.system.rawValue
    init() {
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
        try? AVAudioSession.sharedInstance().setActive(true)
    }
    var body: some Scene {
        WindowGroup {
            LibraryView()
                .preferredColorScheme((Appearance(rawValue: appearance) ?? .system).colorScheme)
        }
        .modelContainer(for: KaraokeBundle.self)
    }
}
