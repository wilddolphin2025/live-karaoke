import Foundation

enum APIError: LocalizedError {
    case http(Int, String), badURL, gaveUp, message(String)
    var errorDescription: String? {
        switch self {
        case .http(let c, let m): return "Error \(c): \(m)"
        case .badURL: return "Invalid server URL"
        case .gaveUp: return "Server kept warming up; try again later"
        case .message(let m): return m
        }
    }
}

enum Settings {
    static let defaultServer = "http://192.168.8.226:30800"
    static var server: String { UserDefaults.standard.string(forKey: "serverURL") ?? defaultServer }
    static var language: String { UserDefaults.standard.string(forKey: "defaultLanguage") ?? "auto" }
}

struct ParakeetAPI {
    let base: URL
    init(_ s: String = Settings.server) throws {
        guard let u = URL(string: s.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "/+$", with: "", options: .regularExpression)), u.scheme != nil else { throw APIError.badURL }
        base = u
    }
    static let session: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 900
        c.timeoutIntervalForResource = 7200
        return URLSession(configuration: c)
    }()

    func url(_ path: String, _ q: [String: String] = [:]) -> URL {
        var c = URLComponents(url: base.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !q.isEmpty { c.queryItems = q.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) } }
        return c.url!
    }

    static func errMsg(_ d: Data) -> String {
        if let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any], let m = j["err_msg"] as? String { return m }
        return String(decoding: d.prefix(200), as: UTF8.self)
    }

    /// Sends a request, retrying 503 + Retry-After (translator warming up / busy).
    func send(_ req: URLRequest, file: URL? = nil, body: Data? = nil, onWait: ((String) -> Void)? = nil) async throws -> (Data, HTTPURLResponse) {
        for attempt in 1...20 {
            let (d, r): (Data, URLResponse)
            if let file { (d, r) = try await Self.session.upload(for: req, fromFile: file) }
            else if let body { (d, r) = try await Self.session.upload(for: req, from: body) }
            else { (d, r) = try await Self.session.data(for: req) }
            guard let h = r as? HTTPURLResponse else { throw APIError.message("No HTTP response") }
            if h.statusCode == 503 {
                let wait = min(60, max(3, Double(h.value(forHTTPHeaderField: "Retry-After") ?? "") ?? 15))
                await MainActor.run { onWait?("Server warming up — retry \(attempt) in \(Int(wait))s") }
                try await Task.sleep(for: .seconds(wait))
                continue
            }
            guard (200..<300).contains(h.statusCode) else { throw APIError.http(h.statusCode, Self.errMsg(d)) }
            return (d, h)
        }
        throw APIError.gaveUp
    }

    static func mime(_ f: URL) -> String {
        switch f.pathExtension.lowercased() {
        case "mp3": return "audio/mpeg"; case "m4a", "aac": return "audio/mp4"; case "wav": return "audio/wav"
        case "flac": return "audio/flac"; case "ogg", "opus": return "audio/ogg"; case "mp4", "m4v": return "video/mp4"
        case "mov": return "video/quicktime"; case "webm": return "video/webm"; default: return "application/octet-stream"
        }
    }

    static func decodeWords(_ any: Any?) -> [Word] {
        guard let a = any, let d = try? JSONSerialization.data(withJSONObject: a) else { return [] }
        return (try? JSONDecoder().decode([Word].self, from: d)) ?? []
    }

    struct ListenResult { var words: [Word]; var duration: Double; var detected: String? }
    func listen(file: URL, language: String, onWait: ((String) -> Void)?) async throws -> ListenResult {
        var r = URLRequest(url: url("v1/listen", ["language": language, "paragraphs": "true", "punctuate": "true"]))
        r.httpMethod = "POST"
        r.setValue(Self.mime(file), forHTTPHeaderField: "Content-Type")
        let (d, _) = try await send(r, file: file, onWait: onWait)
        let j = try JSONSerialization.jsonObject(with: d) as? [String: Any] ?? [:]
        let ch = ((j["results"] as? [String: Any])?["channels"] as? [[String: Any]])?.first
        let alt = (ch?["alternatives"] as? [[String: Any]])?.first
        let dur = (j["metadata"] as? [String: Any])?["duration"] as? Double ?? 0
        return ListenResult(words: Self.decodeWords(alt?["words"]), duration: dur, detected: ch?["detected_language"] as? String)
    }

    func separate(file: URL, name: String, language: String, onWait: ((String) -> Void)?) async throws -> String {
        var r = URLRequest(url: url("v1/separate", ["language": language]))
        r.httpMethod = "POST"
        r.setValue(Self.mime(file), forHTTPHeaderField: "Content-Type")
        r.setValue(name.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "file", forHTTPHeaderField: "X-Filename")
        let (d, _) = try await send(r, file: file, onWait: onWait)
        let j = try JSONSerialization.jsonObject(with: d) as? [String: Any] ?? [:]
        guard let id = j["job_id"] as? String else { throw APIError.message("No job_id in response") }
        return id
    }

    func job(_ id: String) async throws -> [String: Any] {
        let (d, _) = try await send(URLRequest(url: url("v1/jobs/\(id)")))
        return try JSONSerialization.jsonObject(with: d) as? [String: Any] ?? [:]
    }

    func download(_ id: String, to dir: URL, isVideo: Bool) async throws -> String {
        let (tmp, r) = try await Self.session.download(for: URLRequest(url: url("v1/jobs/\(id)/download")))
        guard let h = r as? HTTPURLResponse, h.statusCode == 200 else { throw APIError.http((r as? HTTPURLResponse)?.statusCode ?? 0, "download failed") }
        var ext = (h.suggestedFilename as NSString?)?.pathExtension ?? ""
        if ext.isEmpty { ext = isVideo ? "mp4" : "mp3" }
        let name = "karaoke.\(ext)"
        let dest = dir.appendingPathComponent(name)
        try? FileManager.default.removeItem(at: dest)
        try FileManager.default.moveItem(at: tmp, to: dest)
        return name
    }

    func deleteJob(_ id: String) async {
        var r = URLRequest(url: url("v1/jobs/\(id)")); r.httpMethod = "DELETE"
        _ = try? await Self.session.data(for: r)
    }

    func translate(lines: [LyricLine], target: String, source: String?, onWait: ((String) -> Void)?) async throws -> [String] {
        var r = URLRequest(url: url("v1/translate")); r.httpMethod = "POST"
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any] = ["target": target, "source": source ?? "auto",
            "sentences": lines.map { ["text": $0.text, "start": $0.start, "end": $0.end] }]
        let (d, _) = try await send(r, body: try JSONSerialization.data(withJSONObject: body), onWait: onWait)
        let j = try JSONSerialization.jsonObject(with: d) as? [String: Any] ?? [:]
        let s = j["sentences"] as? [[String: Any]] ?? []
        return lines.indices.map { i in i < s.count ? (s[i]["translation"] as? String ?? "") : "" }
    }

    func info() async throws -> [String: Any] {
        let (d, _) = try await send(URLRequest(url: url("v1/info")))
        return try JSONSerialization.jsonObject(with: d) as? [String: Any] ?? [:]
    }
}
