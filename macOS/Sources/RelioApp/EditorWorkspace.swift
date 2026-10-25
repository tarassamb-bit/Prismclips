import SwiftUI
import AVKit
import AppKit

/// The natural height of the export card's Shorts list.
private struct ExportListHeight: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

private enum EditorStyle {
    static let canvas = Prism.surface0
    static let panel = Prism.surface1
    static let inset = Prism.surface2
    static let accent = Prism.accent
    static let line = Prism.border
}

extension ContentView {
    /// "7 Shorts · from a 17:58 video" under the project name.
    var headerDetail: String {
        let shorts = model.project?.segments.count ?? 0
        let count = shorts == 0 ? "No Shorts yet" : shorts == 1 ? "1 Short" : "\(shorts) Shorts"
        guard let video = model.project?.media.first(where: { $0.kind == "video" }) else { return count }
        return "\(count) · from a \(editorTime(video.duration)) video"
    }
    var editorHeader: some View {
        HStack(spacing: 18) {
            Button { model.player?.pause(); model.screen = .home } label: {
                Label("Home", systemImage: "chevron.left")
            }.buttonStyle(.prismLink).help("Back to projects").disabled(model.isBusy)
            Rectangle().fill(EditorStyle.line).frame(width: 1, height: 20)
            VStack(alignment: .leading, spacing: 2) {
                Text(model.project?.displayTitle ?? "Untitled project").font(Prism.text(12, .medium)).lineLimit(1)
                Text(headerDetail).font(Prism.text(11)).foregroundStyle(Prism.textSecondary).lineLimit(1)
            }
            Spacer(minLength: 12)
            if let saved = model.lastSavedAt {
                Label("Saved \(saved.formatted(date: .omitted, time: .shortened))", systemImage: "checkmark.circle")
                    .font(Prism.text(11)).foregroundStyle(Prism.textSecondary).lineLimit(1)
                    .help("Prism saves every change to this project automatically")
            }
            if model.isBusy {
                ProgressView().controlSize(.small)
                Text(model.generationStage).font(Prism.text(12)).foregroundStyle(Prism.textSecondary).lineLimit(1)
            }
            AppearanceSwitch(selection: $appearance)
            Button { model.chooseExport() } label: {
                Label("Export", systemImage: "square.and.arrow.up")
                    .font(Prism.text(12, .medium))
                    .padding(.horizontal, 18).padding(.vertical, 8)
                    .foregroundStyle(Prism.ink).background(Prism.action, in: RoundedRectangle(cornerRadius: 8))
            }.buttonStyle(.plain).disabled(model.project?.media.isEmpty != false || model.isBusy)
                .help("Choose which Shorts, the main video and the quality to export")
                .accessibilityLabel("Export")
        }.padding(.horizontal, 20).frame(height: 54)
            .background(EditorStyle.panel)
            .overlay(alignment: .bottom) { EditorStyle.line.frame(height: 1) }
    }

