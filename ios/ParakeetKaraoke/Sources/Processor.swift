import Foundation
import SwiftData
import AVFoundation
import UIKit

@MainActor
final class Processor {
    static let shared = Processor()
    private var tasks: [UUID: Task<Void, Never>] = [:]

    func isRunning(_ id: UUID) -> Bool { tasks[id] != nil }

    /// Create a bundle from a local file (security-scoped URL from the document picker).
    func importFile(_ src: URL, title: String?, language: String, context: ModelContext) throws -> KaraokeBundle {
        let scoped = src.startAccessingSecurityScopedResource()
        defer { if scoped { src.stopAccessingSecurityScopedResource() } }
        let ext = src.pathExtension.isEmpty ? "mp3" : src.pathExtension.lowercased()
        let b = KaraokeBundle(title: title?.nilIfBlank ?? src.deletingPathExtension().lastPathComponent,
                              originalFile: "original.\(ext)", isVideo: Storage.isVideo(src), language: language)
        var err: NSError?
        var copyErr: Error?
        NSFileCoordinator().coordinate(readingItemAt: src, options: .withoutChanges, error: &err) { u in
            do { try FileManager.default.copyItem(at: u, to: b.originalURL) } catch { copyErr = error }
        }
        if let e = err ?? copyErr as NSError? { try? FileManager.default.removeItem(at: b.dir); throw e }
        context.insert(b)
        try? context.save()
        start(b, context: context)
        return b
    }

    /// Create a bundle from an online URL (downloaded first).
    func importURL(_ remote: URL, title: String?, language: String, context: ModelContext) -> KaraokeBundle {
        let ext = remote.pathExtension.isEmpty ? "mp4" : remote.pathExtension.lowercased()
        let b = KaraokeBundle(title: title?.nilIfBlank ?? remote.deletingPathExtension().lastPathComponent.removingPercentEncoding ?? "Song",
                              originalFile: "original.\(ext)", isVideo: Storage.isVideo(remote), language: language)
        b.sourceURL = remote.absoluteString
        b.statusText = "Downloading source…"
        context.insert(b)
        try? context.save()
        start(b, context: context)
        return b
    }

    func start(_ b: KaraokeBundle, context: ModelContext) {
        guard tasks[b.id] == nil else { return }
        let id = b.id
        tasks[id] = Task { [weak self] in
            await self?.run(b, context: context)
            self?.tasks[id] = nil
        }
    }

    func cancel(_ b: KaraokeBundle) {
        tasks[b.id]?.cancel(); tasks[b.id] = nil
        if let j = b.jobId, let api = try? ParakeetAPI() { Task { await api.deleteJob(j) } }
    }

    private func set(_ b: KaraokeBundle, _ s: BundleStatus, _ text: String, _ p: Double, _ ctx: ModelContext) {
        b.status = s; b.statusText = text; b.progress = p; try? ctx.save()
    }

