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
    @AppStorage("textSize") private var textSizeRaw = TextSize.medium.rawValue
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

    var body: some View {
        ZStack {
            CandyBackground()
            VStack(spacing: 0) {
                if bundle.isVideo {
                    VideoSurface(player: model.player)
                        .aspectRatio(16 / 9, contentMode: .fit)
                        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                        .padding(.horizontal)
                }
                LyricsView(lines: lines, words: words, time: model.time, lead: lead, karaoke: karaoke,
                           size: TextSize(rawValue: textSizeRaw) ?? .medium, translation: translation)
                controls
            }
        }
        .navigationTitle(bundle.title).navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Picker("Text size", selection: $textSizeRaw) { ForEach(TextSize.allCases) { Text($0.label).tag($0.rawValue) } }
                    Toggle("Show translation", isOn: $showTranslation)
                    Picker("Translate to", selection: $target) { ForEach(Langs.targets, id: \.code) { Text($0.name).tag($0.code) } }
                } label: { Image(systemName: "textformat.size") }
            }
        }
        .onAppear { model.load(mediaURL, keepPosition: false); model.player.play() }
        .onDisappear { model.player.pause() }
        .onChange(of: karaoke) { model.load(mediaURL, keepPosition: true) }
        .task(id: "\(showTranslation)\(target)\(karaoke)") {
            if showTranslation { await Processor.shared.translate(bundle, karaoke: karaoke, target: target) { trStatus = $0 } }
        }
    }

    private var controls: some View {
        VStack(spacing: 10) {
            if let trStatus, showTranslation { Text(trStatus).font(.caption).foregroundStyle(.secondary) }
            HStack(spacing: 0) {
                modeButton("Karaoke", "mic.fill", true).disabled(bundle.karaokeFile == nil)
                modeButton("Original", "person.wave.2.fill", false)
            }
            .padding(4).background(Capsule().fill(.ultraThinMaterial))
            VStack(spacing: 2) {
                Slider(value: Binding(get: { scrubbing ?? model.time }, set: { scrubbing = $0 }),
                       in: 0...max(1, model.duration > 0 ? model.duration : bundle.duration),
                       onEditingChanged: { editing in if !editing, let s = scrubbing { model.seek(s); scrubbing = nil } })
                    .tint(Candy.pink)
                HStack { Text(formatTime(scrubbing ?? model.time)); Spacer(); Text(formatTime(model.duration > 0 ? model.duration : bundle.duration)) }
                    .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            }
            HStack(spacing: 22) {
                Button { model.seek(model.time - 10) } label: { Image(systemName: "gobackward.10") }.buttonStyle(RoundBubbleStyle(color: Candy.sky, size: 48))
                Button { model.toggle() } label: { Image(systemName: model.playing ? "pause.fill" : "play.fill") }
                    .buttonStyle(RoundBubbleStyle(color: Candy.pink, size: 70))
                Button { model.seek(model.time + 10) } label: { Image(systemName: "goforward.10") }.buttonStyle(RoundBubbleStyle(color: Candy.lilac, size: 48))
                Button { withAnimation(.spring) { showTranslation.toggle() } } label: { Image(systemName: "character.bubble.fill") }
                    .buttonStyle(RoundBubbleStyle(color: showTranslation ? Candy.mint : .gray.opacity(0.6), size: 48))
            }
        }
        .padding().background(RoundedRectangle(cornerRadius: 28, style: .continuous).fill(.ultraThinMaterial).ignoresSafeArea(edges: .bottom))
    }

    private func modeButton(_ title: String, _ icon: String, _ k: Bool) -> some View {
        Button { withAnimation(.spring(response: 0.35, dampingFraction: 0.6)) { karaoke = k } } label: {
            Label(title, systemImage: icon).font(.subheadline.bold()).padding(.vertical, 8).frame(maxWidth: .infinity)
                .foregroundStyle(karaoke == k ? .white : .primary)
                .background { if karaoke == k { Capsule().fill(Candy.gradient(k ? 0 : 4)) } }
        }
    }
}

struct LyricsView: View {
    let lines: [LyricLine]
    let words: [Word]
    let time: Double
    let lead: Double
    let karaoke: Bool
    let size: TextSize
    let translation: [String]?
    @ScaledMetric(relativeTo: .title) private var scale: CGFloat = 1

    var body: some View {
        let hi = Lyrics.wordAt(words, t: time, lead: lead)
        let started = Lyrics.lastStarted(words, t: time, lead: lead)
        let current = lines.lastIndex { $0.firstWord <= max(started, 0) } ?? 0
        GeometryReader { geo in
            ScrollViewReader { proxy in
                ScrollView(showsIndicators: false) {
                    LazyVStack(spacing: 18) {
                        Color.clear.frame(height: geo.size.height * 0.4)
                        ForEach(lines) { line in
                            VStack(spacing: 6) {
                                lineText(line, hi: hi, started: started, isCurrent: line.id == current)
                                if let translation, line.id < translation.count, !translation[line.id].isEmpty {
                                    Text(translation[line.id]).font(.system(size: size.points * scale * 0.62, weight: .medium, design: .rounded))
                                        .foregroundStyle(Candy.lilac).transition(.opacity.combined(with: .scale))
                                }
                            }
                            .multilineTextAlignment(.center)
                            .frame(maxWidth: .infinity)
                            .scaleEffect(line.id == current ? 1.0 : 0.9)
                            .opacity(line.id == current ? 1 : (abs(line.id - current) <= 2 ? 0.6 : 0.35))
                            .blur(radius: line.id == current ? 0 : 0.4)
                            .animation(.spring(response: 0.4, dampingFraction: 0.7), value: current)
                            .id(line.id)
                        }
                        Color.clear.frame(height: geo.size.height * 0.4)
                    }.padding(.horizontal)
                }
                .onChange(of: current) { withAnimation(.easeInOut(duration: 0.45)) { proxy.scrollTo(current, anchor: .center) } }
                .onChange(of: lines.count) { proxy.scrollTo(current, anchor: .center) }
                .onAppear { proxy.scrollTo(current, anchor: .center) }
            }
            .overlay {
                if lines.isEmpty {
                    VStack { Text("🎶").font(.system(size: 60)); Text("No words found").font(.headline) }
                }
            }
        }
    }

    private func lineText(_ line: LyricLine, hi: Int, started: Int, isCurrent: Bool) -> Text {
        let font = Font.system(size: size.points * scale, weight: .heavy, design: .rounded)
        var t = Text("")
        for (k, w) in line.words.enumerated() {
            let gi = line.firstWord + k
            let piece = Text(k == 0 ? w.text : " " + w.text).font(font)
            if gi == hi && isCurrent {
                t = t + piece.foregroundColor(karaoke ? Candy.pink : Candy.sky)
            } else if isCurrent && gi < max(hi, started + (hi < 0 ? 1 : 0)) {
                t = t + piece.foregroundColor(karaoke ? Candy.lilac : Candy.mint)
            } else {
                t = t + piece.foregroundColor(.primary)
            }
        }
        return t
    }
}
