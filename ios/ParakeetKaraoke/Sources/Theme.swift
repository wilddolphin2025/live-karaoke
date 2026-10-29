import SwiftUI

/// Appearance override from Settings. `.system` follows the device light/dark setting.
enum Appearance: String, CaseIterable, Identifiable {
    case system, light, dark
    var id: String { rawValue }
    var label: String { switch self { case .system: "System"; case .light: "Light"; case .dark: "Dark" } }
    var colorScheme: ColorScheme? { switch self { case .system: nil; case .light: .light; case .dark: .dark } }
}

/// Lyric text size: a relative multiplier on top of Dynamic Type (the base size scales with the
/// user's text size setting, including accessibility sizes).
enum LyricScale {
    static let key = "lyricScale"
    static let range: ClosedRange<Double> = 0.8...1.6
    static let `default` = 1.0
}

func formatTime(_ t: Double) -> String {
    guard t.isFinite, t >= 0 else { return "0:00" }
    let s = Int(t); return String(format: "%d:%02d", s / 60, s % 60)
}

func spokenTime(_ t: Double) -> String {
    guard t.isFinite, t >= 0 else { return "0 seconds" }
    let s = Int(t)
    return s >= 60 ? "\(s / 60) minutes \(s % 60) seconds" : "\(s) seconds"
}