    /// Covers the editor while Shorts are made: everything behind is dimmed and blocked; only Cancel works.
    func generationOverlay(_ progress: Double) -> some View {
        ZStack {
            Color.black.opacity(0.55).contentShape(Rectangle()).onTapGesture {}
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Text(model.generationStage).font(Prism.text(14, .medium)).lineLimit(1)
                    Spacer()
                    Text("\(Int(progress * 100))%").font(Prism.mono(12)).foregroundStyle(Prism.textSecondary)
                }
                PrismProgressLine(value: progress)
                HStack {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        Text("Elapsed \(editorTime(context.date.timeIntervalSince(model.generationStartedAt)))")
                            .font(Prism.mono(11)).foregroundStyle(Prism.textSecondary)
                    }
                    Spacer()
                    Button("Cancel") {
                        // Cancelling the first run leaves an empty editor, so it goes Home; "Create more" stays with its Shorts.
                        let leaveEditor = !model.isExporting && model.project?.segments.isEmpty != false
                        model.cancelGeneration()
                        if leaveEditor {
                            model.player?.pause()
                            model.screen = .home
                        }
                    }
                    .disabled(model.generationStage == "Cancelling…")
                    .controlSize(.large)
                }
            }
            .padding(24)
            .frame(width: 460)
            .background(EditorStyle.panel, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(EditorStyle.line))
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Creating Shorts")
        }
    }

    /// Pick the Shorts, the main video, the quality and the folder, then export.
    func exportChoiceOverlay(_ choice: AppModel.ExportChoice) -> some View {
        let clips = model.project?.segments ?? []
        let binding = Binding(get: { model.exportChoice ?? choice }, set: { model.exportChoice = $0 })
        let videos = model.project?.media.filter { $0.kind == "video" }.count ?? 0
        let count = choice.shortIDs.count + (choice.includeSource ? videos : 0)
        return ZStack {
            Color.black.opacity(0.55).contentShape(Rectangle()).onTapGesture {}
            VStack(alignment: .leading, spacing: 14) {
                Label("Export", systemImage: "square.and.arrow.up").font(Prism.text(16, .medium))
                HStack {
                    Text("Shorts").font(Prism.text(12, .medium)).foregroundStyle(Prism.textSecondary)
                    Spacer()
                    if !clips.isEmpty {
                        let all = choice.shortIDs.count == clips.count
                        Button(all ? "Select none" : "Select all") {
                            binding.wrappedValue.shortIDs = all ? [] : Set(clips.map(\.id))
                        }.buttonStyle(.prismLink).foregroundStyle(EditorStyle.accent)
                    }
                }
                if clips.isEmpty {
                    Text("No Shorts yet. You can still export the main video.").font(Prism.text(12)).foregroundStyle(Prism.textSecondary)
                } else {
                    let rows = VStack(alignment: .leading, spacing: 6) {
                            ForEach(Array(clips.enumerated()), id: \.element.id) { index, clip in
                                Toggle(isOn: Binding(get: { binding.wrappedValue.shortIDs.contains(clip.id) },
                                                     set: { on in if on { binding.wrappedValue.shortIDs.insert(clip.id) } else { binding.wrappedValue.shortIDs.remove(clip.id) } })) {
                                    HStack {
                                        Text("Short \(index + 1)").font(Prism.text(12, .medium))
                                        Text(clip.suggestedTitle ?? "").font(Prism.text(12)).foregroundStyle(Prism.textSecondary).lineLimit(1)
                                        Spacer()
                                        Text(editorTime(clip.duration)).font(Prism.mono(11)).foregroundStyle(Prism.textSecondary)
                                    }
                                }
                                .toggleStyle(.checkbox)
                            }
                        }
                    // The list takes the room its Shorts need, and scrolls past 220 points.
                    ScrollView {
                        rows.background(GeometryReader { Color.clear.preference(key: ExportListHeight.self, value: $0.size.height) })
                    }
                    .frame(height: min(220, max(22, exportListHeight)))
                    .onPreferenceChange(ExportListHeight.self) { height in Task { @MainActor in exportListHeight = height } }
                }
                Divider()
                Toggle(isOn: binding.includeSource) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(videos > 1 ? "Main videos (\(videos))" : "Main video").font(Prism.text(12, .medium))
                        Text("The original long video, copied as is.").font(Prism.text(11)).foregroundStyle(Prism.textSecondary)
                    }
                }.toggleStyle(.checkbox)
                Divider()
                Text("Quality").font(Prism.text(12, .medium)).foregroundStyle(Prism.textSecondary)
                Picker("Quality", selection: binding.quality) {
                    ForEach(ShortMaker.ExportQuality.allCases) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented).labelsHidden().frame(maxWidth: .infinity)
                Text(choice.quality.detail + " Applies to Shorts; the main video keeps its original quality.")
                    .font(Prism.text(11)).foregroundStyle(Prism.textSecondary).fixedSize(horizontal: false, vertical: true)
                Divider()
                Text("Save to").font(Prism.text(12, .medium)).foregroundStyle(Prism.textSecondary)
                HStack {
                    Image(systemName: "folder").foregroundStyle(Prism.textSecondary)
                    Text(AppModel.displayPath(choice.folder)).font(Prism.text(12)).lineLimit(1).truncationMode(.middle)
                    Spacer()
                    Button("Change…") {
                        let panel = NSOpenPanel()
                        panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.canCreateDirectories = true
                        panel.prompt = "Export here"
                        if panel.runModal() == .OK, let url = panel.url { binding.wrappedValue.folder = url }
                    }
                }
                .padding(10).background(EditorStyle.inset, in: RoundedRectangle(cornerRadius: 8))
                if let error = choice.error {
                    Label(error, systemImage: "exclamationmark.triangle").font(Prism.text(12)).foregroundStyle(Prism.amber)
                        .fixedSize(horizontal: false, vertical: true)
                }
                HStack {
                    Button("Cancel") { model.exportChoice = nil }.controlSize(.large).keyboardShortcut(.cancelAction)
                    Spacer()
                    Button(count == 1 ? "Export 1 file" : "Export \(count) files") { model.export(choice) }
                        .buttonStyle(.prismPrimary).keyboardShortcut(.defaultAction).disabled(count == 0)
                }
            }
            .padding(24)
            .frame(width: 480)
            .background(EditorStyle.panel, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(EditorStyle.line))
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Export")
        }
    }

    func exportDoneOverlay(_ summary: String) -> some View {
        ZStack {
            Color.black.opacity(0.55).contentShape(Rectangle()).onTapGesture { model.exportSummary = nil }
            VStack(alignment: .leading, spacing: 14) {
                Label("Export finished", systemImage: "checkmark.circle.fill")
                    .font(Prism.text(16, .medium)).foregroundStyle(Prism.accent)
                Text(summary).font(Prism.text(13))
                if model.lastExportShortCount > 0 {
                    Text("Shorts: \(model.lastExportQuality.resolution) · 30 fps · \(model.lastExportQuality.title.components(separatedBy: " · ").last ?? "H.264") MP4, ready to upload.").font(Prism.text(12)).foregroundStyle(Prism.textSecondary)
                }
                HStack {
                    Button("Done") { model.exportSummary = nil }
                        .controlSize(.large).keyboardShortcut(.cancelAction)
                    Spacer()
                    Button("Show in Finder") {
                        model.exportSummary = nil
                        model.revealExports()
                    }
                    .buttonStyle(.prismPrimary).keyboardShortcut(.defaultAction)
                }
            }
            .padding(24)
            .frame(width: 460)
            .background(EditorStyle.panel, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(EditorStyle.line))
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Export finished")
        }
    }

    func generationErrorOverlay(_ failure: AppModel.GenerationFailure) -> some View {
        let (title, advice): (String, String?) = switch failure.kind {
        case .noMoments: ("No Shorts found", "Change the clip length or which part of the video Prism looks in, then try again.")
        case .settings: ("Check your Prism AI settings", nil)
        case .temporary: ("Prism AI is unavailable right now",
                          "This is a temporary problem with the AI service, not with your video or its range. Prism already retried for about a minute and tried the other Prism AI models too. Wait a little, then try again.")
        case .limit: ("Usage limit reached", "Shorts you already made stay available, and you can keep editing and exporting them.")
        case .other: ("Couldn’t make Shorts", nil)
        }
        let tryAgain = { model.generationError = nil; model.makeConfiguredShorts() }
        let leave = { (screen: AppModel.Screen) in model.generationError = nil; model.player?.pause(); model.screen = screen }
        return ZStack {
            Color.black.opacity(0.55).contentShape(Rectangle()).onTapGesture {}
            VStack(alignment: .leading, spacing: 14) {
                Label(title, systemImage: "exclamationmark.triangle")
                    .font(Prism.text(16, .medium)).foregroundStyle(Prism.amber)
                Text(failure.message).font(Prism.text(13)).fixedSize(horizontal: false, vertical: true)
                if let advice {
                    Text(advice)
                        .font(Prism.text(12)).foregroundStyle(Prism.textSecondary).fixedSize(horizontal: false, vertical: true)
                }
                HStack {
                    Button("Close") { model.generationError = nil }
                        .controlSize(.large).keyboardShortcut(.cancelAction)
                    Spacer()
                    switch failure.kind {
                    case .noMoments, .settings:
                        Button("Try again", action: tryAgain).controlSize(.large)
                        Button(failure.kind == .settings ? "Open Settings" : "Change clip length or range") {
                            leave(failure.kind == .settings ? .settings : .importSource)
                        }
                        .buttonStyle(.prismPrimary).keyboardShortcut(.defaultAction)
                    case .temporary:
                        Button("Try again", action: tryAgain).buttonStyle(.prismPrimary).keyboardShortcut(.defaultAction)
                    case .limit:
                        Button("See usage") { model.opensUsageSettings = true; leave(.settings) }.buttonStyle(.prismPrimary).keyboardShortcut(.defaultAction)
                    case .other:
                        Button("Try again", action: tryAgain).buttonStyle(.prismPrimary).keyboardShortcut(.defaultAction)
                    }
                }
            }
            .padding(24)
            .frame(width: 460)
            .background(EditorStyle.panel, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(EditorStyle.line))
            .accessibilityElement(children: .contain)
            .accessibilityLabel(title)
        }
    }

    var editingWorkspace: some View {
        VStack(spacing: 1) {
            HStack(spacing: 1) {
                EditorMediaBin(model: model)
                    .frame(width: leftSidebarWidth)
                EditorSidebarDivider {
                    leftSidebarWidth = min(440, max(200, leftSidebarWidth + $0))
                }
                EditorPlayer(model: model).frame(maxWidth: .infinity, maxHeight: .infinity)
                EditorSidebarDivider {
                    rightSidebarWidth = min(460, max(220, rightSidebarWidth - $0))
                }
                EditorCaptionsSidebar(model: model).frame(width: rightSidebarWidth)
            }.frame(maxHeight: .infinity)
            EditorSidebarDivider(axis: .vertical) {
                timelineHeight = min(620, max(150, timelineHeight - $0))
            }
            EditorTimeline(model: model).frame(height: timelineHeight)
            HStack(spacing: 8) {
                if model.isBusy || model.isPreviewLoading { ProgressView().controlSize(.mini) }
                Text(model.message).font(Prism.text(11)).lineLimit(1).textSelection(.enabled)
                Spacer()
                Text("Shorts export at 1080 × 1920 · MP4").font(Prism.text(11)).foregroundStyle(Prism.textSecondary)
            }.padding(.horizontal, 16).frame(height: 28).background(EditorStyle.panel)
        }.background(EditorStyle.line)
        .background(EditorShortcuts(model: model))
    }
}

