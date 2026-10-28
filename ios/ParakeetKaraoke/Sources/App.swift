import SwiftUI
import SwiftData
import AVFoundation

@main
struct ParakeetKaraokeApp: App {
    init() {
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
        try? AVAudioSession.sharedInstance().setActive(true)
    }
    var body: some Scene {
        WindowGroup { LibraryView() }
            .modelContainer(for: KaraokeBundle.self)
    }
}
