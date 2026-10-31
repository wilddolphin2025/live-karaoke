import SwiftUI
import AVFoundation
import AVKit

/// Playback position, published ~30x/s. Kept separate from PlayerModel so only the views that
/// show the time (lyrics, scrubber) re-render each tick; the toolbar and its Menu do not
/// (rebuilding the Menu every tick swallowed its taps during playback).
@MainActor
final class PlaybackClock: ObservableObject {
    @Published var time: Double = 0
}

@MainActor
final class PlayerModel: ObservableObject {
    let player = AVPlayer()
    let clock = PlaybackClock()
    var time: Double { clock.time }
    @Published var duration: Double = 0
    @Published var playing = false
    private var observer: Any?
    private var endObs: NSObjectProtocol?

    init() {
        observer = player.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 30), queue: .main) { [weak self] t in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.clock.time = t.seconds
                // Assign only on change: every @Published assignment re-renders observers.
                let p = self.player.rate > 0
                if p != self.playing { self.playing = p }
                if let d = self.player.currentItem?.duration.seconds, d.isFinite, d != self.duration { self.duration = d }
            }
        }
    }
    deinit { if let observer { player.removeTimeObserver(observer) } }

    func load(_ url: URL, keepPosition: Bool) {
        let t = keepPosition ? player.currentTime() : .zero
        let wasPlaying = player.rate > 0
        player.replaceCurrentItem(with: AVPlayerItem(url: url))
        if keepPosition { player.seek(to: t, toleranceBefore: .zero, toleranceAfter: .zero) }
        if wasPlaying { player.play() }
    }
    func toggle() { if player.rate > 0 { player.pause() } else { player.play() }; playing = player.rate > 0 }
    func seek(_ s: Double) { player.seek(to: CMTime(seconds: max(0, s), preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero); clock.time = s }
}

final class PlayerUIView: UIView {
    override class var layerClass: AnyClass { AVPlayerLayer.self }
    var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
}
struct VideoSurface: UIViewRepresentable {
    let player: AVPlayer
    func makeUIView(context: Context) -> PlayerUIView {
        let v = PlayerUIView(); v.playerLayer.player = player; v.playerLayer.videoGravity = .resizeAspect; v.backgroundColor = .black; return v
    }
    func updateUIView(_ v: PlayerUIView, context: Context) { v.playerLayer.player = player }
}

struct PlayerView: View {
    @Bindable var bundle: KaraokeBundle
    @StateObject private var model = PlayerModel()
    @State private var karaoke: Bool
    @AppStorage("translateTarget") private var target = "en"
    @AppStorage("showTranslation") private var showTranslation = false
    @AppStorage(LyricScale.key) private var lyricScale = LyricScale.default
    @AppStorage("highlightLead") private var lead = 0.25
    @State private var trStatus: String?
    @State private var replacementLines: [[Word]]?   // from PremiumFeatures.lyricsControl
    @State private var isRecording = false
    @State private var showRecordings = false
    private let features = PremiumHost.features

    init(bundle: KaraokeBundle, startKaraoke: Bool) {
        self.bundle = bundle
        _karaoke = State(initialValue: startKaraoke && bundle.karaokeFile != nil)
    }

    private var words: [Word] { replacementLines.map { $0.flatMap { $0 } } ?? (karaoke ? bundle.vocalsWords : bundle.originalWords) }
    private var lines: [LyricLine] { replacementLines.map { Lyrics.lines(grouped: $0) } ?? Lyrics.lines(words) }
    private var variant: String { replacementLines == nil ? "" : "v" }
    private var translation: [String]? { showTranslation ? bundle.translations["\(variant)\(karaoke ? "k" : "o")|\(target)"] : nil }
    private var mediaURL: URL { karaoke ? (bundle.karaokeURL ?? bundle.originalURL) : bundle.originalURL }

