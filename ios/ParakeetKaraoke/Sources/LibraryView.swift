import SwiftUI
import SwiftData
import UniformTypeIdentifiers

struct LibraryView: View {
    @Environment(\.modelContext) private var ctx
    @Query(sort: \KaraokeBundle.createdAt, order: .reverse) private var bundles: [KaraokeBundle]
    @State private var path: [Route] = []
    @State private var showNew = false
    @State private var renaming: KaraokeBundle?
    @State private var newName = ""
    @AppStorage("defaultLanguage") private var defaultLanguage = "auto"

    enum Route: Hashable { case player(UUID, Bool), settings }

    var body: some View {
        NavigationStack(path: $path) {
            ZStack {
                CandyBackground()
                if bundles.isEmpty { emptyState } else { list }
            }
            .navigationTitle("Karaoke 🎤")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { path.append(.settings) } label: { Image(systemName: "gearshape.fill") }.tint(Candy.lilac)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showNew = true } label: {
                        Image(systemName: "plus").font(.title3.bold()).foregroundStyle(.white)
                            .frame(width: 38, height: 38).background(Circle().fill(Candy.gradient(0)))
                            .shadow(color: Candy.pink.opacity(0.5), radius: 6, y: 3)
                    }.accessibilityLabel("New karaoke")
                }
            }
            .navigationDestination(for: Route.self) { r in
                switch r {
                case .settings: SettingsView()
                case .player(let id, let karaoke):
                    if let b = bundles.first(where: { $0.id == id }) { PlayerView(bundle: b, startKaraoke: karaoke) }
                }
            }
            .sheet(isPresented: $showNew) { NewBundleView().presentationDetents([.medium, .large]) }
            .alert("Rename", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
                TextField("Title", text: $newName)
                Button("Save") { if let r = renaming, let n = newName.nilIfBlank { r.title = n; try? ctx.save() }; renaming = nil }
                Button("Cancel", role: .cancel) { renaming = nil }
            }
        }
        .tint(Candy.pink)
        .onOpenURL(perform: handle)
        .onAppear {
            resume()
            // Test hooks: `-debugURL parakeetkaraoke://...` launch arguments (no "Open in" prompt).
            for key in ["debugURL", "debugURL2"] {
                if let s = UserDefaults.standard.string(forKey: key), let u = URL(string: s) { handle(u) }
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 18) {
            Text("🍭").font(.system(size: 80))
            Text("No karaoke yet").font(.title.bold()).fontDesign(.rounded)
            Text("Pick a song or video from Files, or paste a link.\nWe'll take the singer out and show you the words.")
                .multilineTextAlignment(.center).foregroundStyle(.secondary)
            Button { showNew = true } label: { Label("New karaoke", systemImage: "sparkles") }.buttonStyle(BubbleButtonStyle())
        }.padding(30)
    }

    private var list: some View {
        List {
            ForEach(Array(bundles.enumerated()), id: \.element.id) { i, b in
                BundleRow(bundle: b, seed: i)
                    .contentShape(Rectangle())
                    .onTapGesture { open(b) }
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) { delete(b) } label: { Label("Delete", systemImage: "trash") }
                        Button { newName = b.title; renaming = b } label: { Label("Rename", systemImage: "pencil") }.tint(Candy.lilac)
                    }
                    .swipeActions(edge: .leading) {
                        if b.status == .error { Button { Processor.shared.start(b, context: ctx) } label: { Label("Retry", systemImage: "arrow.clockwise") }.tint(Candy.mint) }
                    }
                    .contextMenu {
                        Button { newName = b.title; renaming = b } label: { Label("Rename", systemImage: "pencil") }
                        if b.status == .error { Button { Processor.shared.start(b, context: ctx) } label: { Label("Retry", systemImage: "arrow.clockwise") } }
                        Button(role: .destructive) { delete(b) } label: { Label("Delete", systemImage: "trash") }
                    }
            }
        }
        .listStyle(.plain).scrollContentBackground(.hidden)
        .animation(.spring(), value: bundles.map(\.id))
    }

    private func open(_ b: KaraokeBundle, karaoke: Bool? = nil) {
        if b.status == .error && !Processor.shared.isRunning(b.id) && b.originalWords.isEmpty { Processor.shared.start(b, context: ctx); return }
        guard !b.originalWords.isEmpty || b.karaokeFile != nil else { return }
        path.append(.player(b.id, karaoke ?? (b.karaokeFile != nil)))
    }

    private func delete(_ b: KaraokeBundle) {
        Processor.shared.cancel(b)
        Processor.deleteFiles(b)
        withAnimation { ctx.delete(b); try? ctx.save() }
    }

    /// Resume pipelines interrupted by an app kill.
    private func resume() {
        for b in bundles where b.status != .ready && b.status != .error && !Processor.shared.isRunning(b.id) {
            Processor.shared.start(b, context: ctx)
        }
    }

    private func handle(_ url: URL) {
        if url.isFileURL {
            _ = try? Processor.shared.importFile(url, title: nil, language: defaultLanguage, context: ctx); return
        }
        let q = Dictionary(uniqueKeysWithValues: (URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        switch url.host {
        case "import":
            if let s = q["url"], let u = URL(string: s) {
                _ = Processor.shared.importURL(u, title: q["title"], language: q["lang"] ?? defaultLanguage, context: ctx)
            }
        case "open":
            let i = Int(q["index"] ?? "0") ?? 0
            if i < bundles.count { path = []; open(bundles[i], karaoke: q["mode"].map { $0 != "original" }) }
        case "settings": path = [.settings]
        case "new": showNew = true
        default: break
        }
    }
}

struct BundleRow: View {
    let bundle: KaraokeBundle
    let seed: Int
    var body: some View {
        HStack(spacing: 14) {
            ZStack {
                RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Candy.gradient(seed))
                if let d = bundle.thumbnail, let img = UIImage(data: d) {
                    Image(uiImage: img).resizable().scaledToFill()
                } else {
                    Image(systemName: bundle.isVideo ? "film.fill" : "music.note").font(.title2.bold()).foregroundStyle(.white)
                }
            }
            .frame(width: 64, height: 64).clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            VStack(alignment: .leading, spacing: 5) {
                Text(bundle.title).font(.headline).fontDesign(.rounded).lineLimit(2)
                HStack(spacing: 6) {
                    if bundle.duration > 0 { Chip(text: formatTime(bundle.duration), color: Candy.sky) }
                    Chip(text: (bundle.detectedLanguage ?? bundle.language).uppercased(), color: Candy.mint)
                    if bundle.isVideo { Chip(text: "VIDEO", color: Candy.peach) }
                }
                switch bundle.status {
                case .ready: Label("Ready to sing", systemImage: "mic.fill").font(.caption.bold()).foregroundStyle(Candy.pink)
                case .error: Label(bundle.statusText, systemImage: "exclamationmark.triangle.fill").font(.caption).foregroundStyle(.red).lineLimit(2)
                default:
                    VStack(alignment: .leading, spacing: 3) {
                        ProgressView(value: bundle.progress).tint(Candy.pink)
                        Text(bundle.statusText).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
            }
            Spacer(minLength: 0)
            if bundle.status == .ready { Image(systemName: "chevron.right").foregroundStyle(.tertiary) }
        }
        .candyCard()
    }
}

struct Chip: View {
    let text: String; let color: Color
    var body: some View {
        Text(text).font(.caption2.bold()).padding(.horizontal, 8).padding(.vertical, 3)
            .background(Capsule().fill(color.opacity(0.3))).foregroundStyle(.primary)
    }
}

struct NewBundleView: View {
    @Environment(\.modelContext) private var ctx
    @Environment(\.dismiss) private var dismiss
    @AppStorage("defaultLanguage") private var defaultLanguage = "auto"
    @State private var language = ""
    @State private var title = ""
    @State private var link = ""
    @State private var picking = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            ZStack {
                CandyBackground()
                ScrollView {
                    VStack(spacing: 18) {
                        Text("✨ New karaoke").font(.largeTitle.bold()).fontDesign(.rounded)
                        VStack(alignment: .leading, spacing: 10) {
                            TextField("Title (optional)", text: $title).textFieldStyle(.roundedBorder)
                            Picker("Language", selection: $language) {
                                ForEach(Langs.source, id: \.self) { Text($0 == "auto" ? "Auto-detect" : $0.uppercased()).tag($0) }
                            }.pickerStyle(.menu)
                        }.candyCard()
                        Button { picking = true } label: { Label("Choose from Files", systemImage: "folder.fill").frame(maxWidth: .infinity) }
                            .buttonStyle(BubbleButtonStyle(colors: [Candy.pink, Candy.peach]))
                        VStack(spacing: 10) {
                            TextField("https://… audio or video link", text: $link)
                                .textFieldStyle(.roundedBorder).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                            Button { fromLink() } label: { Label("Download from link", systemImage: "link").frame(maxWidth: .infinity) }
                                .buttonStyle(BubbleButtonStyle(colors: [Candy.sky, Candy.lilac])).disabled(URL(string: link)?.scheme == nil)
                        }.candyCard()
                        if let error { Text(error).foregroundStyle(.red).font(.callout) }
                    }.padding()
                }
            }
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .fileImporter(isPresented: $picking, allowedContentTypes: [.audio, .movie, .audiovisualContent, .mpeg4Movie, .mp3]) { r in
                switch r {
                case .success(let u):
                    do { _ = try Processor.shared.importFile(u, title: title, language: language, context: ctx); dismiss() }
                    catch { self.error = error.localizedDescription }
                case .failure(let e): error = e.localizedDescription
                }
            }
            .onAppear { if language.isEmpty { language = defaultLanguage } }
        }
    }

    private func fromLink() {
        guard let u = URL(string: link.trimmingCharacters(in: .whitespaces)), u.scheme?.hasPrefix("http") == true else { error = "Enter an http(s) link"; return }
        _ = Processor.shared.importURL(u, title: title, language: language, context: ctx)
        dismiss()
    }
}
