import Foundation
import SwiftData

struct Word: Codable, Hashable {
    var word: String
    var start: Double
    var end: Double
    var punctuated_word: String?
    var text: String { punctuated_word ?? word }
}

struct LyricLine: Identifiable, Hashable {
    let id: Int
    let firstWord: Int
    let words: [Word]
    var start: Double { words.first?.start ?? 0 }
    var end: Double { words.last?.end ?? 0 }
    var text: String { words.map(\.text).joined(separator: " ") }
}

enum BundleStatus: String, Codable {
    case importing, transcribing, separating, downloading, ready, error
}

@Model
final class KaraokeBundle {
    @Attribute(.unique) var id: UUID
    var title: String
    var createdAt: Date
    var originalFile: String
    var karaokeFile: String?
    var isVideo: Bool
    var duration: Double
    var language: String
    var detectedLanguage: String?
    var statusRaw: String
    var progress: Double
    var statusText: String
    var errorText: String?
    var jobId: String?
    var sourceURL: String?
    @Attribute(.externalStorage) var thumbnail: Data?
    var originalWordsData: Data?
    var vocalsWordsData: Data?
    var translationsData: Data?   // [String: [String]]  key "[variant]mode|target" -> one per line
    var artist: String? = nil
    /// The user marked the original as music (enables music-only features without a karaoke stem).
    var markedAsMusic: Bool = false
    /// Live upload state (bytes) while a file is being sent to the server; 0 when not uploading.
    var uploadSent: Int64 = 0
    var uploadTotal: Int64 = 0
    /// Upload finished, waiting for the server's answer (indeterminate).
    var serverWaiting: Bool = false

    init(title: String, originalFile: String, isVideo: Bool, language: String) {
        self.id = UUID()
        self.title = title
        self.createdAt = .now
        self.originalFile = originalFile
        self.isVideo = isVideo
        self.duration = 0
        self.language = language
        self.statusRaw = BundleStatus.importing.rawValue
        self.progress = 0
        self.statusText = "Queued"
    }

    var status: BundleStatus {
        get { BundleStatus(rawValue: statusRaw) ?? .error }
        set { statusRaw = newValue.rawValue }
    }
    var dir: URL { Storage.dir(for: id) }
    var originalURL: URL { dir.appendingPathComponent(originalFile) }
    var karaokeURL: URL? { karaokeFile.map { dir.appendingPathComponent($0) } }

    var originalWords: [Word] {
        get { originalWordsData.flatMap { try? JSONDecoder().decode([Word].self, from: $0) } ?? [] }
        set { originalWordsData = try? JSONEncoder().encode(newValue) }
    }
    var vocalsWords: [Word] {
        get { vocalsWordsData.flatMap { try? JSONDecoder().decode([Word].self, from: $0) } ?? [] }
        set { vocalsWordsData = try? JSONEncoder().encode(newValue) }
    }
    var translations: [String: [String]] {
        get { translationsData.flatMap { try? JSONDecoder().decode([String: [String]].self, from: $0) } ?? [:] }
        set { translationsData = try? JSONEncoder().encode(newValue) }
    }
}

enum Storage {
    static var root: URL {
        let u = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Bundles", isDirectory: true)
        try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        return u
    }
    static func dir(for id: UUID) -> URL {
        let u = root.appendingPathComponent(id.uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        return u
    }
    static let videoExts: Set<String> = ["mp4", "mov", "m4v", "webm", "mkv", "avi", "3gp"]
    static func isVideo(_ url: URL) -> Bool { videoExts.contains(url.pathExtension.lowercased()) }
}

enum Lyrics {
    /// Group words into singable lines: break on sentence punctuation, long pauses, or length.
    static func lines(_ words: [Word]) -> [LyricLine] {
        var out: [LyricLine] = []
        var cur: [Word] = []
        var first = 0
        for (i, w) in words.enumerated() {
            if cur.isEmpty { first = i }
            cur.append(w)
            let t = w.text
            let next = i + 1 < words.count ? words[i + 1] : nil
            let gap = next.map { $0.start - w.end } ?? 99
            let endPunct = t.hasSuffix(".") || t.hasSuffix("!") || t.hasSuffix("?") || t.hasSuffix("…")
            let softPunct = t.hasSuffix(",") || t.hasSuffix(";") || t.hasSuffix(":")
            if next == nil || gap > 0.9 || endPunct || (softPunct && cur.count >= 4) || cur.count >= 9 {
                out.append(LyricLine(id: out.count, firstWord: first, words: cur))
                cur = []
            }
        }
        return out
    }

    /// Index of the word to highlight at time t (port of the extension's wordAt), -1 in a pause.
    /// Lines from pre-grouped words (e.g. lyrics with known line breaks).
    static func lines(grouped: [[Word]]) -> [LyricLine] {
        var out: [LyricLine] = [], first = 0
        for g in grouped where !g.isEmpty { out.append(LyricLine(id: out.count, firstWord: first, words: g)); first += g.count }
        return out
    }

    static func wordAt(_ words: [Word], t: Double, lead: Double, pause: Double = 0.3) -> Int {
        let x = t + lead
        var i = -1, lo = 0, hi = words.count - 1
        while lo <= hi { let m = (lo + hi) / 2; if words[m].start <= x { i = m; lo = m + 1 } else { hi = m - 1 } }
        if i >= 0 && t > words[i].end + pause { return -1 }
        return i
    }
    static func lastStarted(_ words: [Word], t: Double, lead: Double) -> Int {
        var i = -1, lo = 0, hi = words.count - 1
        while lo <= hi { let m = (lo + hi) / 2; if words[m].start <= t + lead { i = m; lo = m + 1 } else { hi = m - 1 } }
        return i
    }
}

struct Lang { let code: String; let name: String }
enum Langs {
    static let source = ["auto","bg","cs","da","de","el","en","es","et","fi","fr","hr","hu","it","lt","lv","mt","nl","pl","pt","ro","ru","sk","sl","sv","uk"]
    static let targets: [Lang] = ([("en","English"),("ru","Russian"),("es","Spanish"),("fr","French"),("de","German"),("it","Italian"),("pt","Portuguese"),("pt-br","Portuguese (Brazil)"),("uk","Ukrainian"),("pl","Polish"),("nl","Dutch"),("tr","Turkish"),("ar","Arabic"),("he","Hebrew"),("hi","Hindi"),("ja","Japanese"),("ko","Korean"),("zh","Chinese (Simplified)"),("zh-tw","Chinese (Traditional)"),("vi","Vietnamese"),("th","Thai"),("id","Indonesian"),("sv","Swedish"),("no","Norwegian"),("da","Danish"),("fi","Finnish"),("cs","Czech"),("el","Greek"),("hu","Hungarian"),("ro","Romanian"),("bg","Bulgarian"),("sr","Serbian"),("hr","Croatian")] as [(String, String)]).map { Lang(code: $0.0, name: $0.1) }
    static func name(_ c: String) -> String { targets.first { $0.code == c }?.name ?? c }
    /// Localized display name for a source language code ("auto" -> "Auto-Detect").
    static func sourceName(_ c: String) -> String {
        c == "auto" ? "Auto-Detect" : (Locale.current.localizedString(forLanguageCode: c) ?? c.uppercased())
    }
}
