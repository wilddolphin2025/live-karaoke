import SwiftUI

struct SettingsView: View {
    @AppStorage("serverURL") private var server = Settings.defaultServer
    @AppStorage("defaultLanguage") private var language = "auto"
    @AppStorage("translateTarget") private var target = "en"
    @AppStorage(LyricScale.key) private var lyricScale = LyricScale.default
    @AppStorage("appearance") private var appearance = Appearance.system.rawValue
    @AppStorage("highlightLead") private var lead = 0.25
    @State private var info: [String: Any]?
    @State private var infoError: String?

    var body: some View {
        Form {
            Section {
                Picker("Appearance", selection: $appearance) {
                    ForEach(Appearance.allCases) { Text($0.label).tag($0.rawValue) }
                }
            } header: { Text("Display") } footer: { Text("System follows your device's Light or Dark setting.") }
            Section {
                TextField("Server URL", text: $server, prompt: Text("http://YOUR_SERVER_IP:30800")).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                Button("Test Connection") { Task { await load() } }
                if !Settings.defaultServer.isEmpty { Button("Reset to Default") { server = Settings.defaultServer } }
            } header: { Text("Server") } footer: { Text("The Live Karaoke server that transcribes songs and removes vocals.") }
            Section("Songs") {
                Picker("Default language", selection: $language) {
                    ForEach(Langs.source, id: \.self) { Text(Langs.sourceName($0)).tag($0) }
                }
                Picker("Translate to", selection: $target) { ForEach(Langs.targets, id: \.code) { Text($0.name).tag($0.code) } }
            }
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    LabeledContent("Text Size", value: lyricScale.formatted(.percent.precision(.fractionLength(0))))
                    HStack {
                        Image(systemName: "textformat.size.smaller").accessibilityHidden(true)
                        Slider(value: $lyricScale, in: LyricScale.range, step: 0.1)
                            .accessibilityLabel("Lyrics text size")
                            .accessibilityValue(lyricScale.formatted(.percent.precision(.fractionLength(0))))
                        Image(systemName: "textformat.size.larger").accessibilityHidden(true)
                    }
                    .foregroundStyle(.secondary)
                    LyricPreview(scale: lyricScale)
                }
                VStack(alignment: .leading, spacing: 8) {
                    LabeledContent("Highlight Lead", value: "\(lead.formatted(.number.precision(.fractionLength(2)))) s")
                    Slider(value: $lead, in: 0...1, step: 0.05)
                        .accessibilityLabel("Highlight lead")
                        .accessibilityValue("\(lead.formatted(.number.precision(.fractionLength(2)))) seconds")
                }
            } header: { Text("Lyrics") } footer: {
                Text("Lyrics also follow the system text size (Settings > Accessibility > Display & Text Size). Highlight lead shows each word slightly before it is sung.")
            }
            Section("About") {
                LabeledContent("Version", value: "\(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?") (\(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"))")
                if let info {
                    row("Server", info["service_version"] as? String ?? "?")
                    row("ASR model", info["model"] as? String ?? "?")
                    row("GPU", info["gpu"] as? String ?? "?")
                    if let sep = info["separation"] as? [String: Any], let m = sep["models"] as? [String: Any] {
                        row("Separation", "\(sep["enabled"] as? Bool == true ? "on" : "off") · \(m["gpu"] as? String ?? "")")
                    }
                    if let tr = info["translation"] as? [String: Any] {
                        row("Translator", tr["model"] as? String ?? "?")
                        row("Mode", tr["mode"] as? String ?? "?")
                    }
                } else if let infoError {
                    Label(infoError, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red).font(.footnote)
                } else { ProgressView() }
            }
        }
        .navigationTitle("Settings")
        .task { await load() }
    }

    private func row(_ k: String, _ v: String) -> some View { LabeledContent(k, value: v) }

    private func load() async {
        info = nil; infoError = nil
        do { info = try await ParakeetAPI(server).info() } catch { infoError = error.localizedDescription }
    }
}

/// Sample lyric at the chosen size, styled like the player's current line.
struct LyricPreview: View {
    let scale: Double
    @ScaledMetric(relativeTo: .title2) private var base: CGFloat = 22
    var body: some View {
        (Text("Sing ") + Text("along").foregroundColor(.accentColor) + Text(" with me"))
            .font(.system(size: base * scale * 1.12, weight: .semibold))
            .foregroundStyle(Color(.label))
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.vertical, 6)
            .accessibilityLabel("Preview: Sing along with me")
    }
}