/// Space plays or pauses, ←/→ seek 1 s (⇧ 5 s), Delete removes the open Short. ⌘Z is Edit › Undo in the menu bar. Ignored while typing or while a popup covers the editor.
private struct EditorShortcuts: View {
    let model: AppModel
    @State private var monitor: Any?
    var body: some View {
        Color.clear
            .onAppear {
                // A second monitor would handle each key twice: Space would play and pause at once.
                guard monitor == nil else { return }
                monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
                    handle(event) ? nil : event
                }
            }
            .onDisappear { if let monitor { NSEvent.removeMonitor(monitor) }; monitor = nil }
    }

    @MainActor private func handle(_ event: NSEvent) -> Bool {
        guard model.screen == .editor, model.generationProgress == nil, model.generationError == nil, model.exportSummary == nil, model.exportChoice == nil,
              !(event.window?.firstResponder is NSText) else { return false }
        let modifiers = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        switch (event.keyCode, modifiers) {
        case (49, []): model.togglePlayback()
        case (123, []), (123, .shift), (123, [.shift, .numericPad, .function]), (123, [.numericPad, .function]):
            model.seekPreview(by: modifiers.contains(.shift) ? -5 : -1)
        case (124, []), (124, .shift), (124, [.shift, .numericPad, .function]), (124, [.numericPad, .function]):
            model.seekPreview(by: modifiers.contains(.shift) ? 5 : 1)
        case (126, []), (126, [.numericPad, .function]), (125, []), (125, [.numericPad, .function]):
            model.selectAdjacentShort(event.keyCode == 126 ? -1 : 1)
        case (51, []), (117, []), (117, .function):
            guard let id = model.previewShortID, !model.isBusy else { return false }
            model.removeShort(id)
        default: return false
        }
        return true
    }
}

private struct EditorSidebarDivider: View {
    /// `.horizontal` drags left/right between sidebars; `.vertical` drags up/down above the timeline.
    var axis: Axis = .horizontal
    let onDrag: (CGFloat) -> Void
    @State private var lastTranslation: CGFloat = 0
    @State private var isHovering = false
    @State private var cursorIsPushed = false

    var body: some View {
        // Zero layout thickness: the stack's 1px gap is the visible line; the overlay is a wider, invisible grab zone.
        Color.clear
            .frame(width: axis == .horizontal ? 0 : nil, height: axis == .vertical ? 0 : nil)
            .frame(maxWidth: axis == .vertical ? .infinity : nil, maxHeight: axis == .horizontal ? .infinity : nil)
            .overlay { grabZone }
            .zIndex(1)
    }

    private var grabZone: some View {
        Rectangle()
            .fill(isHovering ? EditorStyle.accent.opacity(0.75) : .clear)
            .frame(width: axis == .horizontal ? 2 : nil, height: axis == .vertical ? 2 : nil)
            .frame(width: axis == .horizontal ? 9 : nil, height: axis == .vertical ? 9 : nil)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 1, coordinateSpace: .global)
                    .onChanged { value in
                        let translation = axis == .horizontal ? value.translation.width : value.translation.height
                        onDrag(translation - lastTranslation)
                        lastTranslation = translation
                    }
                    .onEnded { _ in lastTranslation = 0 }
            )
            .onHover { hovering in
                isHovering = hovering
                // Balanced push and pop, so the resize cursor can't get stuck or pop someone else's cursor.
                if hovering, !cursorIsPushed { (axis == .horizontal ? NSCursor.resizeLeftRight : NSCursor.resizeUpDown).push(); cursorIsPushed = true }
                else if !hovering, cursorIsPushed { NSCursor.pop(); cursorIsPushed = false }
            }
            .onDisappear { if cursorIsPushed { NSCursor.pop(); cursorIsPushed = false } }
            .help(axis == .horizontal ? "Drag to resize sidebar" : "Drag to resize timeline")
            .accessibilityLabel(axis == .horizontal ? "Resize sidebar" : "Resize timeline")
    }
}

/// A section title that folds its content away: a chevron, the title and, while folded, how many items it hides.
/// Prism AI's 0–100 rating in the corner of a Short's thumbnail.
struct ShortScoreBadge: View {
    let score: Int?

    var body: some View {
        if let score {
            HStack(spacing: 3) {
                Image(systemName: "sparkles")
                Text("\(score)").monospacedDigit()
            }
            .font(Prism.text(10, .medium)).foregroundStyle(.white)
            .padding(.horizontal, 6).padding(.vertical, 3)
            .background(.black.opacity(0.6), in: Capsule())
            .padding(5)
            .help("Prism AI score: \(score) of 100")
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Prism AI score \(score) of 100")
        }
    }
}

