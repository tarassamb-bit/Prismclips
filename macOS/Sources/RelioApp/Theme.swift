import SwiftUI
import CoreText

/// Prism brand tokens, from the Prism design system. Each token follows the window's dark or light appearance.
enum Prism {
    static let ink = Color(hex: 0x0E0F14)
    static let paper = Color(hex: 0xF6F3EC)
    /// Page background.
    static let surface0 = Color(dark: 0x0E0F14, light: 0xF6F3EC)
    /// Cards.
    static let surface1 = Color(dark: 0x171920, light: 0xFFFFFF)
    /// Panels, inputs, hover fills. The light value is not in the brand spec, which leaves it equal to the page.
    static let surface2 = Color(dark: 0x20232B, light: 0xEDE9E0)
    /// 1px outlines and dividers.
    static let border = Color(dark: 0x2C2F37, light: 0xE2DED4)
    static let text = Color(dark: 0xF6F3EC, light: 0x0E0F14)
    /// The spec's #8A8F98 is about 3:1 on Paper, so light mode uses a darker gray that reaches 4.5:1.
    static let textSecondary = Color(dark: 0x8A8F98, light: 0x5C6068)
    /// Button and selected fills, in both themes. Ink text sits on it.
    static let action = Color(hex: 0x3FA9F5)
    /// The action color as text, icons, outlines and underlines; Sky is too light for those on Paper.
    static let accent = Color(dark: 0x3FA9F5, light: 0x0B6CB5)
    /// Spectrum accents: one at a time, for status or a category; all together only in the mark.
    static let coral = Color(hex: 0xFF6B57)
    /// Status and warnings. Amber text needs a darker shade to be readable on Paper.
    static let amber = Color(dark: 0xFFC233, light: 0x8F5E00)
    static let sky = Color(hex: 0x3FA9F5)

    enum Weight { case regular, medium }

    /// Space Grotesk 500: headlines, the wordmark, numbers.
    static func display(_ size: CGFloat) -> Font { .custom("SpaceGrotesk-Medium", fixedSize: size) }
    /// Sora 400/500: interface text and buttons.
    static func text(_ size: CGFloat, _ weight: Weight = .regular) -> Font {
        .custom(weight == .medium ? "Sora-Medium" : "Sora-Regular", fixedSize: size)
    }
    /// JetBrains Mono: timecodes and durations.
    static func mono(_ size: CGFloat, _ weight: Weight = .regular) -> Font {
        .custom(weight == .medium ? "JetBrainsMono-Medium" : "JetBrainsMono-Regular", fixedSize: size)
    }

    /// The fonts ship in the app bundle's Resources/Fonts; outside the app (tests) the system font is used.
    static func registerFonts() {
        guard let urls = Bundle.main.urls(forResourcesWithExtension: "ttf", subdirectory: "Fonts") else { return }
        CTFontManagerRegisterFontURLs(urls as CFArray, .process, true, nil)
    }
}

private extension Color {
    init(hex: UInt32) { self.init(nsColor: NSColor(hex: hex)) }
    /// Resolves per window appearance, so switching dark and light needs no view changes.
    init(dark: UInt32, light: UInt32) {
        self.init(nsColor: NSColor(name: nil) { appearance in
            NSColor(hex: appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light)
        })
    }
}

