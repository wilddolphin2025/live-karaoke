#if PREMIUM
// Glue between the app and the private LiveKaraokePremium package (only in PREMIUM builds).
import SwiftUI
import SwiftData
import LiveKaraokePremium

struct PremiumBridge: PremiumFeatures {
    var modelTypes: [any PersistentModel.Type] { LiveKaraokePremium.modelTypes }

    private func song(_ b: KaraokeBundle) -> PKSong {
        PKSong(id: b.id, title: b.title, artist: b.artist, duration: b.duration,
               hasMusic: b.karaokeFile != nil || b.markedAsMusic,
               originalWords: b.originalWords.map(\.pk), vocalsWords: b.vocalsWords.map(\.pk),
               instrumentalURL: b.karaokeURL, workDir: b.dir)
    }

    func lyricsControl(bundle: KaraokeBundle, karaoke: Bool, onLines: @escaping ([[Word]]?) -> Void) -> AnyView {
        AnyView(LyricsVerificationControl(song: song(bundle), karaoke: karaoke) { l in onLines(l?.map { $0.map(Word.init) }) })
    }

    func recordButton(bundle: KaraokeBundle, player: PlayerModel, isRecording: Binding<Bool>) -> AnyView {
        AnyView(PremiumGate {
            SingAlongButton(song: song(bundle), currentTime: { player.time },
                            willStart: { player.player.pause(); isRecording.wrappedValue = true },
                            onTime: { player.clock.time = $0 },
                            didStop: { t in isRecording.wrappedValue = false; player.seek(t) })
        })
    }

    func recordingHint() -> AnyView { AnyView(SingAlongHint()) }
    func settingsRows() -> AnyView { AnyView(PremiumSettingsSection()) }
    func recordingsView(bundleId: UUID?) -> AnyView? { AnyView(RecordingsView(bundleId: bundleId)) }
    func prepareForUITests(_ ctx: ModelContext, songId: UUID?) { LiveKaraokePremium.seedForUITests(ctx, songId: songId) }
}

extension Word {
    var pk: PKWord { PKWord(word: word, start: start, end: end, punctuated_word: punctuated_word) }
    init(_ w: PKWord) { self.init(word: w.word, start: w.start, end: w.end, punctuated_word: w.punctuated_word) }
}
#endif
