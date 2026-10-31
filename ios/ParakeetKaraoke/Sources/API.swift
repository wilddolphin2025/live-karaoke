import Foundation

enum APIError: LocalizedError {
    static let authMessage = "Access token missing or invalid — check Settings"
    /// 401/403 from the server (or an edge in front of it) means the access token is missing or wrong.
    static func check(_ status: Int, _ body: Data = Data(), _ fallback: String? = nil) throws {
        if status == 401 || status == 403 { throw APIError.unauthorized }
        if !(200..<300).contains(status) { throw APIError.http(status, fallback ?? ParakeetAPI.errMsg(body)) }
    }
    case http(Int, String), badURL, gaveUp, message(String), unauthorized
    var errorDescription: String? {
        switch self {
        case .http(let c, let m): return "Error \(c): \(m)"
        case .badURL: return "Invalid server URL"
        case .gaveUp: return "Server kept warming up; try again later"
        case .message(let m): return m
        case .unauthorized: return APIError.authMessage
        }
    }
}

enum Settings {
    /// From LK_DEFAULT_SERVER in ios/Local.xcconfig (Info.plist LKDefaultServer); empty means "set it in Settings".
    static let defaultServer = (Bundle.main.object(forInfoDictionaryKey: "LKDefaultServer") as? String ?? "").trimmingCharacters(in: .whitespaces)
    static var server: String { UserDefaults.standard.string(forKey: "serverURL") ?? defaultServer }
    static var language: String { UserDefaults.standard.string(forKey: "defaultLanguage") ?? "auto" }
}

/// All requests to the Live Karaoke server go through `ParakeetAPI.request(_:_:)`, which adds the
/// optional `Authorization: Bearer` header. The base URL may carry a path prefix
/// (e.g. `https://edge.example/karaoke`): paths are appended to it, never resolved against the host root.
struct ParakeetAPI {
    let base: URL
    let token: String
    init(_ s: String = Settings.server, token: String = AccessToken.value) throws {
        self.token = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let u = URL(string: s.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "/+$", with: "", options: .regularExpression)), u.scheme != nil else { throw APIError.badURL }
        base = u
    }
    /// Replaceable for tests (mock URLProtocol).
    nonisolated(unsafe) static var session: URLSession = {
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

    /// A request for `path` (relative to the base, e.g. "v1/info") carrying the access token, if any.
    func request(_ path: String, _ q: [String: String] = [:], method: String = "GET") -> URLRequest {
        var r = URLRequest(url: url(path, q)); r.httpMethod = method
        Self.authorize(&r, token: token)
        return r
    }
    /// Adds `Authorization: Bearer <token>` unless the token is empty.
    static func authorize(_ r: inout URLRequest, token: String) {
        let t = token.trimmingCharacters(in: .whitespacesAndNewlines)
        if !t.isEmpty { r.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization") }
    }
    /// Whether `u` points at this server (same scheme, host and port, under the base path): only then may it carry the token.
    func isServerURL(_ u: URL) -> Bool {
        u.scheme == base.scheme && u.host?.lowercased() == base.host?.lowercased() && u.port == base.port
            && (u.path + "/").hasPrefix(base.path.hasSuffix("/") ? base.path : base.path + "/")
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
            try APIError.check(h.statusCode, d)
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
        var r = request("v1/listen", ["language": language, "paragraphs": "true", "punctuate": "true"], method: "POST")
        r.setValue(Self.mime(file), forHTTPHeaderField: "Content-Type")
        let (d, _) = try await send(r, file: file, onWait: onWait)
        let j = try JSONSerialization.jsonObject(with: d) as? [String: Any] ?? [:]
        let ch = ((j["results"] as? [String: Any])?["channels"] as? [[String: Any]])?.first
        let alt = (ch?["alternatives"] as? [[String: Any]])?.first
        let dur = (j["metadata"] as? [String: Any])?["duration"] as? Double ?? 0
        return ListenResult(words: Self.decodeWords(alt?["words"]), duration: dur, detected: ch?["detected_language"] as? String)
    }

    func separate(file: URL, name: String, language: String, onWait: ((String) -> Void)?) async throws -> String {
        var r = request("v1/separate", ["language": language], method: "POST")
        r.setValue(Self.mime(file), forHTTPHeaderField: "Content-Type")
        r.setValue(name.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "file", forHTTPHeaderField: "X-Filename")
        let (d, _) = try await send(r, file: file, onWait: onWait)
        let j = try JSONSerialization.jsonObject(with: d) as? [String: Any] ?? [:]
        guard let id = j["job_id"] as? String else { throw APIError.message("No job_id in response") }
        return id
    }

    func job(_ id: String) async throws -> [String: Any] {
        let (d, _) = try await send(request("v1/jobs/\(id)"))
        return try JSONSerialization.jsonObject(with: d) as? [String: Any] ?? [:]
    }

    func download(_ id: String, to dir: URL, isVideo: Bool) async throws -> String {
        let (tmp, r) = try await Self.session.download(for: request("v1/jobs/\(id)/download"))
        guard let h = r as? HTTPURLResponse else { throw APIError.message("No HTTP response") }
        try APIError.check(h.statusCode, Data(), "download failed")
        var ext = (h.suggestedFilename as NSString?)?.pathExtension ?? ""
        if ext.isEmpty { ext = isVideo ? "mp4" : "mp3" }
        let name = "karaoke.\(ext)"
        let dest = dir.appendingPathComponent(name)
        try? FileManager.default.removeItem(at: dest)
        try FileManager.default.moveItem(at: tmp, to: dest)
        return name
    }

    func deleteJob(_ id: String) async {
        let r = request("v1/jobs/\(id)", method: "DELETE")
        _ = try? await Self.session.data(for: r)
    }

    func translate(lines: [LyricLine], target: String, source: String?, onWait: ((String) -> Void)?) async throws -> [String] {
        var r = request("v1/translate", method: "POST")
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any] = ["target": target, "source": source ?? "auto",
            "sentences": lines.map { ["text": $0.text, "start": $0.start, "end": $0.end] }]
        let (d, _) = try await send(r, body: try JSONSerialization.data(withJSONObject: body), onWait: onWait)
        let j = try JSONSerialization.jsonObject(with: d) as? [String: Any] ?? [:]
        let s = j["sentences"] as? [[String: Any]] ?? []
        return lines.indices.map { i in i < s.count ? (s[i]["translation"] as? String ?? "") : "" }
    }

    func info() async throws -> [String: Any] {
        let (d, _) = try await send(request("v1/info"))
        return try JSONSerialization.jsonObject(with: d) as? [String: Any] ?? [:]
    }
}
