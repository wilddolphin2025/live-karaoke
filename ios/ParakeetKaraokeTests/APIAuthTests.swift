import XCTest
@testable import ParakeetKaraoke

/// In-process mock server: records every request and answers by path.
final class MockServer: URLProtocol {
    nonisolated(unsafe) static var seen: [URLRequest] = []
    nonisolated(unsafe) static var status = 200
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.seen.append(request)
        let p = request.url!.path
        let body: Data
        if p.hasSuffix("/download") { body = Data(repeating: 0, count: 64) }
        else if p.hasSuffix("/v1/separate") { body = Data(#"{"job_id":"j1"}"#.utf8) }
        else if p.hasSuffix("/v1/translate") { body = Data(#"{"sentences":[{"translation":"hi"}]}"#.utf8) }
        else { body = Data(#"{"status":"done","results":{"channels":[{"alternatives":[{"words":[]}]}]}}"#.utf8) }
        var h = ["Content-Type": "application/json"]
        if p.hasSuffix("/download") { h = ["Content-Type": "audio/mpeg", "Content-Disposition": "attachment; filename=\"k.mp3\""] }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: Self.status, httpVersion: "HTTP/1.1", headerFields: h)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class APIAuthTests: XCTestCase {
    var dir: URL!
    var file: URL!
    override func setUp() {
        let c = URLSessionConfiguration.ephemeral
        c.protocolClasses = [MockServer.self]
        ParakeetAPI.session = URLSession(configuration: c)
        MockServer.seen = []; MockServer.status = 200
        dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        file = dir.appendingPathComponent("song.mp3"); try? Data([1, 2, 3]).write(to: file)
    }

    private func exerciseAll(_ api: ParakeetAPI) async throws {
        _ = try await api.info()
        _ = try await api.listen(file: file, language: "en", onWait: nil)
        _ = try await api.translate(lines: [LyricLine(id: 0, firstWord: 0, words: [Word(word: "hola", start: 0, end: 1)])], target: "en", source: nil, onWait: nil)
        _ = try await api.separate(file: file, name: "song.mp3", language: "en", onWait: nil)
        _ = try await api.job("j1")
        _ = try await api.download("j1", to: dir, isVideo: false)
        await api.deleteJob("j1")
    }

    func testBearerOnEveryEndpointAndPrefixKept() async throws {
        let api = try ParakeetAPI("https://edge.example/karaoke/", token: " secret-123 ")
        try await exerciseAll(api)
        let paths = MockServer.seen.map { $0.url!.path }
        XCTAssertEqual(paths, ["/karaoke/v1/info", "/karaoke/v1/listen", "/karaoke/v1/translate", "/karaoke/v1/separate",
                               "/karaoke/v1/jobs/j1", "/karaoke/v1/jobs/j1/download", "/karaoke/v1/jobs/j1"])
        for r in MockServer.seen {
            XCTAssertEqual(r.url!.host, "edge.example")
            XCTAssertEqual(r.value(forHTTPHeaderField: "Authorization"), "Bearer secret-123", r.url!.absoluteString)
            XCTAssertNil(r.url!.query?.range(of: "token"), "token must not be in the URL")
        }
        XCTAssertEqual(MockServer.seen.last?.httpMethod, "DELETE")
    }

    func testNoHeaderWithoutTokenAndLANBase() async throws {
        let api = try ParakeetAPI("http://192.0.2.10:30800", token: "")
        try await exerciseAll(api)
        XCTAssertEqual(MockServer.seen.first?.url?.absoluteString, "http://192.0.2.10:30800/v1/info")
        XCTAssertEqual(MockServer.seen.count, 7)
        for r in MockServer.seen { XCTAssertNil(r.value(forHTTPHeaderField: "Authorization")) }
    }

    func testUnauthorizedMessage() async throws {
        for code in [401, 403] {
            MockServer.status = code
            let api = try ParakeetAPI("https://edge.example/karaoke", token: "bad")
            do { _ = try await api.info(); XCTFail("expected error") }
            catch { XCTAssertEqual(error.localizedDescription, "Access token missing or invalid — check Settings") }
            do { _ = try await api.download("j1", to: dir, isVideo: false); XCTFail("expected error") }
            catch { XCTAssertEqual(error.localizedDescription, "Access token missing or invalid — check Settings") }
        }
    }

    func testTokenOnlyForOwnServer() throws {
        let api = try ParakeetAPI("https://edge.example/karaoke", token: "t")
        XCTAssertTrue(api.isServerURL(URL(string: "https://edge.example/karaoke/v1/jobs/x/download")!))
        XCTAssertFalse(api.isServerURL(URL(string: "https://edge.example/other")!))
        XCTAssertFalse(api.isServerURL(URL(string: "https://lrclib.net/api/get")!))
    }

    func testKeychainRoundTrip() {
        let old = AccessToken.value
        AccessToken.value = "  abc  "; XCTAssertEqual(AccessToken.value, "abc")
        AccessToken.value = ""; XCTAssertEqual(AccessToken.value, "")
        AccessToken.value = old
        XCTAssertNil(UserDefaults.standard.string(forKey: "accessToken"))
    }
}