struct FoldingHeader: View {
    let title: String
    var count: Int? = nil
    /// Shorts keeps its count visible while open, as before; other sections show it only when folded.
    var alwaysShowsCount = false
    @Binding var isCollapsed: Bool
    var body: some View {
        Button { withAnimation(.easeInOut(duration: 0.2)) { isCollapsed.toggle() } } label: {
            HStack(spacing: 6) {
                Image(systemName: "chevron.right").font(Prism.text(10, .medium)).foregroundStyle(Prism.textSecondary)
                    .rotationEffect(.degrees(isCollapsed ? 0 : 90))
                Text(title).font(Prism.text(14, .medium))
                if let count, isCollapsed || alwaysShowsCount {
                    Text("\(count)").font(Prism.text(11, .medium)).foregroundStyle(Prism.textSecondary)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(isCollapsed ? "Show \(title.lowercased())" : "Hide \(title.lowercased())")
        .accessibilityLabel(isCollapsed ? "Show \(title)" : "Hide \(title)")
    }
}

/// A subtitle style's sample, drawn by the export code itself, so the picker shows exactly what the video gets.
struct CaptionStylePreview: View {
    let style: CaptionStyle
    /// Drawn once per style: the editor redraws often, and each preview renders and scans an image.
    @MainActor private static var cache: [CaptionStyle: CGImage] = [:]
    var body: some View {
        if let image = Self.cache[style] ?? Self.render(style) {
            Image(decorative: image, scale: 1).resizable().scaledToFit()
        }
    }
    private static func render(_ style: CaptionStyle) -> CGImage? {
        let image = ShortMaker.captionPreview(style)
        cache[style] = image
        return image
    }
}

struct EditorCaptionsPanel: View {
    @Bindable var model: AppModel
    @State private var drafts: [String] = []
    /// The caption lines fold away to a header; the choice is kept across launches.
    @AppStorage("editor.captionTextCollapsed") private var captionTextCollapsed = false
    @AppStorage("editor.captionStyleCollapsed") private var captionStyleCollapsed = false

    var body: some View {
        Group {
            if let clip = model.activeSegment {
                content(clip)
            } else {
                Text("Select a Short to change its captions.")
                    .font(Prism.text(12)).foregroundStyle(Prism.textSecondary).padding(.vertical, 28)
            }
        }
        .onAppear(perform: loadDrafts)
        .onChange(of: model.activeSegment?.captions ?? []) { _, _ in loadDrafts() }
    }

    @ViewBuilder
    func content(_ clip: EditSegment) -> some View {
        let current = clip.captionStyle ?? .classic
        let hasAudio = model.project?.media.first(where: { $0.id == clip.mediaID })?.hasAudio == true
        let cues = clip.captions ?? []
        VStack(alignment: .leading, spacing: 10) {
            FoldingHeader(title: "Caption style", isCollapsed: $captionStyleCollapsed)
            if captionStyleCollapsed {
                // Folded, the chosen style still shows, so it is clear what the Short uses.
                styleButton(current, title: current.title, detail: current.detail, selected: true)
            } else {
                ForEach(CaptionStyle.allCases) { style in
                    styleButton(style, title: style.title, detail: style.detail, selected: current == style)
                }
            }
            Text(current == .auto ? "\(current.detail) For this Short: \(clip.resolvedCaptionStyle.title)." : current.detail)
                .font(Prism.text(11)).foregroundStyle(Prism.textSecondary).fixedSize(horizontal: false, vertical: true)
            if !model.timingShortIDs.isEmpty {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(model.timingShortIDs.count == 1 ? "Timing the words of 1 Short…" : "Timing the words of \(model.timingShortIDs.count) Shorts…")
                }
                .font(Prism.text(11)).foregroundStyle(Prism.textSecondary)
            } else if current.usesWordTiming && clip.speechWords?.isEmpty != false && hasAudio {
                Text("Word timing is estimated for this Short. Transcribe it for exact timing.")
                    .font(Prism.text(11)).foregroundStyle(Prism.textSecondary).fixedSize(horizontal: false, vertical: true)
            }
            Text("Position").font(Prism.text(12, .medium)).padding(.top, 6)
            Picker("Subtitle position", selection: Binding(get: { clip.captionPosition ?? .bottom },
                                                           set: { model.setSelectedCaptionLayout(position: $0) })) {
                ForEach(CaptionPosition.allCases) { Text($0.title).tag($0) }
            }
            .pickerStyle(.segmented).labelsHidden().frame(maxWidth: .infinity)
            Text("Size").font(Prism.text(12, .medium))
            Picker("Subtitle size", selection: Binding(get: { clip.captionSize ?? .medium },
                                                       set: { model.setSelectedCaptionLayout(size: $0) })) {
                ForEach(CaptionSize.allCases) { Text($0.title).tag($0) }
            }
            .pickerStyle(.segmented).labelsHidden().frame(maxWidth: .infinity)
            Toggle("Pop-in animation", isOn: Binding(get: { clip.captionPops },
                                                     set: { model.setSelectedCaptionLayout(animated: $0) }))
                .font(Prism.text(12)).toggleStyle(.switch).controlSize(.small)
        }
        Divider()
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                FoldingHeader(title: "Caption text", count: cues.isEmpty ? nil : cues.count, isCollapsed: $captionTextCollapsed)
                Spacer()
                Button { model.regenerateSelectedSubtitles() } label: {
                    Label("Transcribe", systemImage: "waveform").font(Prism.text(11, .medium))
                }
                .buttonStyle(.prismLink).foregroundStyle(EditorStyle.accent)
                .disabled(model.isBusy || !hasAudio)
                .accessibilityLabel("Transcribe speech into captions")
                .help(hasAudio
                      ? "Transcribe with Prism AI in the cloud."
                      : "This source video has no audio track.")
            }
            if captionTextCollapsed {
                EmptyView()
            } else if cues.isEmpty {
                Text(hasAudio ? "No captions yet. Transcribe this Short to create them." : "This source has no audio, so there is no speech to caption.")
                    .font(Prism.text(12)).foregroundStyle(Prism.textSecondary).fixedSize(horizontal: false, vertical: true)
            } else {
                ForEach(Array(cues.enumerated()), id: \.offset) { index, cue in
                    // One row per line: its time jumps the preview there, the text beside it is editable.
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Button { model.seekPreview(to: cue.start) } label: {
                            Text(editorTime(cue.start)).font(Prism.mono(11)).frame(width: 38, alignment: .leading)
                        }
                        .buttonStyle(.prismLink).foregroundStyle(Prism.textSecondary)
                        .help("Jump to this line in the preview")
                        .accessibilityLabel("Jump to \(editorTime(cue.start))")
                        TextField("Caption line", text: Binding(
                            get: { drafts.indices.contains(index) ? drafts[index] : cue.text },
                            set: { if drafts.indices.contains(index) { drafts[index] = $0 } }), axis: .vertical)
                            .textFieldStyle(.plain).font(Prism.text(12)).padding(.horizontal, 7).padding(.vertical, 5)
                            .background(EditorStyle.inset, in: RoundedRectangle(cornerRadius: 6))
                            .accessibilityLabel("Caption at \(editorTime(cue.start))")
                    }
                }
                Text("Clear a line to remove it. An edited line keeps its timing; its words are timed by estimate.")
                    .font(Prism.text(11)).foregroundStyle(Prism.textSecondary).fixedSize(horizontal: false, vertical: true)
                Button { model.updateSelectedCaptionTexts(drafts) } label: {
                    Text("Save captions").font(Prism.text(12, .medium)).frame(maxWidth: .infinity).padding(.vertical, 9)
                        .foregroundStyle(Prism.ink).background(Prism.action, in: RoundedRectangle(cornerRadius: 8))
                }
                .buttonStyle(.plain)
                .disabled(model.isBusy || drafts == cues.map(\.text))
                .keyboardShortcut("s", modifiers: .command)
                .help("Save captions · ⌘S")
            }
        }
        .disabled(model.isBusy)
    }

    func styleButton(_ style: CaptionStyle, title: String, detail: String, selected: Bool) -> some View {
        Button { if !selected { model.setSelectedCaptionStyle(style) } } label: {
            HStack(spacing: 10) {
                CaptionStylePreview(style: style)
                    .padding(.horizontal, 4)
                    .frame(width: 112, height: 34)
                    .background(Color(white: 0.28), in: RoundedRectangle(cornerRadius: 8))
                // The name only; a narrow sidebar squeezed the descriptions into five-line columns. The tooltip has it.
                Text(title).font(Prism.text(12, .medium)).lineLimit(1).minimumScaleFactor(0.8)
                Spacer(minLength: 0)
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(selected ? EditorStyle.accent : Prism.textSecondary)
            }
            .padding(8)
            .background(selected ? EditorStyle.accent.opacity(0.12) : EditorStyle.inset, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(selected ? EditorStyle.accent : .clear, lineWidth: 1))
            .contentShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .disabled(model.isBusy)
        .help(detail)
        .accessibilityHint(detail)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    func loadDrafts() {
        drafts = (model.activeSegment?.captions ?? []).map(\.text)
    }
}

struct EditorMediaBin: View {
    @Bindable var model: AppModel
    @State private var isDropTarget = false
    @AppStorage("editor.shortsCollapsed") private var shortsCollapsed = false
    @AppStorage("editor.mainVideoCollapsed") private var mainVideoCollapsed = false
    /// Shows the highest Prism AI scores first; numbers stay the Shorts' own.
    @AppStorage("editor.shortsBestFirst") private var bestFirst = false
    /// Each Short's poster and the source time it shows; a trimmed Short gets a new one.
    @State private var shortPosters: [UUID: (seconds: Double, image: NSImage)] = [:]
    private let columns = [GridItem(.adaptive(minimum: 112), spacing: 10)]
    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    shortsContent
                }.padding(14)
            }
            .task(id: model.project?.segments ?? []) { await loadShortPosters() }
            Divider()
            Button { model.screen = .importSource } label: {
                Label("Auto Shorts settings", systemImage: "sparkles").font(Prism.text(11, .medium))
                    .frame(maxWidth: .infinity).padding(14).contentShape(Rectangle())
            }.buttonStyle(.plain).disabled(model.isBusy)
        }.background(EditorStyle.panel)
        // A video dropped from Finder onto the media bin joins the open project.
        .dropDestination(for: URL.self) { urls, _ in
            guard let url = urls.first, url.isFileURL, AppModel.importableExtensions.contains(url.pathExtension.lowercased()), !model.isBusy else { return false }
            model.importSource(url)
            return true
        } isTargeted: { isDropTarget = $0 }
        .overlay {
            if isDropTarget {
                RoundedRectangle(cornerRadius: 12).stroke(style: StrokeStyle(lineWidth: 2, dash: [8, 6])).foregroundStyle(EditorStyle.accent)
                    .background(EditorStyle.accent.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
                    .overlay { Label("Drop to add this video", systemImage: "arrow.down.circle.fill").font(Prism.text(13, .medium)).foregroundStyle(EditorStyle.accent) }
                    .padding(8).allowsHitTesting(false)
            }
        }
    }
    /// The Shorts tab: the generated Shorts and the main video, each section folding on its own.
    /// Separate from the scroll view around it, so it can also be rendered on its own.
    @ViewBuilder var shortsContent: some View {
                if let clips = model.project?.segments, !clips.isEmpty {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            FoldingHeader(title: "Shorts", count: clips.count, alwaysShowsCount: true, isCollapsed: $shortsCollapsed)
                            Spacer()
                            if clips.contains(where: { $0.score != nil }) {
                                Button { bestFirst.toggle() } label: {
                                    Image(systemName: bestFirst ? "star.fill" : "star").font(Prism.text(11, .medium))
                                        .foregroundStyle(bestFirst ? EditorStyle.accent : Prism.textSecondary)
                                }
                                .buttonStyle(.prismLink)
                                .help(bestFirst ? "Showing best first · click for video order" : "Show the best Shorts first")
                                .accessibilityLabel(bestFirst ? "Show Shorts in video order" : "Show best Shorts first")
                            }
                            Button { model.makeConfiguredShorts() } label: {
                                Label("Create more", systemImage: "sparkles").font(Prism.text(11, .medium)).foregroundStyle(EditorStyle.accent)
                            }.buttonStyle(.prismLink).help("Analyze this video's unused moments for more Shorts").disabled(model.isBusy)
                        }
                        if !shortsCollapsed {
                        LazyVGrid(columns: columns, spacing: 10) {
                            ForEach(ordered(clips), id: \.element.id) { index, clip in
                                ZStack(alignment: .topTrailing) {
                                    Button {
                                        model.selection = clip.mediaID
                                        model.selectPreview(clip.id)
                                    } label: {
                                        VStack(alignment: .leading, spacing: 5) {
                                            ZStack(alignment: .bottomLeading) {
                                                GeometryReader { geometry in
                                                    if let poster = shortPosters[clip.id]?.image {
                                                        Image(nsImage: poster).resizable().scaledToFill()
                                                            .frame(width: geometry.size.width, height: 82).clipped()
                                                    } else if let media = model.project?.media.first(where: { $0.id == clip.mediaID }) {
                                                        mediaPoster(media).frame(width: geometry.size.width, height: 82).clipped()
                                                    } else {
                                                        Rectangle().fill(EditorStyle.inset)
                                                    }
                                                }.frame(height: 82)
                                                LinearGradient(colors: [.clear, .black.opacity(0.7)], startPoint: .center, endPoint: .bottom)
                                                HStack(spacing: 4) {
                                                    Image(systemName: "play.fill")
                                                    Text("Short \(index + 1)").lineLimit(1)
                                                    if clip.splitScreen == true {
                                                        Image(systemName: "rectangle.split.1x2").help("Split screen")
                                                    }
                                                    if clip.selectionReason?.hasPrefix("Weaker pick") == true {
                                                        Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Prism.amber)
                                                            .help("Weaker pick: check this one before exporting")
                                                    }
                                                    Spacer(minLength: 0)
                                                    Text(editorTime(clip.duration)).monospacedDigit()
                                                }.font(Prism.text(11, .medium)).foregroundStyle(.white).padding(5)
                                            }
                                            .overlay(alignment: .topLeading) { ShortScoreBadge(score: clip.score) }
                                            .clipShape(RoundedRectangle(cornerRadius: 4))
                                            if let title = clip.suggestedTitle, !title.isEmpty {
                                                Text(title).font(Prism.text(11, .medium)).lineLimit(2)
                                            }
                                            Text("Starts at \(editorTime(clip.start))")
                                                .font(Prism.text(11)).foregroundStyle(Prism.textSecondary).lineLimit(1)
                                        }.padding(5).frame(maxWidth: .infinity, alignment: .leading)
                                            .background(model.previewShortID == clip.id ? EditorStyle.accent.opacity(0.14) : EditorStyle.inset, in: RoundedRectangle(cornerRadius: 8))
                                            .overlay(RoundedRectangle(cornerRadius: 8).stroke(model.previewShortID == clip.id ? EditorStyle.accent : .clear, lineWidth: 1))
                                    }.buttonStyle(.plain).accessibilityLabel("Preview Short \(index + 1)")
                                    .contextMenu {
                                        Button("Preview") { model.selection = clip.mediaID; model.selectPreview(clip.id) }
                                        Button("Export this Short…") { model.chooseExport(only: clip.id) }
                                        Divider()
                                        Button("Remove Short") { model.removeShort(clip.id) }
                                    }
                                    .help("Right-click for more")
                                    Button { model.removeShort(clip.id) } label: {
                                        Image(systemName: "xmark")
                                            .font(Prism.text(11, .medium))
                                            .foregroundStyle(.white)
                                            .frame(width: 22, height: 22)
                                            .background(.black.opacity(0.78), in: Circle())
                                    }
                                    .buttonStyle(.plain)
                                    .padding(9)
                                    .disabled(model.isBusy)
                                    .help("Remove Short · Undo available")
                                    .accessibilityLabel("Remove Short \(index + 1)")
                                }
                            }
                        }
                        }
                    }
                }
                Divider()
                HStack {
                    FoldingHeader(title: "Main video", count: model.project?.media.count, isCollapsed: $mainVideoCollapsed)
                    Spacer()
                    Button { model.importVideo() } label: { Image(systemName: "plus") }.buttonStyle(.prismIcon)
                        .help("Import video").accessibilityLabel("Import video")
                        .disabled(model.isBusy)
                }
                if !mainVideoCollapsed {
                if model.project?.media.isEmpty != false {
                    // The big button only while there is nothing yet; afterwards the + in the heading adds more.
                    Button { model.importVideo() } label: {
                        Label("Import", systemImage: "square.and.arrow.down")
                            .font(Prism.text(12, .medium)).frame(maxWidth: .infinity).padding(.vertical, 9)
                            .background(Prism.surface2, in: RoundedRectangle(cornerRadius: 8))
                    }.buttonStyle(.plain).disabled(model.isBusy)
                    Text("Import a video to begin editing.").font(Prism.text(12)).foregroundStyle(Prism.textSecondary).padding(.vertical, 28)
                } else {
                    LazyVGrid(columns: columns, spacing: 10) {
                        ForEach(model.project?.media ?? []) { media in
                            Button {
                                model.selection = media.id
                                model.selectPreview(nil)
                            } label: {
                                VStack(alignment: .leading, spacing: 5) {
                                    ZStack(alignment: .bottomTrailing) {
                                        mediaPoster(media)
                                            .frame(height: 70)
                                            .clipped()
                                            .background(EditorStyle.inset)
                                            .clipShape(RoundedRectangle(cornerRadius: 4))
                                        Text(editorTime(media.duration)).font(Prism.mono(11))
                                            .padding(.horizontal, 4).padding(.vertical, 2)
                                            .background(.black.opacity(0.8), in: RoundedRectangle(cornerRadius: 3)).padding(4)
                                    }
                                    Text(media.name).font(Prism.text(11)).lineLimit(1)
                                    Text("\(media.width) × \(media.height)").font(Prism.text(11)).foregroundStyle(Prism.textSecondary)
                                }.padding(6).frame(maxWidth: .infinity, alignment: .leading)
                                    .background(EditorStyle.inset, in: RoundedRectangle(cornerRadius: 8))
                                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(model.previewShortID == nil && model.selection == media.id ? EditorStyle.accent : .clear, lineWidth: 1))
                            }.buttonStyle(.plain).accessibilityLabel("Source video \(media.name)")
                        }
                    }
                }
                if model.project?.media.isEmpty == false {
                    Button { model.addManualClip() } label: {
                        Label("Add clip to timeline", systemImage: "plus.rectangle.on.rectangle")
                            .font(Prism.text(11, .medium)).foregroundStyle(EditorStyle.accent)
                    }.buttonStyle(.prismLink).disabled(model.isBusy)
                }
                }
    }
    /// The Shorts with their own numbers, in video order or by score.
    func ordered(_ clips: [EditSegment]) -> [(offset: Int, element: EditSegment)] {
        let numbered = Array(clips.enumerated()).map { (offset: $0.offset, element: $0.element) }
        guard bestFirst else { return numbered }
        return numbered.sorted { ($0.element.score ?? -1, -$0.offset) > ($1.element.score ?? -1, -$1.offset) }
    }
    @ViewBuilder
    func mediaPoster(_ media: MediaItem) -> some View {
        if let path = media.thumbnail, let image = NSImage(contentsOfFile: path) {
            Image(nsImage: image).resizable().scaledToFill()
        } else {
            ZStack {
                EditorStyle.inset
                Image(systemName: "film").font(Prism.text(16)).foregroundStyle(Prism.textSecondary)
            }
        }
    }

    @MainActor
    func loadShortPosters() async {
        let entries = model.project?.segments.compactMap { clip -> (UUID, URL, Double)? in
            guard let media = model.project?.media.first(where: { $0.id == clip.mediaID }) else { return nil }
            return (clip.id, URL(fileURLWithPath: media.path), min(max(0.1, clip.start + clip.duration * 0.45), max(0.1, media.duration - 0.1)))
        } ?? []
        let stale = entries.filter { id, _, seconds in shortPosters[id].map { abs($0.seconds - seconds) > 0.05 } ?? true }
        // A few side by side, so a run of 20 Shorts gets its posters quickly.
        let posters = (try? await ShortMaker.concurrentMap(stale, limit: 4) { id, url, seconds -> (UUID, Double, CGImage?) in
            let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
            generator.appliesPreferredTrackTransform = true
            generator.maximumSize = CGSize(width: 480, height: 480)
            return (id, seconds, try? await generator.image(at: CMTime(seconds: seconds, preferredTimescale: 600)).image)
        }) ?? []
        for (id, seconds, image) in posters {
            if let image { shortPosters[id] = (seconds, NSImage(cgImage: image, size: .zero)) }
        }
        let validIDs = Set(entries.map(\.0))
        shortPosters = shortPosters.filter { validIDs.contains($0.key) }
    }
}

