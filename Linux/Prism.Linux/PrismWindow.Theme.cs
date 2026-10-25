namespace Prism.Linux;

public sealed partial class PrismWindow
{
    readonly List<Action> appearanceUpdates = [];
    bool cssInstalled;

    /// The Prism design system as GTK CSS: the Mac app's surfaces, type scale, buttons and cards.
    void ApplyTheme()
    {
        var light = session.Settings.Appearance == "light";
        var background = light ? "#F6F3EC" : "#0E0F14";
        var surface = light ? "#FFFFFF" : "#171920";
        var inset = light ? "#EDE9E0" : "#20232B";
        var border = light ? "#E2DED4" : "#2C2F37";
        var text = light ? "#0E0F14" : "#F6F3EC";
        var muted = light ? "#5C6068" : "#8A8F98";
        var accent = light ? "#0B6CB5" : "#3FA9F5";
        var amber = light ? "#8F5E00" : "#FFC233";
        if (Gtk.Settings.GetDefault() is { } settings) settings.GtkApplicationPreferDarkTheme = !light;
        css.LoadFromString($$"""
            window, .background { background: {{background}}; color: {{text}}; font-family: Sora, sans-serif; font-size: 13px; font-weight: 400; }
            label { color: {{text}}; }
            .display { font-family: 'Space Grotesk'; font-weight: 500; }
            .d36 { font-family: 'Space Grotesk'; font-weight: 500; font-size: 36px; }
            .d32 { font-family: 'Space Grotesk'; font-weight: 500; font-size: 32px; }
            .d24 { font-family: 'Space Grotesk'; font-weight: 500; font-size: 24px; }
            .d22 { font-family: 'Space Grotesk'; font-weight: 500; font-size: 22px; }
            .d20 { font-family: 'Space Grotesk'; font-weight: 500; font-size: 20px; }
            .d18 { font-family: 'Space Grotesk'; font-weight: 500; font-size: 18px; }
            .title { font-family: 'Space Grotesk'; font-size: 32px; font-weight: 500; }
            .subtitle { font-family: 'Space Grotesk'; font-size: 20px; font-weight: 500; }
            .medium { font-weight: 500; }
            .t16 { font-size: 16px; } .t14 { font-size: 14px; } .t13 { font-size: 13px; } .t12 { font-size: 12px; } .t11 { font-size: 11px; } .t10 { font-size: 10px; } .t9 { font-size: 9px; }
            .muted, .muted label { color: {{muted}}; }
            .muted { font-size: 12px; }
            .mono { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: {{muted}}; }
            .accent, .accent label { color: {{accent}}; }
            .warning, .warning label { color: {{amber}}; }
            .danger, button.danger label { color: #FF6B57; }
            .ink-text, .ink-text label { color: #0E0F14; }

            .sidebar { padding: 24px; background: {{surface}}; border-right: 1px solid {{border}}; }
            .topbar { padding: 16px 20px; }
            .section { padding: 24px; }
            .divider { background: {{border}}; min-height: 1px; min-width: 1px; }
            separator { background: {{border}}; min-height: 1px; min-width: 1px; }

            button { color: {{text}}; background: transparent; border: 1px solid {{border}}; border-radius: 8px; padding: 0 16px; min-height: 40px;
                     box-shadow: none; text-shadow: none; font-size: 14px; font-weight: 500; transition: background 120ms ease-out; }
            button:hover { background: alpha({{text}}, 0.06); }
            button:active { background: alpha({{text}}, 0.12); }
            button:disabled { opacity: 0.4; }
            button:focus-visible { outline: 2px solid {{accent}}; outline-offset: 2px; }
            button.primary { background: #3FA9F5; border-color: #3FA9F5; }
            button.primary:hover { background: #57B4F7; }
            button.primary label, button.primary image { color: #0E0F14; }
            button.ghost { border-color: transparent; }
            button.link { border-color: transparent; min-height: 0; padding: 5px 8px; font-size: 13px; }
            button.link, button.link label, button.link image { color: {{muted}}; }
            button.link.accent label, button.link.accent image { color: {{accent}}; }
            button.compact { min-height: 32px; padding: 0 12px; font-size: 12px; }
            button.icon { min-height: 30px; min-width: 30px; padding: 0; border-color: transparent; }

            button.nav { border: none; border-radius: 8px; padding: 10px 12px; min-height: 0; font-size: 14px; font-weight: 400; }
            button.nav.selected { background: {{inset}}; font-weight: 500; }
            button.nav.prominent { background: #3FA9F5; padding: 13px 12px; font-weight: 500; }
            button.nav.prominent:hover { background: #57B4F7; }
            button.nav.prominent label { color: #0E0F14; }

            button.hero { background: #3FA9F5; border: none; border-radius: 16px; padding: 16px 26px 16px 22px; min-height: 86px; }
            button.hero:hover { background: #57B4F7; }
            button.hero label { color: #0E0F14; }
            .plus-tile { background: #0E0F14; border-radius: 6px; }
            .plus-tile label, button.hero .plus-tile label, button.nav.prominent .plus-tile label { color: #3FA9F5; font-weight: 700; }

            button.tile { background: {{surface}}; border: 2px solid transparent; border-radius: 12px; padding: 8px; min-height: 0; font-weight: 400; font-size: 13px; }
            button.tile:hover { background: mix({{surface}}, {{text}}, 0.04); }
            button.tile.selected { background: {{inset}}; border-color: {{accent}}; }
            button.tile.target { background: alpha({{accent}}, 0.14); border-color: {{accent}}; }
            button.category { background: {{surface}}; border: 1px solid {{inset}}; border-radius: 12px; padding: 14px; min-height: 0; font-weight: 400; }
            button.category.selected { background: alpha({{accent}}, 0.15); border: 2px solid {{accent}}; }
            .icon-box { background: {{inset}}; border-radius: 12px; min-width: 38px; min-height: 38px; }

            .surface { background: {{surface}}; border-radius: 16px; padding: 18px; }
            .surface-r12 { background: {{surface}}; border-radius: 12px; padding: 12px; }
            .inset { background: {{inset}}; border-radius: 12px; padding: 6px 6px 6px 11px; }
            .page-tile { background: {{background}}; border-radius: 12px; padding: 16px; }
            .card { padding: 20px; background: {{surface}}; border: 1px solid {{border}}; border-radius: 16px; }
            .dropzone { background: {{surface}}; border: 2px dashed {{border}}; border-radius: 16px; padding: 24px; }
            .dropzone.target { border-color: {{accent}}; background: alpha({{accent}}, 0.12); }
            .poster { background: {{inset}}; border-radius: 12px; }
            .badge { background: rgba(0,0,0,0.78); border-radius: 8px; padding: 3px 6px; }
            .badge label { color: #F6F3EC; font-family: 'Space Grotesk'; font-size: 10px; font-weight: 500; }

            .pill { background: {{inset}}; border-radius: 8px; padding: 2px; }
            .pill button { min-height: 24px; min-width: 30px; padding: 0; border: 1px solid transparent; border-radius: 6px; background: transparent; }
            .pill button label { color: {{muted}}; font-size: 13px; }
            .pill button.selected { background: {{surface}}; border-color: {{border}}; }
            .pill button.selected label { color: {{text}}; }

            entry, spinbutton, combobox, dropdown > button { background: {{inset}}; color: {{text}}; border: 1px solid {{inset}}; border-radius: 8px; box-shadow: none; }
            entry { padding: 6px 10px; min-height: 28px; }
            entry:focus-within { border-color: {{accent}}; outline: none; }
            entry.plain { background: transparent; border-color: transparent; padding: 4px 0; }
            combobox button { background: {{inset}}; border: 1px solid {{border}}; min-height: 34px; padding: 0 10px; font-weight: 400; font-size: 13px; }

            .scrim { background: rgba(0,0,0,0.55); }
            .scrim.gate { background: rgba(0,0,0,0.72); }
            .modal { padding: 24px; background: {{surface}}; border: 1px solid {{border}}; border-radius: 16px; }
            .bordered { border: 1px solid {{border}}; }
            progressbar trough { background: {{border}}; border-radius: 3px; min-height: 4px; }
            progressbar progress { background: {{accent}}; border-radius: 3px; min-height: 4px; }
            progressbar.thick trough, progressbar.thick progress { min-height: 7px; }
            progressbar.memory progress { background: #AF52DE; }
            progressbar.storage progress { background: #1FC7E6; }
            flowboxchild { padding: 0; background: transparent; outline: none; }
            popover contents { background: {{surface}}; border: 1px solid {{border}}; border-radius: 10px; padding: 4px; }
            popover button { border-color: transparent; min-height: 32px; font-weight: 400; font-size: 13px; }
            textview, textview text { background: {{inset}}; color: {{text}}; }
            tooltip { background: {{surface}}; border: 1px solid {{border}}; border-radius: 6px; }
            tooltip label { color: {{text}}; font-size: 12px; }
            notebook > header { background: {{surface}}; border-bottom: 1px solid {{border}}; box-shadow: none; }
            notebook > header tab { padding: 10px 10px 8px; border-bottom: 2px solid transparent; background: transparent; min-height: 0; }
            notebook > header tab label { color: {{muted}}; font-weight: 500; font-size: 12px; }
            notebook > header tab:checked { border-bottom-color: {{accent}}; }
            notebook > header tab:checked label { color: {{text}}; }
            notebook > stack { background: {{surface}}; }
            paned > separator { background: {{border}}; min-width: 1px; min-height: 1px; }
            scale trough { background: {{border}}; min-height: 4px; border-radius: 2px; }
            scale highlight { background: {{accent}}; border-radius: 2px; }
            scale slider { background: {{accent}}; min-width: 12px; min-height: 12px; border-radius: 6px; border: none; box-shadow: none; margin: -4px; }
            .player { background: #000000; }
            .player label { color: #F6F3EC; }
            .player-head { min-height: 40px; padding: 0 10px 0 16px; }
            .player-controls { min-height: 44px; padding: 0 14px 0 18px; }
            .time-now { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: {{accent}}; }
            .panel { background: {{surface}}; }
            .canvas { background: {{background}}; }
            button.tile.inset-tile { background: {{inset}}; border-width: 1px; padding: 5px; }
            button.tile.inset-tile.selected { background: alpha({{accent}}, 0.14); border-color: {{accent}}; }
            .shade { background: linear-gradient(to bottom, transparent 45%, rgba(0,0,0,0.7)); }
            .shade label { color: #F6F3EC; font-size: 11px; font-weight: 500; }
            button.remove { background: rgba(0,0,0,0.78); border: none; border-radius: 11px; min-width: 22px; min-height: 22px; padding: 0; }
            button.remove label { color: #FFFFFF; font-size: 11px; }
            button.seg { min-height: 30px; padding: 0 6px; font-size: 11px; font-weight: 400; background: {{inset}}; border-color: transparent; }
            button.seg label { color: {{muted}}; }
            button.seg.selected { background: alpha({{accent}}, 0.12); border-color: alpha({{accent}}, 0.5); }
            button.seg.selected label { color: {{accent}}; }
            button.wide { min-height: 0; padding: 9px 0; font-size: 12px; }
            button.footer-action { border: none; border-top: 1px solid {{border}}; border-radius: 0; min-height: 0; padding: 14px; font-size: 11px; }
            .bubble { background: {{inset}}; border-radius: 8px; padding: 10px; }
            .bubble.user { background: alpha({{accent}}, 0.12); }
            .number { min-width: 74px; }
            .number text { font-family: 'JetBrains Mono', monospace; font-size: 11px; }
            .preview-chip { background: #474747; border-radius: 8px; padding: 0 4px; }
            notebook.tools > header tab { min-width: 96px; padding: 12px 10px 8px; }
            notebook.tools > header tab label { font-size: 11px; }
            textview.overlay-text, textview.overlay-text text { background: {{inset}}; }
            .timeline-tools { min-height: 42px; padding: 0 18px; border-bottom: 1px solid {{border}}; background: {{surface}}; }
            .timeline-tools button.link { font-size: 12px; }
            headerbar.prism-titlebar { background: {{surface}}; border-bottom: 1px solid {{border}}; box-shadow: none; min-height: 34px; padding: 0 6px; }
            headerbar.prism-titlebar button { min-height: 24px; min-width: 24px; padding: 2px; border: none; background: transparent; }
            headerbar.prism-titlebar button:hover { background: alpha({{text}}, 0.08); }
            headerbar.prism-titlebar button.close:hover { background: #C42B1C; }
            headerbar.prism-titlebar button.close:hover image { color: #FFFFFF; }
            window.csd { border-radius: 10px; }
            button.tile, button.hero, button.category { transition: background 120ms ease-out, transform 120ms ease-out; }
            button.tile:hover, button.category:hover { transform: scale(1.015); }
            button.hero:hover { transform: scale(1.005); }
            .toolbar { padding: 0 20px; min-height: 54px; border-bottom: 1px solid {{border}}; background: {{surface}}; }
            .statusbar { padding: 0 16px; min-height: 28px; border-top: 1px solid {{border}}; background: {{surface}}; }
            """);
        // The provider is registered once; later theme switches only reload its stylesheet.
        if (!cssInstalled) { Gtk.StyleContext.AddProviderForDisplay(window.GetDisplay(), css, 800); cssInstalled = true; }
        foreach (var update in appearanceUpdates) update();
    }
}
