using System.ComponentModel;

namespace Prism.Core;

/// The first-video tutorial, a port of the macOS app's FirstRunTutorial. Progress follows real app events: merely importing a
/// video or opening the editor never completes it. Completion is kept separately for each account on this computer.
public sealed class FirstRunTutorial(AppSettings settings) : INotifyPropertyChanged
{
    public enum Step { Start, Upload, Settings, Captions, ContentType, Retry, Created, Shorts, Preview, Editing, Timeline, Export }
    public enum Flow { Home, Upload, Settings, Captions, ContentType, Editor, Other }

    public event PropertyChangedEventHandler? PropertyChanged;
    Step? step;
    string? email;

    public Step? Current
    {
        get => step;
        private set { if (step == value) return; step = value; PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(Current))); }
    }
    public bool IsActive => step is not null;
    public static bool IsEditorTour(Step step) => step is Step.Shorts or Step.Preview or Step.Editing or Step.Timeline or Step.Export;

    public void Connect(string? address)
    {
        var normalized = address?.Trim().ToLowerInvariant();
        if (normalized == email) return;
        email = normalized;
        Current = normalized is null || settings.TutorialCompletedAccounts.Contains(normalized) ? null : Step.Start;
    }

    public void Restart(string address)
    {
        email = address.Trim().ToLowerInvariant();
        Current = Step.Start;
    }

    public void Follow(Flow flow)
    {
        if (step is not { } current || current == Step.Created || IsEditorTour(current)) return;
        Current = flow switch
        {
            Flow.Home => Step.Start, Flow.Upload => Step.Upload, Flow.Settings => Step.Settings, Flow.Captions => Step.Captions,
            Flow.ContentType => Step.ContentType, Flow.Editor => Step.Retry, _ => current,
        };
    }

    /// <summary>Called only after a nonempty generated batch has been saved successfully.</summary>
    public void DidCreateVideo()
    {
        if (!IsActive || email is null) return;
        if (!settings.TutorialCompletedAccounts.Contains(email))
        {
            settings.TutorialCompletedAccounts.Add(email);
            try { settings.Save(); } catch (Exception) { }
        }
        Current = Step.Created;
    }

    public void ExploreEditor() { if (step == Step.Created) Current = Step.Shorts; }

    public void Next() => Current = step switch
    {
        Step.Shorts => Step.Preview, Step.Preview => Step.Editing, Step.Editing => Step.Timeline, Step.Timeline => Step.Export,
        Step.Export => null, _ => step,
    };

    /// <summary>An unfinished guide returns on the next sign-in or launch; it is never marked complete by dismissal.</summary>
    public void Dismiss() => Current = null;

    public static string Progress(Step step) => step switch
    {
        Step.Start => "FIRST VIDEO · 1 OF 6", Step.Upload => "FIRST VIDEO · 2 OF 6", Step.Settings => "FIRST VIDEO · 3 OF 6",
        Step.Captions => "FIRST VIDEO · 4 OF 6", Step.ContentType or Step.Retry => "FIRST VIDEO · 5 OF 6", Step.Created => "FIRST VIDEO · 6 OF 6",
        Step.Shorts => "EDITOR TOUR · 1 OF 5", Step.Preview => "EDITOR TOUR · 2 OF 5", Step.Editing => "EDITOR TOUR · 3 OF 5",
        Step.Timeline => "EDITOR TOUR · 4 OF 5", _ => "EDITOR TOUR · 5 OF 5",
    };

    public static string Title(Step step) => step switch
    {
        Step.Start => "Let’s create your first video.",
        Step.Upload => "Add a video to work with.",
        Step.Settings => "Make it your Short.",
        Step.Captions => "Give your words a style.",
        Step.ContentType => "Ready to create?",
        Step.Retry => "Let’s finish your first video.",
        Step.Created => "You created your first video.",
        Step.Shorts => "Your Shorts live here.",
        Step.Preview => "Watch before you share.",
        Step.Editing => "Make every word yours.",
        Step.Timeline => "Fine-tune the moment.",
        _ => "Save a video you can share.",
    };

    public static string Detail(Step step) => step switch
    {
        Step.Start => "Follow this quick tutorial to make your first Short. Click the highlighted Start creating card to begin.",
        Step.Upload => "Drop a video into the highlighted area, click Browse files, or paste a file path. A short video with clear speech is a good first choice.",
        Step.Settings => "Choose how many Shorts to make, their length, and the section to analyze. Auto works well to start. Then click Next: Choose captions.",
        Step.Captions => "Pick a caption style, or leave Auto selected. You can change it later. Scroll down and click Next: Choose content type.",
        Step.ContentType => "Choose the kind of video, or keep Auto. Scroll down and click Analyze and create Shorts. Prism will find the moments and prepare your clips.",
        Step.Retry => "No video has been created yet. Return to setup to try again with this video. Your project is kept.",
        Step.Created => "Your first Short is ready in the editor. Review it before exporting. You can finish here, or take a quick tour of the editing tools.",
        Step.Shorts => "Select a Short to open it. Each clip keeps its own framing, captions, and timing, so you can review every pick.",
        Step.Preview => "Play your Short here to check the framing and captions. Use the player controls to pause and review a moment.",
        Step.Editing => "Edit the captions here. Select a Short first, then adjust its words and caption style before sharing.",
        Step.Timeline => "Use the timeline to inspect timing, trim your clip, and adjust its focus. Changes are saved to your project automatically.",
        _ => "Click Export when you’re ready. Choose your Shorts and quality, then save the finished MP4 videos.",
    };
}