private struct EditorPlayer: View {
    @Bindable var model: AppModel
    var playerTitle: String {
        guard let clip = model.activeSegment else { return "Source video" }
        let number = (model.project?.segments.firstIndex(where: { $0.id == clip.id }) ?? 0) + 1
        guard let title = clip.suggestedTitle, !title.isEmpty else { return "Short \(number) preview" }
        return "Short \(number) · \(title)"
    }
    var body: some View {
        VStack(spacing: 0) {
            HStack {
            Text(playerTitle).font(Prism.text(12, .medium)).lineLimit(1)
                Spacer()
                Text(model.activeSegment == nil ? "Original" : "Vertical · 9:16").font(Prism.text(11)).foregroundStyle(Prism.textSecondary)
                Button { model.selectPreview(nil) } label: { Image(systemName: "rectangle.on.rectangle") }.buttonStyle(.prismIcon)
                    .help("Preview original source").accessibilityLabel("Preview original source")
            }.padding(.horizontal, 16).frame(height: 40)
            ZStack {
                if let player = model.player {
                    RelioPlayerView(player: player, captionSegment: model.previewSegment)
                        .overlay {
                            Color.clear.contentShape(Rectangle())
                                .onTapGesture(count: 2) { model.isPlayerExpanded = true }
                                .onTapGesture { model.togglePlayback() }
                                .help("Click to play or pause · double-click to fill the window")
                        }
                } else if model.isPreviewLoading {
                    VStack(spacing: 10) {
                        ProgressView()
                        Text(model.isFramingPreview ? "Prism AI is framing the subject…" : "Rendering preview…").font(Prism.text(12)).foregroundStyle(Prism.textSecondary)
                    }
                } else if let error = model.previewError {
                    VStack(spacing: 12) {
                        Image(systemName: "exclamationmark.triangle").foregroundStyle(Prism.amber)
                        Text(error).font(Prism.text(12)).multilineTextAlignment(.center)
                        Button("Retry preview") { model.selectPreview(model.previewShortID) }
                    }.padding(24)
                } else {
                    VStack(spacing: 12) {
                        Image(systemName: "play.rectangle").font(Prism.text(36)).foregroundStyle(Prism.textSecondary)
                        Text("Your video goes here").font(Prism.text(13, .medium))
                        Button("Import video") { model.importVideo() }.disabled(model.isBusy)
                    }
                }
            }.frame(maxWidth: .infinity, maxHeight: .infinity).background(.black).padding(.horizontal, 16)
            TimelineView(.periodic(from: .now, by: 0.1)) { _ in
                HStack(spacing: 12) {
                    Text(editorTime(model.player?.currentTime().seconds ?? 0))
                        .foregroundStyle(EditorStyle.accent)
                    Text("/ \(editorTime(model.activeSegment?.duration ?? model.project?.media.first(where: { $0.id == model.selection })?.duration ?? 0))")
                        .foregroundStyle(Prism.textSecondary)
                    Spacer()
                    Button { model.seekPreview(to: 0) } label: { Image(systemName: "backward.end.fill") }.buttonStyle(.prismIcon)
                        .help("Go to start · ← → to step, ⇧ for 5 s · ↑ ↓ for the previous or next Short").accessibilityLabel("Go to start")
                    Button { model.togglePlayback() } label: { Image(systemName: model.player?.rate == 0 ? "play.fill" : "pause.fill") }.buttonStyle(.prismIcon)
                        .help("Play or pause · Space").accessibilityLabel("Play or pause preview")
                    Spacer()
                    Button { model.isPlayerExpanded = true } label: { Image(systemName: "arrow.up.left.and.arrow.down.right") }.buttonStyle(.prismIcon)
                        .help("Fill the window · press Esc to exit").accessibilityLabel("Expand preview to fill the window")
                }.font(Prism.mono(11)).buttonStyle(.plain)
                    .disabled(model.player == nil).padding(.horizontal, 18).frame(height: 44)
            }
        }.background(EditorStyle.canvas)
    }
}