private extension NSColor {
    convenience init(hex: UInt32) {
        self.init(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                  blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
}

/// The app's appearance setting. System follows macOS light and dark mode, and is the default.
enum PrismAppearance: String, CaseIterable, Identifiable {
    case system, dark, light
    var id: String { rawValue }
    var title: String { switch self { case .system: "System"; case .dark: "Dark"; case .light: "Light" } }
    /// nil lets the window follow macOS.
    var colorScheme: ColorScheme? { switch self { case .system: nil; case .dark: .dark; case .light: .light } }
    var icon: String { switch self { case .system: "circle.lefthalf.filled"; case .dark: "moon.fill"; case .light: "sun.max.fill" } }
    static let storageKey = "appearance"
}

/// The appearance switch for the top-right corner: Dark and Light as icon segments in a pill.
struct AppearanceSwitch: View {
    @Binding var selection: PrismAppearance
    var body: some View {
        HStack(spacing: 2) {
            // Dark and Light only; until one is picked Prism follows macOS.
            ForEach([PrismAppearance.dark, .light]) { option in
                let selected = selection == option
                Button { selection = option } label: {
                    Image(systemName: option.icon)
                        .font(Prism.text(12, .medium))
                        .foregroundStyle(selected ? Prism.text : Prism.textSecondary)
                        .frame(width: 30, height: 24)
                        .background(selected ? Prism.surface1 : .clear, in: RoundedRectangle(cornerRadius: 6))
                        .overlay(RoundedRectangle(cornerRadius: 6).stroke(selected ? Prism.border : .clear, lineWidth: 1))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(option == .system ? "Match macOS appearance" : "\(option.title) mode")
                .accessibilityLabel(option == .system ? "Match macOS appearance" : "\(option.title) mode")
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
        }
        .padding(2)
        .background(Prism.surface2, in: RoundedRectangle(cornerRadius: 8))
    }
}

/// Primary (one per view), secondary and ghost buttons: 40pt high, 8pt radius, sentence-case labels.
struct PrismButtonStyle: ButtonStyle {
    enum Kind { case primary, secondary, ghost }
    var kind: Kind = .primary
    /// Fills the width the button is given, for rows of equal buttons such as Sign in and Create account.
    var stretches = false
    init(kind: Kind = .primary, stretches: Bool = false) { self.kind = kind; self.stretches = stretches }
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: 8)
        return configuration.label
            .font(Prism.text(14, .medium))
            .padding(.horizontal, 16)
            .frame(minHeight: 40)
            .frame(maxWidth: stretches ? .infinity : nil)
            .foregroundStyle(kind == .primary ? Prism.ink : Prism.text)
            .background(fill(pressed: configuration.isPressed), in: shape)
            .overlay(shape.stroke(kind == .secondary ? Prism.border : .clear, lineWidth: 1))
            .contentShape(shape)
            .opacity(isEnabled ? 1 : 0.4)
    }

    private func fill(pressed: Bool) -> Color {
        switch kind {
        case .primary: pressed ? Prism.action.opacity(0.85) : Prism.action
        case .secondary, .ghost: pressed ? Prism.surface2 : .clear
        }
    }
}

extension ButtonStyle where Self == PrismButtonStyle {
    static var prismPrimary: PrismButtonStyle { .init(kind: .primary) }
    static var prismSecondary: PrismButtonStyle { .init(kind: .secondary) }
    static var prismGhost: PrismButtonStyle { .init(kind: .ghost) }
}

/// Small icon or text buttons: a rounded box lights up on hover and takes clicks anywhere inside,
/// not only on the glyph or letters. Icons get a 30pt square; text links get padding around the label.
struct PrismIconButtonStyle: ButtonStyle {
    var isLink = false
    func makeBody(configuration: Configuration) -> some View { IconBody(configuration: configuration, isLink: isLink) }

    private struct IconBody: View {
        let configuration: Configuration
        let isLink: Bool
        @Environment(\.isEnabled) private var isEnabled
        @State private var isHovering = false
        var body: some View {
            let shape = RoundedRectangle(cornerRadius: 8)
            configuration.label
                .frame(width: isLink ? nil : 30, height: isLink ? nil : 30)
                .padding(.horizontal, isLink ? 8 : 0).padding(.vertical, isLink ? 5 : 0)
                .background(configuration.isPressed ? Prism.surface2 : isHovering && isEnabled ? Prism.surface2.opacity(0.6) : .clear, in: shape)
                .contentShape(shape)
                .opacity(isEnabled ? 1 : 0.4)
                .onHover { isHovering = $0 }
        }
    }
}

extension ButtonStyle where Self == PrismIconButtonStyle {
    static var prismIcon: PrismIconButtonStyle { .init() }
    static var prismLink: PrismIconButtonStyle { .init(isLink: true) }
}

/// Prism progress: one thin line, filled in the action color over a border-colored track.
struct PrismProgressLine: View {
    let value: Double
    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule().fill(Prism.border)
                Capsule().fill(Prism.accent).frame(width: geometry.size.width * min(1, max(0, value)))
            }
        }
        .frame(height: 4)
        .accessibilityElement()
        .accessibilityValue("\(Int(value * 100)) percent")
    }
}

/// The Prism mark: amber and coral faces over a Sky base. Geometry from the brand card;
/// scripts/generate-icon.swift draws the same points for the app icon.
struct PrismMark: View {
    var body: some View {
        Canvas { context, size in
            func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x * size.width, y: y * size.height) }
            let apex = point(0.5, 0), left = point(0, 0.797), right = point(1, 0.797)
            let center = point(0.5, 0.545), bottom = point(0.5, 1)
            func face(_ points: [CGPoint], _ color: Color) {
                var path = Path()
                path.addLines(points)
                path.closeSubpath()
                context.fill(path, with: .color(color))
            }
            // The mark keeps its brand colors in both themes.
            face([apex, left, center], Color(hex: 0xFFC233))
            face([apex, right, center], Color(hex: 0xFF6B57))
            face([left, center, right], Color(hex: 0x3FA9F5))
            face([left, right, bottom], Color(hex: 0x3996DA)) // Sky with 12% Ink
        }
        .aspectRatio(184.0 / 202.0, contentMode: .fit)
        .accessibilityHidden(true)
    }
}
