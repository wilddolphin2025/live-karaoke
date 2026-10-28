import SwiftUI

struct SettingsView: View {
    @AppStorage("serverURL") private var server = Settings.defaultServer
    @AppStorage("defaultLanguage") private var language = "auto"
    @AppStorage("translateTarget") private var target = "en"
    @AppStorage("textSize") private var textSizeRaw = TextSize.medium.rawValue
    @AppStorage("highlightLead") private var lead = 0.25
    @State private var info: [String: Any]?
    @State private var infoError: String?

    var body: some View {
        Form {
            Section("Server") {
                TextField("Server URL", text: $server).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                Button("Reset to default") { server = Settings.defaultServer }
                Button("Test connection") { Task { await load() } }
            }
            Section("Songs") {
                Picker("Default language", selection: $language) {
                    ForEach(Langs.source, id: \.self) { Text($0 == "auto" ? "Auto-detect" : $0.uppercased()).tag($0) }
                }
                Picker("Translate to", selection: $target) { ForEach(Langs.targets, id: \.code) { Text($0.name).tag($0.code) } }
            }
            Section("Lyrics") {
                Picker("Text size", selection: $textSizeRaw) { ForEach(TextSize.allCases) { Text($0.label).tag($0.rawValue) } }
                VStack(alignment: .leading) {
                    Text("Highlight lead: \(lead, specifier: "%.2f") s")
                    Slider(value: $lead, in: 0...1, step: 0.05).tint(Candy.pink)
                }
                Text("Lyrics also follow your Dynamic Type setting.").font(.footnote).foregroundStyle(.secondary)
            }
            Section("About") {
                row("App", "\(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?") (\(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"))")
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
                    Text(infoError).foregroundStyle(.red).font(.footnote)
                } else { ProgressView() }
            }
        }
        .scrollContentBackground(.hidden)
        .background(CandyBackground())
        .navigationTitle("Settings").navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func row(_ k: String, _ v: String) -> some View {
        HStack { Text(k); Spacer(); Text(v).foregroundStyle(.secondary).multilineTextAlignment(.trailing) }
    }

    private func load() async {
        info = nil; infoError = nil
        do { info = try await ParakeetAPI(server).info() } catch { infoError = error.localizedDescription }
    }
}