/// The right sidebar: the selected Short's captions.
private struct EditorCaptionsSidebar: View {
    @Bindable var model: AppModel
    var body: some View {
        VStack(spacing: 0) {
            Text("Captions").font(Prism.text(12, .medium))
                .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16).frame(height: 40)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    EditorCaptionsPanel(model: model)
                }.padding(14)
            }
        }.background(EditorStyle.panel)
    }
}

private struct EditorTimeline: View {
    @Bindable var model: AppModel
    var media: MediaItem? { model.project?.media.first(where: { $0.id == model.selection }) }
    var length: Double { max(0.1, model.activeSegment?.duration ?? media?.duration ?? 1) }
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 18) {
                Button { model.undoFromEditor() } label: { Image(systemName: "arrow.uturn.backward") }.buttonStyle(.prismIcon)
                    .help("Undo edit · ⌘Z").disabled(model.editHistory.isEmpty || model.isBusy)
                    .accessibilityLabel("Undo edit")
                Button { model.redoFromEditor() } label: { Image(systemName: "arrow.uturn.forward") }.buttonStyle(.prismIcon)
                    .help("Redo edit · ⌘⇧Z").disabled(model.redoHistory.isEmpty || model.isBusy)
                    .accessibilityLabel("Redo edit")
                Button { model.toggleSelectedAudio() } label: { Image(systemName: model.activeSegment?.isMuted == true ? "speaker.slash" : "speaker.wave.2") }.buttonStyle(.prismIcon)
                    .help("Toggle clip audio").disabled(model.activeSegment == nil || model.isBusy)
                    .accessibilityLabel("Toggle clip audio")
                Rectangle().fill(EditorStyle.line).frame(width: 1, height: 16)
                Text(model.activeSegment == nil ? "Source timeline" : "Short timeline").font(Prism.text(11, .medium))
                Spacer()
            }.font(Prism.text(12)).buttonStyle(.prismLink).padding(.horizontal, 18).frame(height: 42)
            Divider()
            ScrollView(.vertical) {
            HStack(spacing: 0) {
                VStack(spacing: 0) {
                    Color.clear.frame(height: 28)
                    trackLabel("Video", "film", height: 68)
                    trackLabel("Framing", "viewfinder", height: 28)
                    trackLabel("Captions", "captions.bubble", height: 38)
                    trackLabel("Audio", "waveform", height: 38)
                    Spacer(minLength: 0)
                }.frame(width: 100).background(EditorStyle.inset)
                GeometryReader { geometry in
                    let width = max(1, geometry.size.width - 24)
                    VStack(spacing: 8) {
                        HStack {
                            ForEach(0..<7, id: \.self) { index in
                                Text(editorTime(length * Double(index) / 6)).font(Prism.mono(11)).foregroundStyle(Prism.textSecondary)
                                if index != 6 { Spacer(minLength: 0) }
                            }
                        }.frame(height: 20)
                        videoTrack(width: width).frame(height: 60)
                            .simultaneousGesture(DragGesture(minimumDistance: 0).onChanged { value in
                                // On the source timeline the track holds clip buttons, so only a Short's track scrubs.
                                guard model.activeSegment != nil else { return }
                                model.seekPreview(to: Double(value.location.x / width) * length)
                            })
                        focusTrack(width: width).frame(height: 22)
                        textTrack(width: width).frame(height: 30)
                        HStack {
                            Image(systemName: model.activeSegment?.isMuted == true ? "speaker.slash.fill" : "waveform")
                            Text(model.activeSegment?.isMuted == true ? "Muted" : media?.hasAudio == true ? "Source audio" : "No audio")
                            Spacer()
                        }.font(Prism.text(11)).foregroundStyle(Prism.text).padding(.horizontal, 10)
                            .frame(height: 30).background(media?.hasAudio == true && model.activeSegment?.isMuted != true ? Prism.sky.opacity(0.22) : Prism.surface1, in: RoundedRectangle(cornerRadius: 4))
                    }.padding(.horizontal, 12).padding(.top, 4)
                    TimelineView(.periodic(from: .now, by: 0.1)) { _ in
                        let time = model.player?.currentTime().seconds ?? 0
                        let x = 12 + width * max(0, min(1, (time.isFinite ? time : 0) / length))
                        ZStack(alignment: .top) {
                            Rectangle().fill(.white).frame(width: 1, height: 173)
                            Image(systemName: "arrowtriangle.down.fill").font(Prism.text(11)).foregroundStyle(Prism.text).offset(y: -1)
                        }.position(x: x, y: 100).allowsHitTesting(false)
                    }
                    Color.clear.contentShape(Rectangle()).frame(height: 25)
                        .gesture(DragGesture(minimumDistance: 0).onChanged { value in
                            model.seekPreview(to: (value.location.x - 12) / width * length)
                        })
                        .accessibilityLabel("Timeline seek ruler")
                }
            }.frame(height: 235)
            }
        }.background(EditorStyle.panel)
    }
    func trackLabel(_ title: String, _ icon: String, height: CGFloat) -> some View {
        Label(title, systemImage: icon).font(Prism.text(11)).foregroundStyle(Prism.textSecondary)
            .frame(maxWidth: .infinity, alignment: .leading).padding(.leading, 15).frame(height: height)
    }
    func videoTrack(width: CGFloat) -> some View {
        ZStack(alignment: .leading) {
            RoundedRectangle(cornerRadius: 8).fill(Prism.surface2)
            if let media {
                TimelineFilmstrip(media: media, start: model.activeSegment?.start ?? 0,
                                  length: model.activeSegment?.duration ?? media.duration, width: width, height: 60)
                    .opacity(0.82)
                Text(media.name).font(Prism.text(11, .medium)).lineLimit(1)
                    .padding(5).background(.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 3)).padding(6)
                if model.activeSegment == nil {
                    ForEach(model.project?.segments.filter { $0.mediaID == media.id } ?? []) { clip in
                        Button { model.selectPreview(clip.id) } label: {
                            RoundedRectangle(cornerRadius: 4).fill(EditorStyle.accent.opacity(0.3))
                                .overlay(RoundedRectangle(cornerRadius: 4).stroke(EditorStyle.accent, lineWidth: 2))
                        }.buttonStyle(.plain).frame(width: max(6, width * clip.duration / length), height: 60)
                            .offset(x: width * clip.start / length).accessibilityLabel("Select clip at \(editorTime(clip.start))")
                    }
                }
            } else {
                Text("Add a video to start your timeline").font(Prism.text(12)).foregroundStyle(Prism.textSecondary).padding(.leading, 12)
            }
        }.clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(model.activeSegment == nil ? Prism.surface2 : EditorStyle.accent, lineWidth: model.activeSegment == nil ? 1 : 2))
    }
    func textTrack(width: CGFloat) -> some View {
        ZStack(alignment: .leading) {
            RoundedRectangle(cornerRadius: 4).fill(Prism.surface1)
            if let clip = model.activeSegment {
                let subtitles = clip.captions ?? []
                if !clip.caption.isEmpty {
                    let start = max(0, min(length, clip.captionStart ?? 0))
                    let duration = max(0, min(length - start, clip.captionDuration ?? clip.duration))
                    Text(clip.caption).font(Prism.text(11, .medium)).lineLimit(1).padding(.horizontal, 8)
                        .frame(width: max(1, width * duration / length), height: 30, alignment: .leading)
                        .background(Prism.amber.opacity(0.32), in: RoundedRectangle(cornerRadius: 4))
                        .offset(x: width * start / length)
                        .accessibilityLabel("Text overlay from \(editorTime(start)) for \(editorTime(duration))")
                }
                ForEach(Array(subtitles.enumerated()), id: \.offset) { _, cue in
                    let start = max(0, min(length, cue.start))
                    let duration = max(0, min(length - start, cue.duration))
                    RoundedRectangle(cornerRadius: 3).fill(EditorStyle.accent.opacity(0.78))
                        .frame(width: max(2, width * duration / length), height: 9)
                        .offset(x: width * start / length, y: 8)
                        .accessibilityLabel("Subtitle \(cue.text) at \(editorTime(start))")
                }
                if clip.caption.isEmpty && subtitles.isEmpty {
                    Text("No text or subtitles").font(Prism.text(11)).foregroundStyle(Prism.textSecondary).padding(.leading, 10)
                }
            } else {
                Text("Select a Short to edit text and subtitles").font(Prism.text(11)).foregroundStyle(Prism.textSecondary).padding(.leading, 10)
            }
        }
    }

    func focusTrack(width: CGFloat) -> some View {
        GeometryReader { geometry in
            let height = geometry.size.height
            let points = model.activeSegment?.cropKeyframes ?? []
            let offset = (model.activeSegment?.cropPosition ?? 0.5) - 0.5
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 4).fill(EditorStyle.accent.opacity(0.06))
                if model.activeSegment?.splitScreen == true {
                    Text("Split screen · each half stays on its speaker").font(Prism.text(11)).foregroundStyle(Prism.textSecondary).padding(.leading, 8)
                } else if points.count > 1, let clip = model.activeSegment {
                    Path { path in
                        for (index, point) in points.enumerated() {
                            let x = width * min(1, max(0, point.time / max(0.1, clip.duration)))
                            let y = 2 + (1 - min(1, max(0, point.position + offset))) * max(1, height - 4)
                            if index == 0 { path.move(to: CGPoint(x: x, y: y)) }
                            else if point.isSceneCut == true { path.move(to: CGPoint(x: x, y: y)) }
                            else { path.addLine(to: CGPoint(x: x, y: y)) }
                        }
                    }.stroke(EditorStyle.accent, style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                    ForEach(Array(points.enumerated()), id: \.offset) { _, point in
                        Circle().fill(.white).frame(width: 4, height: 4)
                            .position(x: width * min(1, max(0, point.time / max(0.1, clip.duration))),
                                      y: 2 + (1 - min(1, max(0, point.position + offset))) * max(1, height - 4))
                    }
                } else if let point = points.first {
                    Path { path in
                        let y = 2 + (1 - min(1, max(0, point.position + offset))) * max(1, height - 4)
                        path.move(to: CGPoint(x: 0, y: y)); path.addLine(to: CGPoint(x: width, y: y))
                    }.stroke(EditorStyle.accent.opacity(0.85), style: StrokeStyle(lineWidth: 2, lineCap: .round))
                } else {
                    Text(model.activeSegment == nil ? "Select a Short to view its focus path" : "Click or drag to set focus")
                        .font(Prism.text(11)).foregroundStyle(Prism.textSecondary).padding(.leading, 8)
                }
            }
            .contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 0)
                .onEnded { value in
                    guard let clip = model.activeSegment, clip.splitScreen != true else { return }
                    let sourceTime = min(clip.duration, max(0, value.startLocation.x / max(1, width) * clip.duration))
                    let targetTime = min(clip.duration, max(0, value.location.x / max(1, width) * clip.duration))
                    let position = min(1, max(0, 1 - value.location.y / max(1, height)))
                    let moved = hypot(value.location.x - value.startLocation.x, value.location.y - value.startLocation.y) > 4
                    model.adjustCropKeyframe(from: sourceTime, to: targetTime, position: position, insert: !moved)
                })
            .help("Click to add a focus point or drag an existing point. The crop follows the line over time.")
            .accessibilityLabel("Subject focus path. Click to add or drag a focus point.")
        }
        .frame(width: width, height: 22)
    }
}

