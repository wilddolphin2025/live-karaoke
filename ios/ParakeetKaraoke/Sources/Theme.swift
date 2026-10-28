import SwiftUI

enum Candy {
    static let pink = Color(red: 1.0, green: 0.45, blue: 0.70)
    static let peach = Color(red: 1.0, green: 0.72, blue: 0.55)
    static let lemon = Color(red: 1.0, green: 0.90, blue: 0.45)
    static let mint = Color(red: 0.45, green: 0.90, blue: 0.75)
    static let sky = Color(red: 0.50, green: 0.75, blue: 1.0)
    static let lilac = Color(red: 0.72, green: 0.58, blue: 1.0)
    static let palette: [Color] = [pink, peach, lemon, mint, sky, lilac]
    static let sung = LinearGradient(colors: [pink, lilac], startPoint: .leading, endPoint: .trailing)
    static func gradient(_ seed: Int) -> LinearGradient {
        let a = palette[abs(seed) % palette.count], b = palette[(abs(seed) + 2) % palette.count]
        return LinearGradient(colors: [a, b], startPoint: .topLeading, endPoint: .bottomTrailing)
    }
}

struct CandyBackground: View {
    @Environment(\.colorScheme) var scheme
    @State private var animate = false
    var body: some View {
        ZStack {
            (scheme == .dark ? Color(red: 0.10, green: 0.07, blue: 0.16) : Color(red: 1.0, green: 0.97, blue: 0.99))
            ForEach(0..<4) { i in
                Circle().fill(Candy.palette[i + 1].opacity(scheme == .dark ? 0.28 : 0.45))
                    .frame(width: 320, height: 320).blur(radius: 70)
                    .offset(x: animate ? CGFloat([-120, 140, -60, 110][i]) : CGFloat([100, -130, 90, -80][i]),
                            y: animate ? CGFloat([-260, -80, 220, 340][i]) : CGFloat([-180, 40, 300, 200][i]))
            }
        }
        .ignoresSafeArea()
        .onAppear { withAnimation(.easeInOut(duration: 9).repeatForever(autoreverses: true)) { animate = true } }
    }
}

struct BubbleButtonStyle: ButtonStyle {
    var colors: [Color] = [Candy.pink, Candy.lilac]
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline.weight(.bold)).foregroundStyle(.white)
            .padding(.horizontal, 20).padding(.vertical, 14)
            .background(Capsule().fill(LinearGradient(colors: colors, startPoint: .topLeading, endPoint: .bottomTrailing)))
            .overlay(Capsule().stroke(.white.opacity(0.5), lineWidth: 1.5).blendMode(.overlay))
            .shadow(color: colors.first!.opacity(0.45), radius: configuration.isPressed ? 3 : 10, y: configuration.isPressed ? 1 : 5)
            .scaleEffect(configuration.isPressed ? 0.92 : 1)
            .animation(.spring(response: 0.3, dampingFraction: 0.5), value: configuration.isPressed)
    }
}

struct RoundBubbleStyle: ButtonStyle {
    var color: Color = Candy.pink
    var size: CGFloat = 54
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: size * 0.4, weight: .bold)).foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(Circle().fill(LinearGradient(colors: [color, color.opacity(0.7)], startPoint: .top, endPoint: .bottom)))
            .shadow(color: color.opacity(0.5), radius: configuration.isPressed ? 2 : 8, y: 4)
            .scaleEffect(configuration.isPressed ? 0.88 : 1)
            .animation(.spring(response: 0.25, dampingFraction: 0.45), value: configuration.isPressed)
    }
}

extension View {
    func candyCard() -> some View {
        self.padding(14)
            .background(RoundedRectangle(cornerRadius: 24, style: .continuous).fill(.ultraThinMaterial))
            .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).stroke(.white.opacity(0.35), lineWidth: 1))
    }
}

enum TextSize: String, CaseIterable, Identifiable {
    case small, medium, large, huge, giant
    var id: String { rawValue }
    var points: CGFloat { switch self { case .small: 18; case .medium: 24; case .large: 30; case .huge: 38; case .giant: 48 } }
    var label: String { rawValue.capitalized }
}

func formatTime(_ t: Double) -> String {
    guard t.isFinite, t >= 0 else { return "0:00" }
    let s = Int(t); return String(format: "%d:%02d", s / 60, s % 60)
}
