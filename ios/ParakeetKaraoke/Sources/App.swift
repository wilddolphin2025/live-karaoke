import SwiftUI
import SwiftData
import AVFoundation

@main
struct ParakeetKaraokeApp: App {
    @AppStorage("appearance") private var appearance = Appearance.system.rawValue
    let container: ModelContainer

    init() {
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
        try? AVAudioSession.sharedInstance().setActive(true)
        let types: [any PersistentModel.Type] = [KaraokeBundle.self] + PremiumHost.features.modelTypes
        container = try! ModelContainer(for: Schema(types))
        if ProcessInfo.processInfo.environment["UITEST_SEED"] == "1" {
            let id = UITestSeed.seed(container.mainContext)
            PremiumHost.features.prepareForUITests(container.mainContext, songId: id)
        }
    }
    var body: some Scene {
        WindowGroup {
            LibraryView()
                .preferredColorScheme((Appearance(rawValue: appearance) ?? .system).colorScheme)
        }
        .modelContainer(container)
    }
}

/// UI-test data (`UITEST_SEED=1`): one ready song with a silent original and karaoke track and
/// a deliberately imperfect transcript.
@MainActor
enum UITestSeed {
    static let id = UUID(uuidString: "00000000-0000-0000-0000-00000000C0DE")!

    static func seed(_ ctx: ModelContext) -> UUID {
        if let old = try? ctx.fetch(FetchDescriptor<KaraokeBundle>(predicate: #Predicate { $0.id == id })) { old.forEach(ctx.delete) }
        let b = KaraokeBundle(title: "Test Artist - Test Song", originalFile: "original.caf", isVideo: false, language: "en")
        b.id = id
        b.karaokeFile = "karaoke.caf"
        b.duration = 30
        b.status = .ready
        b.statusText = "Ready"
        let text = "Hello dark nest, my old friend. I've come to talk with you again."
        b.originalWords = text.split(separator: " ").enumerated().map { i, t in
            let s = 1.0 + Double(i) * 0.5 + (i >= 6 ? 0.5 : 0)
            return Word(word: t.lowercased().trimmingCharacters(in: .punctuationCharacters), start: s, end: s + 0.4, punctuated_word: String(t))
        }
        b.vocalsWords = b.originalWords
        for f in [b.originalFile, "karaoke.caf"] { writeSilence(b.dir.appendingPathComponent(f), seconds: 30) }
        ctx.insert(b)
        try? ctx.save()
        return id
    }

    private static func writeSilence(_ url: URL, seconds: Double) {
        guard !FileManager.default.fileExists(atPath: url.path),
              let fmt = AVAudioFormat(standardFormatWithSampleRate: 44_100, channels: 2),
              let file = try? AVAudioFile(forWriting: url, settings: fmt.settings),
              let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: AVAudioFrameCount(44_100 * seconds)) else { return }
        buf.frameLength = buf.frameCapacity
        try? file.write(from: buf)
    }
}