/// Frames across the stretch the timeline shows: the whole source, or only the selected Short's range.
private struct TimelineFilmstrip: View {
    let media: MediaItem
    let start: Double
    let length: Double
    let width: CGFloat
    let height: CGFloat
    @State private var frames: [NSImage] = []

    /// A frame a minute across a long source; a Short gets a dozen across its own seconds.
    private var sampleCount: Int { length > 720 ? min(120, Int(ceil(length / 60))) : 12 }

    var body: some View {
        HStack(spacing: 0) {
            if frames.isEmpty {
                if let path = media.thumbnail, let image = NSImage(contentsOfFile: path) {
                    Image(nsImage: image).resizable().scaledToFill()
                        .frame(width: width, height: height).clipped()
                }
            } else {
                ForEach(Array(frames.enumerated()), id: \.offset) { _, frame in
                    Image(nsImage: frame).resizable().scaledToFill()
                        .frame(width: width / CGFloat(frames.count), height: height).clipped()
                }
            }
        }
        .frame(width: width, height: height, alignment: .leading)
        .clipped()
        .task(id: "\(media.path)-\(start)-\(length)") { await makeFrames() }
    }

    @MainActor
    private func makeFrames() async {
        let path = media.path
        let duration = media.duration
        let count = sampleCount
        let start = start, length = length
        let images = await Task.detached(priority: .utility) { () -> [CGImage] in
            let generator = AVAssetImageGenerator(asset: AVURLAsset(url: URL(fileURLWithPath: path)))
            generator.appliesPreferredTrackTransform = true
            generator.maximumSize = CGSize(width: 240, height: 140)
            return (0..<count).compactMap { index in
                let seconds = min(start + length * (Double(index) + 0.5) / Double(count), max(0, duration - 0.1))
                return try? generator.copyCGImage(at: CMTime(seconds: seconds, preferredTimescale: 600), actualTime: nil)
            }
        }.value
        frames = images.map { NSImage(cgImage: $0, size: .zero) }
    }
}

private func editorTime(_ value: Double) -> String {
    let seconds = Int(max(0, value.isFinite ? value : 0))
    return String(format: "%02d:%02d", seconds / 60, seconds % 60)
}