    private func run(_ b: KaraokeBundle, context ctx: ModelContext) async {
        do {
            let api = try ParakeetAPI()
            b.errorText = nil
            // 0. Download the source if it came from a URL.
            if !FileManager.default.fileExists(atPath: b.originalURL.path), let s = b.sourceURL, let u = URL(string: s) {
                set(b, .importing, "Downloading source…", 0.02, ctx)
                let (tmp, r) = try await ParakeetAPI.session.download(from: u)
                if let h = r as? HTTPURLResponse, !(200..<300).contains(h.statusCode) { throw APIError.http(h.statusCode, "source download failed") }
                if let mt = r.mimeType, mt.hasPrefix("video") { b.isVideo = true }
                try FileManager.default.moveItem(at: tmp, to: b.originalURL)
            }
            await fillMetadata(b)
            try? ctx.save()
            let wait: (String) -> Void = { [weak b] m in b?.statusText = m }
            // 1. Transcript of the original (normal highlight).
            if b.originalWords.isEmpty {
                set(b, .transcribing, "Transcribing…", 0.05, ctx)
                let res = try await api.listen(file: b.originalURL, language: b.language, onWait: wait)
                b.originalWords = res.words
                if b.duration <= 0 { b.duration = res.duration }
                b.detectedLanguage = res.detected
                try? ctx.save()
            }
            try Task.checkCancellation()
            // 2. Vocal removal job + vocals-stem transcript.
            if b.karaokeFile == nil {
                if b.jobId == nil {
                    set(b, .separating, "Uploading for vocal removal…", 0.1, ctx)
                    b.jobId = try await api.separate(file: b.originalURL, name: b.originalFile, language: b.language, onWait: wait)
                    try? ctx.save()
                }
                var misses = 0
                while true {
                    try await Task.sleep(for: .seconds(2))
                    let j: [String: Any]
                    do { j = try await api.job(b.jobId!) } catch APIError.http(404, _) {
                        b.jobId = nil; throw APIError.message("Job expired on the server — tap retry")
                    } catch { misses += 1; if misses > 15 { throw error }; continue }
                    misses = 0
                    let st = j["status"] as? String ?? "queued"
                    let p = (j["progress"] as? Double) ?? 0
                    let stage = j["stage"] as? String
                    let dev = (j["device"] as? String).map { " on \($0.uppercased())" } ?? ""
                    switch st {
                    case "failed", "cancelled":
                        let m = (j["error"] as? [String: Any])?["err_msg"] as? String ?? st
                        b.jobId = nil; throw APIError.message("Vocal removal failed: \(m)")
                    case "done":
                        let r = j["result"] as? [String: Any]
                        b.vocalsWords = ParakeetAPI.decodeWords(r?["words"])
                        if let v = j["is_video"] as? Bool { b.isVideo = v }
                        set(b, .downloading, "Downloading instrumental…", 0.95, ctx)
                        b.karaokeFile = try await api.download(b.jobId!, to: b.dir, isVideo: b.isVideo)
                        await api.deleteJob(b.jobId!)
                        b.jobId = nil
                    case "transcribing": set(b, .separating, "Transcribing the singer… \(Int(p * 100))%", 0.1 + 0.85 * p, ctx)
                    case "muxing": set(b, .separating, "Writing the karaoke file… \(Int(p * 100))%", 0.1 + 0.85 * p, ctx)
                    case "separating": set(b, .separating, "Removing vocals\(dev)… \(Int(p * 100))%", 0.1 + 0.85 * p, ctx)
                    default: set(b, .separating, "Queued: \(stage ?? st)…", 0.1, ctx)
                    }
                    if b.karaokeFile != nil { break }
                }
            }
            set(b, .ready, "Ready to sing", 1, ctx)
        } catch is CancellationError {
            set(b, .error, "Cancelled", b.progress, ctx)
        } catch {
            b.errorText = error.localizedDescription
            set(b, .error, error.localizedDescription, b.progress, ctx)
        }
    }

    func fillMetadata(_ b: KaraokeBundle) async {
        let asset = AVURLAsset(url: b.originalURL)
        if let d = try? await asset.load(.duration), d.seconds.isFinite { b.duration = d.seconds }
        if let tracks = try? await asset.loadTracks(withMediaType: .video), !tracks.isEmpty { b.isVideo = true }
        if b.thumbnail == nil {
            if b.isVideo {
                let g = AVAssetImageGenerator(asset: asset); g.appliesPreferredTrackTransform = true
                g.maximumSize = CGSize(width: 400, height: 400)
                if let (cg, _) = try? await g.image(at: CMTime(seconds: min(5, b.duration / 3), preferredTimescale: 600)) {
                    b.thumbnail = UIImage(cgImage: cg).jpegData(compressionQuality: 0.8)
                }
            } else if let meta = try? await asset.load(.commonMetadata) {
                for item in meta where item.commonKey == .commonKeyArtwork {
                    if let d = try? await item.load(.dataValue) { b.thumbnail = d; break }
                }
            }
        }
    }

    /// Translate the shown lines. `lines`/`variant` override the transcript (e.g. lyrics from an add-on).
    func translate(_ b: KaraokeBundle, karaoke: Bool, target: String, lines shown: [LyricLine]? = nil, variant: String = "",
                   onStatus: @escaping (String?) -> Void) async {
        let key = "\(variant)\(karaoke ? "k" : "o")|\(target)"
        if b.translations[key] != nil { return }
        let lines = shown ?? Lyrics.lines(karaoke ? b.vocalsWords : b.originalWords)
        guard !lines.isEmpty, let api = try? ParakeetAPI() else { return }
        var out = [String]()
        do {
            onStatus("Translating…")
            for chunkStart in stride(from: 0, to: lines.count, by: 8) {
                let chunk = Array(lines[chunkStart..<min(lines.count, chunkStart + 8)])
                out += try await api.translate(lines: chunk, target: target, source: b.detectedLanguage ?? (b.language == "auto" ? nil : b.language), onWait: { onStatus($0) })
                onStatus("Translating… \(out.count)/\(lines.count)")
                var t = b.translations; t[key] = out + Array(repeating: "", count: lines.count - out.count); b.translations = t
            }
            onStatus(nil)
        } catch { var t = b.translations; t[key] = nil; b.translations = t; onStatus("Translation failed: \(error.localizedDescription)") }
    }

    static func deleteFiles(_ b: KaraokeBundle) { try? FileManager.default.removeItem(at: b.dir) }
}

extension String {
    var nilIfBlank: String? { let t = trimmingCharacters(in: .whitespacesAndNewlines); return t.isEmpty ? nil : t }
}
