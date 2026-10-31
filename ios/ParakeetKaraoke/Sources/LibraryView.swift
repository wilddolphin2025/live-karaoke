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

    enum Route: Hashable { case player(UUID, Bool), settings, recordings }
    private let features = PremiumHost.features

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if bundles.isEmpty { emptyState } else { list }
            }
            .navigationTitle("Live Karaoke")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { path.append(.settings) } label: { Label("Settings", systemImage: "gearshape") }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button { showNew = true } label: { Label("Add Song", systemImage: "plus") }
                }
                if features.recordingsView(bundleId: nil) != nil {
                    ToolbarItem(placement: .secondaryAction) {
                        Button { path.append(.recordings) } label: { Label("My Recordings", systemImage: "waveform") }
                            .accessibilityIdentifier("libraryRecordings")
                    }
                }
            }
            .navigationDestination(for: Route.self) { r in
                switch r {
                case .settings: SettingsView()
                case .recordings: features.recordingsView(bundleId: nil)
                case .player(let id, let karaoke):
                    if let b = bundles.first(where: { $0.id == id }) { PlayerView(bundle: b, startKaraoke: karaoke) }
                }
            }
            .sheet(isPresented: $showNew) { NewBundleView() }
            .alert("Rename Song", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
                TextField("Title", text: $newName)
                Button("Save") { if let r = renaming, let n = newName.nilIfBlank { r.title = n; try? ctx.save() }; renaming = nil }
                Button("Cancel", role: .cancel) { renaming = nil }
            }
        }
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
        ContentUnavailableView {
            Label("No Songs", systemImage: "music.mic")
        } description: {
            Text("Add a song or video from Files or a link. Live Karaoke removes the vocals and shows the words in time.")
        } actions: {
            Button("Add Song") { showNew = true }.buttonStyle(.borderedProminent)
        }
    }

    private var list: some View {
        List {
            Section {
                ForEach(bundles) { b in
                    Button { open(b) } label: { BundleRow(bundle: b) }
                        .foregroundStyle(.primary)
                        .accessibilityHint(b.status == .ready ? "Opens the player" : "")
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) { delete(b) } label: { Label("Delete", systemImage: "trash") }
                            Button { newName = b.title; renaming = b } label: { Label("Rename", systemImage: "pencil") }.tint(.gray)
                        }
                        .swipeActions(edge: .leading) {
                            if b.status == .error { Button { Processor.shared.start(b, context: ctx) } label: { Label("Retry", systemImage: "arrow.clockwise") }.tint(.accentColor) }
                        }
                        .contextMenu {
                            Button { newName = b.title; renaming = b } label: { Label("Rename", systemImage: "pencil") }
                            if b.status == .error { Button { Processor.shared.start(b, context: ctx) } label: { Label("Retry", systemImage: "arrow.clockwise") } }
                            if b.karaokeFile == nil && features.recordingsView(bundleId: nil) != nil {
                                Toggle(isOn: Binding(get: { b.markedAsMusic }, set: { b.markedAsMusic = $0; try? ctx.save() })) {
                                    Label("Song with Music", systemImage: "music.note")
                                }
                            }
                            if b.status == .ready { ShareLink(item: b.karaokeURL ?? b.originalURL) { Label("Share", systemImage: "square.and.arrow.up") } }
                            Divider()
                            Button(role: .destructive) { delete(b) } label: { Label("Delete", systemImage: "trash") }
                        }
                }
            }
        }
        .listStyle(.insetGrouped)
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
        case "recordings": path = [.recordings]
        case "player":
            if let id = q["id"].flatMap(UUID.init), let b = bundles.first(where: { $0.id == id }) { path = []; open(b, karaoke: q["mode"].map { $0 != "original" }) }
        case "new": showNew = true
        default: break
        }
    }
}

struct BundleRow: View {
    let bundle: KaraokeBundle
    @ScaledMetric(relativeTo: .headline) private var thumb: CGFloat = 52
    @Environment(\.dynamicTypeSize) private var typeSize

    private var details: String {
        var parts: [String] = []
        if bundle.duration > 0 { parts.append(formatTime(bundle.duration)) }
        parts.append(Langs.sourceName(bundle.detectedLanguage ?? bundle.language))
        if bundle.isVideo { parts.append("Video") }
        return parts.joined(separator: " · ")
    }

