import SwiftUI
import AVFoundation
import AVKit

@MainActor
final class PlayerModel: ObservableObject {
    let player = AVPlayer()
    @Published var time: Double = 0
    @Published var duration: Double = 0
    @Published var playing = false
    private var observer: Any?
    private var endObs: NSObjectProtocol?

    init() {
        observer = player.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 30), queue: .main) { [weak self] t in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.time = t.seconds
                self.playing = self.player.rate > 0
                if let d = self.player.currentItem?.duration.seconds, d.isFinite { self.duration = d }
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
    func seek(_ s: Double) { player.seek(to: CMTime(seconds: max(0, s), preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero); time = s }
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
    @State private var scrubbing: Double?

    init(bundle: KaraokeBundle, startKaraoke: Bool) {
        self.bundle = bundle
        _karaoke = State(initialValue: startKaraoke && bundle.karaokeFile != nil)
    }

    private var words: [Word] { karaoke ? bundle.vocalsWords : bundle.originalWords }
    private var lines: [LyricLine] { Lyrics.lines(words) }
    private var translation: [String]? { showTranslation ? bundle.translations["\(karaoke ? "k" : "o")|\(target)"] : nil }
    private var mediaURL: URL { karaoke ? (bundle.karaokeURL ?? bundle.originalURL) : bundle.originalURL }
    private var duration: Double { model.duration > 0 ? model.duration : bundle.duration }

    var body: some View {
        VStack(spacing: 0) {
            if bundle.isVideo {
                VideoSurface(player: model.player)
                    .aspectRatio(16 / 9, contentMode: .fit)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .padding(.horizontal).padding(.top, 8)
                    .accessibilityLabel("Video")
            }
            LyricsView(lines: lines, words: words, time: model.time, lead: lead, scale: lyricScale, translation: translation)
            controls
        }
        .background(Color(.systemBackground))
        .navigationTitle(bundle.title).navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                ShareLink(item: mediaURL) { Label("Share", systemImage: "square.and.arrow.up") }
                Menu {
                    Toggle(isOn: $showTranslation) { Label("Show Translation", systemImage: "character.bubble") }
                    Picker(selection: $target) {
                        ForEach(Langs.targets, id: \.code) { Text($0.name).tag($0.code) }
                    } label: { Label("Translate To", systemImage: "globe") }
                    .pickerStyle(.menu)
                    Section("Text Size") {
                        Button { lyricScale = min(LyricScale.range.upperBound, lyricScale + 0.1) } label: { Label("Larger", systemImage: "textformat.size.larger") }
                        Button { lyricScale = max(LyricScale.range.lowerBound, lyricScale - 0.1) } label: { Label("Smaller", systemImage: "textformat.size.smaller") }
                    }
                } label: { Label("Display Options", systemImage: "textformat.size") }
            }
        }
        .onAppear { model.load(mediaURL, keepPosition: false); model.player.play() }
        .onDisappear { model.player.pause() }
        .onChange(of: karaoke) { model.load(mediaURL, keepPosition: true) }
        .sensoryFeedback(.selection, trigger: karaoke)
        .task(id: "\(showTranslation)\(target)\(karaoke)") {
            if showTranslation { await Processor.shared.translate(bundle, karaoke: karaoke, target: target) { trStatus = $0 } }
        }
    }

    private var controls: some View {
        VStack(spacing: 12) {
            if let trStatus, showTranslation {
                Text(trStatus).font(.footnote).foregroundStyle(.secondary)
            }
            if bundle.karaokeFile != nil {
                Picker("Track", selection: $karaoke) {
                    Text("Original").tag(false)
                    Text("Karaoke").tag(true)
                }
                .pickerStyle(.segmented)
            }
            VStack(spacing: 4) {
                Slider(value: Binding(get: { scrubbing ?? model.time }, set: { scrubbing = $0 }),
                       in: 0...max(1, duration),
                       onEditingChanged: { editing in if !editing, let s = scrubbing { model.seek(s); scrubbing = nil } })
                    .accessibilityLabel("Playback position")
                    .accessibilityValue("\(spokenTime(scrubbing ?? model.time)) of \(spokenTime(duration))")
                HStack {
                    Text(formatTime(scrubbing ?? model.time))
                    Spacer()
                    Text("-" + formatTime(max(0, duration - (scrubbing ?? model.time))))
                }
                .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                .accessibilityHidden(true)
            }
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
                Spacer()
                Button { model.seek(model.time + 10) } label: { Image(systemName: "goforward.10").font(.title) }
                    .accessibilityLabel("Forward 10 seconds")
                Spacer()
            }
            .buttonStyle(.borderless)
            .foregroundStyle(.primary)
        }
        .padding(.horizontal).padding(.top, 12).padding(.bottom, 8)
        .background(.bar)
        .overlay(alignment: .top) { Divider() }
    }
}

struct LyricsView: View {
    let lines: [LyricLine]
    let words: [Word]
    let time: Double
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
                        Color.clear.frame(height: geo.size.height * 0.35).accessibilityHidden(true)
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
                        Color.clear.frame(height: geo.size.height * 0.35).accessibilityHidden(true)
                    }
                    .padding(.horizontal, 20)
                }
                .scrollIndicators(.hidden)
                .onChange(of: current) {
                    if reduceMotion { proxy.scrollTo(current, anchor: .center) }
                    else { withAnimation(.easeInOut(duration: 0.35)) { proxy.scrollTo(current, anchor: .center) } }
                }
                .onChange(of: lines.count) { proxy.scrollTo(current, anchor: .center) }
                .onAppear { proxy.scrollTo(current, anchor: .center) }
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
