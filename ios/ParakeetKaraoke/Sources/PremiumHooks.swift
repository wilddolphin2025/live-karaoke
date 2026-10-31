import SwiftUI
import SwiftData

/// Extension points for optional add-on features. The public app ships with `NoPremium`, a no-op
/// implementation, and builds and runs fully without any add-on. A private build may provide
/// another implementation (compiled in with the `PREMIUM` flag, see BUILD.md).
@MainActor
protocol PremiumFeatures {
    /// Extra SwiftData models the add-on stores.
    var modelTypes: [any PersistentModel.Type] { get }
    /// Lyrics provider: a control shown above the player controls. It may report replacement
    /// lyric lines (timed words); nil means "show the transcript".
    func lyricsControl(bundle: KaraokeBundle, karaoke: Bool, onLines: @escaping ([[Word]]?) -> Void) -> AnyView
    /// Recorder entry point, shown in the player while the karaoke track is playing.
    func recordButton(bundle: KaraokeBundle, player: PlayerModel, isRecording: Binding<Bool>) -> AnyView
    /// Hint shown while recording.
    func recordingHint() -> AnyView
    /// Extra rows/sections for Settings.
    func settingsRows() -> AnyView
    /// A recordings list (nil = none). `bundleId` nil lists everything.
    func recordingsView(bundleId: UUID?) -> AnyView?
    /// Test-data hook for UI tests.
    func prepareForUITests(_ ctx: ModelContext, songId: UUID?)
}

extension PremiumFeatures {
    var modelTypes: [any PersistentModel.Type] { [] }
    func lyricsControl(bundle: KaraokeBundle, karaoke: Bool, onLines: @escaping ([[Word]]?) -> Void) -> AnyView { AnyView(EmptyView()) }
    func recordButton(bundle: KaraokeBundle, player: PlayerModel, isRecording: Binding<Bool>) -> AnyView { AnyView(EmptyView()) }
    func recordingHint() -> AnyView { AnyView(EmptyView()) }
    func settingsRows() -> AnyView { AnyView(EmptyView()) }
    func recordingsView(bundleId: UUID?) -> AnyView? { nil }
    func prepareForUITests(_ ctx: ModelContext, songId: UUID?) {}
}

/// Default: no add-on features.
struct NoPremium: PremiumFeatures {}

enum PremiumHost {
    @MainActor static let features: any PremiumFeatures = {
        #if PREMIUM
        return PremiumBridge()
        #else
        return NoPremium()
        #endif
    }()
}