    var body: some View {
        VStack(spacing: 0) {
            if bundle.isVideo {
                VideoSurface(player: model.player)
                    .aspectRatio(16 / 9, contentMode: .fit)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .padding(.horizontal).padding(.top, 8)
                    .accessibilityLabel("Video")
            }
            LyricsView(lines: lines, words: words, clock: model.clock, lead: lead, scale: lyricScale, translation: translation)
            controls
        }
        .background(Color(.systemBackground))
        .navigationTitle(bundle.title).navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                // SF Symbols has no "translate.fill"; a button-style Toggle gives the standard filled "on" state.
                Toggle(isOn: $showTranslation) { Label("Translation", systemImage: "translate") }
                    .toggleStyle(.button)
                .accessibilityLabel("Translation")
                .accessibilityIdentifier("translateButton")
                .accessibilityValue(showTranslation ? "On, \(Langs.name(target))" : "Off")
                .contextMenu {
                    Picker(selection: $target) {
                        ForEach(Langs.targets, id: \.code) { Text($0.name).tag($0.code) }
                    } label: { Label("Translate To", systemImage: "globe") }
                }
                ShareLink(item: mediaURL) { Label("Share", systemImage: "square.and.arrow.up") }
                if !model.playing { Menu {
                    Toggle(isOn: $showTranslation) { Label("Show Translation", systemImage: "character.bubble") }
                    Picker(selection: $target) {
                        ForEach(Langs.targets, id: \.code) { Text($0.name).tag($0.code) }
                    } label: { Label("Translate To", systemImage: "globe") }
                    .pickerStyle(.menu)
                    if features.recordingsView(bundleId: nil) != nil {
                        Button { showRecordings = true } label: { Label("My Recordings", systemImage: "waveform") }
                    }
                    Section("Text Size") {
                        Button { lyricScale = min(LyricScale.range.upperBound, lyricScale + 0.1) } label: { Label("Larger", systemImage: "textformat.size.larger") }
                        Button { lyricScale = max(LyricScale.range.lowerBound, lyricScale - 0.1) } label: { Label("Smaller", systemImage: "textformat.size.smaller") }
                    }
                } label: { Label("Display Options", systemImage: "textformat.size") }
                .accessibilityIdentifier("displayOptions")
                }
            }
        }
        .onAppear { model.load(mediaURL, keepPosition: false); model.player.play() }
        .onDisappear { model.player.pause() }
        .onChange(of: karaoke) { model.load(mediaURL, keepPosition: true) }
        .sensoryFeedback(.selection, trigger: karaoke)
        .task(id: "\(showTranslation)\(target)\(karaoke)\(variant)") {
            if showTranslation {
                await Processor.shared.translate(bundle, karaoke: karaoke, target: target,
                                                 lines: replacementLines == nil ? nil : lines, variant: variant) { trStatus = $0 }
            }
        }
        .sheet(isPresented: $showRecordings) {
            if let v = features.recordingsView(bundleId: bundle.id) { NavigationStack { v } }
        }
    }

    private var controls: some View {
        VStack(spacing: 12) {
            if bundle.status != .ready && bundle.status != .error {
                BundleProgressView(bundle: bundle).frame(maxWidth: .infinity, alignment: .leading)
            }
            features.lyricsControl(bundle: bundle, karaoke: karaoke) { replacementLines = $0 }
            if isRecording { features.recordingHint() }
            if let trStatus, showTranslation {
                Text(trStatus).font(.footnote).foregroundStyle(.secondary)
            }
            if bundle.karaokeFile != nil {
                Picker("Track", selection: $karaoke) {
                    Text("Original").tag(false)
                    Text("Karaoke").tag(true)
                }
                .pickerStyle(.segmented)
                .disabled(isRecording)
            }
            Scrubber(model: model, clock: model.clock, fallbackDuration: bundle.duration)
            HStack {
                Spacer()
                Button { model.seek(model.time - 10) } label: { Image(systemName: "gobackward.10").font(.title) }
                    .accessibilityLabel("Back 10 seconds")
                Spacer()
                Button { model.toggle() } label: {
                    Image(systemName: model.playing ? "pause.fill" : "play.fill").font(.largeTitle)
                        .frame(minWidth: 44, minHeight: 44)
                }
                .accessibilityLabel(model.playing ? "Pause" : "Play")
                .accessibilityIdentifier("playPause")
                Spacer()
                Button { model.seek(model.time + 10) } label: { Image(systemName: "goforward.10").font(.title) }
                    .accessibilityLabel("Forward 10 seconds")
                Spacer()
                if karaoke { features.recordButton(bundle: bundle, player: model, isRecording: $isRecording) }
            }
            .buttonStyle(.borderless)
            .foregroundStyle(.primary)
        }
        .padding(.horizontal).padding(.top, 12).padding(.bottom, 8)
        .background(.bar)
        .overlay(alignment: .top) { Divider() }
    }
}

