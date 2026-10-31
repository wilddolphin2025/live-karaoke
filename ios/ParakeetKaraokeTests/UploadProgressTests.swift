import XCTest
import Network
@testable import ParakeetKaraoke

/// A real, deliberately slow loopback HTTP server (so URLSession reports request-body progress): reads the whole body, answers JSON.
final class LoopbackServer: @unchecked Sendable {
    let listener: NWListener
    private(set) var paths: [String] = []
    private(set) var auth: [String?] = []
    private(set) var bodyBytes: [Int] = []
    private let lock = NSLock()

    init() throws {
        listener = try NWListener(using: .tcp, on: .any)
        listener.newConnectionHandler = { [weak self] c in c.start(queue: .global()); self?.read(c, Data()) }
        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { if case .ready = $0 { ready.signal() } }
        listener.start(queue: .global())
        _ = ready.wait(timeout: .now() + 5)
    }
    var port: UInt16 { listener.port!.rawValue }

    private func read(_ c: NWConnection, _ buf: Data) {
        c.receive(minimumIncompleteLength: 1, maximumLength: 32 << 10) { [weak self] d, _, done, _ in
            guard let self else { return }
            var buf = buf; if let d { buf.append(d) }
            if let r = buf.range(of: Data("\r\n\r\n".utf8)) {
                let head = String(decoding: buf[..<r.lowerBound], as: UTF8.self)
                let lines = head.components(separatedBy: "\r\n")
                func header(_ n: String) -> String? {
                    lines.first { $0.lowercased().hasPrefix(n.lowercased() + ":") }.map { String($0.dropFirst(n.count + 1)).trimmingCharacters(in: .whitespaces) }
                }
                let len = Int(header("Content-Length") ?? "0") ?? 0
                if buf.count - r.upperBound >= len {
                    let path = lines.first?.split(separator: " ").dropFirst().first.map(String.init) ?? ""
                    self.lock.lock(); self.paths.append(path); self.auth.append(header("Authorization")); self.bodyBytes.append(len); self.lock.unlock()
                    let body = path.contains("/v1/separate") ? #"{"job_id":"j1"}"#
                        : #"{"metadata":{"duration":1.0},"results":{"channels":[{"alternatives":[{"words":[{"word":"hi","start":0,"end":0.5}]}]}]}}"#
                    let resp = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n\(body)"
                    c.send(content: Data(resp.utf8), completion: .contentProcessed { _ in c.cancel() })
                    return
                }
            }
            if done { c.cancel() } else { usleep(3_000); self.read(c, buf) }  // slow reader, like a slow uplink
        }
    }
}

final class UploadProgressTests: XCTestCase {
    func testUploadProgressReportedForListenAndSeparate() async throws {
        let server = try LoopbackServer()
        defer { server.listener.cancel() }
        ParakeetAPI.session = URLSession(configuration: .ephemeral)
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("big-\(UUID()).mp3")
        let size = 8_000_000
        try Data(repeating: 7, count: size).write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }
        let api = try ParakeetAPI("http://127.0.0.1:\(server.port)/karaoke", token: "tok")

        for which in ["listen", "separate"] {
            let seen = Recorder()
            if which == "listen" {
                let r = try await api.listen(file: file, language: "en", onWait: nil) { s, t in seen.add(s, t) }
                XCTAssertEqual(r.words.count, 1)
            } else {
                let id = try await api.separate(file: file, name: "big.mp3", language: "en", onWait: nil) { s, t in seen.add(s, t) }
                XCTAssertEqual(id, "j1")
            }
            let v = seen.values
            XCTAssertGreaterThan(v.count, 1, "\(which): expected several progress callbacks")
            XCTAssertEqual(v.last?.0, Int64(size), which)
            XCTAssertEqual(v.last?.1, Int64(size), which)
            XCTAssertEqual(v.map(\.0), v.map(\.0).sorted(), "\(which): monotonic")
        }
        XCTAssertEqual(server.paths.map { String($0.split(separator: "?")[0]) }, ["/karaoke/v1/listen", "/karaoke/v1/separate"])
        XCTAssertEqual(server.auth, ["Bearer tok", "Bearer tok"])
        XCTAssertEqual(server.bodyBytes, [size, size])
    }

    func testUploadText() {
        XCTAssertEqual(BundleProgressView.uploadText("Uploading…", sent: 11_600_000, total: 27_539_178), "Uploading… 42% · 11.6 of 27.5 MB")
    }
}

final class Recorder: @unchecked Sendable {
    private let lock = NSLock(); private var v: [(Int64, Int64)] = []
    func add(_ s: Int64, _ t: Int64) { lock.lock(); v.append((s, t)); lock.unlock() }
    var values: [(Int64, Int64)] { lock.lock(); defer { lock.unlock() }; return v }
}