    var body: some View {
        // At accessibility text sizes, stack the thumbnail above the text so titles get full width.
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
            : AnyLayout(HStackLayout(spacing: 12))
        layout {
            ZStack {
                Color(.secondarySystemFill)
                if let d = bundle.thumbnail, let img = UIImage(data: d) {
                    Image(uiImage: img).resizable().scaledToFill()
                } else {
                    Image(systemName: bundle.isVideo ? "film" : "music.note").font(.title3).foregroundStyle(.secondary)
                }
            }
            .frame(width: typeSize.isAccessibilitySize ? 64 : thumb, height: typeSize.isAccessibilitySize ? 64 : thumb)
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(bundle.title).font(.headline).lineLimit(2)
                Text(details).font(.subheadline).foregroundStyle(.secondary)
                switch bundle.status {
                case .ready: EmptyView()
                case .error:
                    Label(bundle.statusText, systemImage: "exclamationmark.triangle.fill")
                        .font(.footnote).foregroundStyle(.red).lineLimit(2)
                default: BundleProgressView(bundle: bundle)
                }
            }
            if !typeSize.isAccessibilitySize { Spacer(minLength: 0) }
            if bundle.status == .ready && !typeSize.isAccessibilitySize {
                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary).accessibilityHidden(true)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
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
            Form {
                Section {
                    TextField("Title (optional)", text: $title)
                    Picker("Language", selection: $language) {
                        ForEach(Langs.source, id: \.self) { Text(Langs.sourceName($0)).tag($0) }
                    }
                }
                Section {
                    Button { picking = true } label: { Label("Choose from Files", systemImage: "folder") }
                } footer: { Text("Audio or video files, for example MP3, M4A, WAV or MP4.") }
                Section("From a Link") {
                    TextField("https://", text: $link)
                        .keyboardType(.URL).textContentType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .submitLabel(.go).onSubmit(fromLink)
                    Button { fromLink() } label: { Label("Download", systemImage: "arrow.down.circle") }
                        .disabled(URL(string: link)?.scheme == nil)
                }
                if let error { Section { Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red) } }
            }
            .navigationTitle("Add Song").navigationBarTitleDisplayMode(.inline)
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

/// Pipeline status for a song that is not ready: a linear bar with byte counts while uploading,
/// a spinner while waiting for the server, and the overall bar otherwise. Used in the library row and the player.
struct BundleProgressView: View {
    let bundle: KaraokeBundle

    static func mb(_ n: Int64) -> String { String(format: "%.1f", Double(n) / 1_000_000) }
    static func uploadText(_ prefix: String, sent: Int64, total: Int64) -> String {
        let pct = total > 0 ? Int(Double(sent) / Double(total) * 100) : 0
        return "\(prefix) \(pct)% · \(mb(sent)) of \(mb(total)) MB"
    }

    var body: some View {
        if bundle.uploadTotal > 0 {
            let f = min(1, Double(bundle.uploadSent) / Double(bundle.uploadTotal))
            ProgressView(value: f) {
                Text(Self.uploadText(bundle.statusText, sent: bundle.uploadSent, total: bundle.uploadTotal))
                    .font(.footnote).monospacedDigit().foregroundStyle(.secondary).lineLimit(2)
            }
            .progressViewStyle(.linear)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(bundle.statusText.replacingOccurrences(of: "…", with: ""))
            .accessibilityValue("\(Int(f * 100)) percent, \(Self.mb(bundle.uploadSent)) of \(Self.mb(bundle.uploadTotal)) megabytes")
            .accessibilityIdentifier("uploadProgress")
        } else if bundle.serverWaiting {
            HStack(spacing: 6) {
                ProgressView().controlSize(.small)
                Text(bundle.statusText).font(.footnote).foregroundStyle(.secondary).lineLimit(2)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(bundle.statusText.replacingOccurrences(of: "…", with: ""))
            .accessibilityValue("In progress")
            .accessibilityIdentifier("serverWaiting")
        } else {
            ProgressView(value: bundle.progress) {
                Text(bundle.statusText).font(.footnote).monospacedDigit().foregroundStyle(.secondary).lineLimit(2)
            }
            .progressViewStyle(.linear)
        }
    }
}