struct Scrubber: View {
    @ObservedObject var model: PlayerModel
    @ObservedObject var clock: PlaybackClock
    let fallbackDuration: Double
    @State private var scrubbing: Double?
    private var duration: Double { model.duration > 0 ? model.duration : fallbackDuration }
    var body: some View {
        VStack(spacing: 4) {
            Slider(value: Binding(get: { scrubbing ?? clock.time }, set: { scrubbing = $0 }),
                   in: 0...max(1, duration),
                   onEditingChanged: { editing in if !editing, let s = scrubbing { model.seek(s); scrubbing = nil } })
                .accessibilityLabel("Playback position")
                .accessibilityValue("\(spokenTime(scrubbing ?? clock.time)) of \(spokenTime(duration))")
            HStack {
                Text(formatTime(scrubbing ?? clock.time))
                Spacer()
                Text("-" + formatTime(max(0, duration - (scrubbing ?? clock.time))))
            }
            .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            .accessibilityHidden(true)
        }
    }
}

struct LyricsView: View {
    let lines: [LyricLine]
    let words: [Word]
    @ObservedObject var clock: PlaybackClock
    private var time: Double { clock.time }
    let lead: Double
    let scale: Double
    let translation: [String]?
    /// Base lyric size follows Dynamic Type (relative to .title2), times the user's relative size.
    @ScaledMetric(relativeTo: .title2) private var base: CGFloat = 22
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let hi = Lyrics.wordAt(words, t: time, lead: lead)
        let started = Lyrics.lastStarted(words, t: time, lead: lead)
        let current = lines.lastIndex { $0.firstWord <= max(started, 0) } ?? 0
        let size = base * scale
        GeometryReader { geo in
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: size * 0.9) {
                        ForEach(lines) { line in
                            let isCurrent = line.id == current
                            VStack(spacing: size * 0.25) {
                                lineText(line, hi: hi, isCurrent: isCurrent)
                                    .font(.system(size: isCurrent ? size * 1.12 : size, weight: isCurrent ? .semibold : .regular))
                                    .foregroundStyle(isCurrent ? Color(.label) : Color(.secondaryLabel))
                                if let translation, line.id < translation.count, !translation[line.id].isEmpty {
                                    Text(translation[line.id])
                                        .font(.system(size: max(18, size * 0.8)))
                                        .foregroundStyle(Color(.secondaryLabel))
                                }
                            }
                            .lineSpacing(size * 0.2)
                            .multilineTextAlignment(.center)
                            .frame(maxWidth: .infinity)
                            .accessibilityElement(children: .combine)
                            .accessibilityAddTraits(isCurrent ? .isSelected : [])
                            .id(line.id)
                        }
                    }
                    .padding(.horizontal, 20)
                    .padding(.vertical, 16)
                }
                .scrollIndicators(.hidden)
                .onChange(of: current) {
                    if reduceMotion { proxy.scrollTo(current, anchor: .center) }
                    else { withAnimation(.easeInOut(duration: 0.35)) { proxy.scrollTo(current, anchor: .center) } }
                }
                .onChange(of: lines.count) { proxy.scrollTo(current, anchor: .center) }
                .onAppear { if started > 0 { proxy.scrollTo(current, anchor: .center) } }
            }
            .overlay {
                if lines.isEmpty {
                    ContentUnavailableView("No Lyrics", systemImage: "text.quote",
                                           description: Text("No words were recognized in this track."))
                }
            }
        }
    }

    /// Current line: words in .label, the word being sung in the tint color. Other lines inherit the caller's style.
    private func lineText(_ line: LyricLine, hi: Int, isCurrent: Bool) -> Text {
        var t = Text("")
        for (k, w) in line.words.enumerated() {
            let piece = Text(k == 0 ? w.text : " " + w.text)
            t = t + (isCurrent && line.firstWord + k == hi ? piece.foregroundColor(.accentColor) : piece)
        }
        return t
    }
}
