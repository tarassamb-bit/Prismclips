using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Shapes;
using Prism.Core;
using Step = Prism.Core.FirstRunTutorial.Step;
using Flow = Prism.Core.FirstRunTutorial.Flow;

namespace Prism.Windows;

/// The first-video tutorial, as on the Mac: a shade with a cutout over the real control, and a coach bar reserved at the bottom,
/// so the instructions never cover what they point at. Only the highlighted control stays clickable.
public sealed partial class PrismWindow
{
    readonly Dictionary<Step, FrameworkElement> tutorialTargets = [];
    readonly Canvas tutorialShade = new() { Visibility = Visibility.Collapsed };
    readonly Border tutorialCoach = new() { Visibility = Visibility.Collapsed, BorderThickness = new Thickness(0, 1, 0, 0), Padding = new Thickness(28, 20, 28, 20) };
    string? tutorialEmail;
    string tutorialKey = "";
    Rect? lastSpotlight;

    T TutorialTarget<T>(Step step, T element) where T : FrameworkElement { tutorialTargets[step] = element; return element; }

    Flow TutorialFlow => session.Screen switch
    {
        Screen.Home => Flow.Home,
        Screen.Create or Screen.ImportSource => session.ShortsSource is null ? Flow.Upload : createStep >= 2 ? Flow.ContentType : createStep == 1 ? Flow.Captions : Flow.Settings,
        Screen.Editor => Flow.Editor,
        _ => Flow.Other,
    };

    bool TutorialVisible => session.Account.IsSignedIn && session.Tutorial.IsActive && !session.IsBusy && !session.IsPlayerExpanded
        && session.GenerationError is null && session.ExportChoice is null && session.ExportSummary is null && session.PendingPaidRun is null;

    /// Called at the end of every refresh: connects the tutorial to the signed-in account and follows the current screen.
    void UpdateTutorial()
    {
        var tutorial = session.Tutorial;
        if (tutorialEmail != session.Account.Email)
        {
            tutorialEmail = session.Account.Email;
            tutorial.Connect(tutorialEmail);
            if (tutorial.Current == Step.Start && session.Screen != Screen.Home) Dispatcher.BeginInvoke(new Action(() => { if (!disposed) Navigate(Screen.Home); }));
        }
        tutorial.Follow(TutorialFlow);
        var visible = TutorialVisible;
        var key = visible ? tutorial.Current?.ToString() ?? "" : "";
        if (key != tutorialKey) { tutorialKey = key; BuildCoach(); }
        tutorialCoach.Visibility = tutorialShade.Visibility = visible ? Visibility.Visible : Visibility.Collapsed;
        lastSpotlight = null;
        PlaceSpotlight();
    }

    void BuildCoach()
    {
        if (session.Tutorial.Current is not { } step) { tutorialCoach.Child = null; return; }
        var tutorial = session.Tutorial;
        var grid = new Grid();
        foreach (var width in new[] { GridLength.Auto, new GridLength(1, GridUnitType.Star), new GridLength(180) }) grid.ColumnDefinitions.Add(new ColumnDefinition { Width = width });
        var mark = new Border { Width = 48, Height = 48, CornerRadius = new CornerRadius(14), Margin = new Thickness(0, 0, 28, 0), VerticalAlignment = VerticalAlignment.Center,
            Child = Glyph(step == Step.Created ? "" : "", 24, "Accent") };
        mark.SetResourceReference(Border.BackgroundProperty, "AccentWash");
        grid.Children.Add(mark);
        var progress = Text(FirstRunTutorial.Progress(step), 10, mono: true); progress.SetResourceReference(TextBlock.ForegroundProperty, "Accent"); progress.Margin = new Thickness(0, 0, 0, 7);
        var title = Text(FirstRunTutorial.Title(step), 21, display: true); title.Margin = new Thickness(0, 0, 0, 7);
        var words = Column(progress, title, Text(FirstRunTutorial.Detail(step), 12, muted: true)); words.VerticalAlignment = VerticalAlignment.Center;
        Grid.SetColumn(words, 1); grid.Children.Add(words);
        Button Wide(Button button) { button.HorizontalAlignment = HorizontalAlignment.Stretch; button.Margin = new Thickness(0, 0, 0, 10); return button; }
        var actions = Column(); actions.VerticalAlignment = VerticalAlignment.Center; actions.Margin = new Thickness(28, 0, 0, 0);
        if (step == Step.Created)
        {
            actions.Children.Add(Wide(Button("Done", tutorial.Dismiss, true)));
            actions.Children.Add(Wide(Button("Show me the editor", tutorial.ExploreEditor)));
        }
        else if (FirstRunTutorial.IsEditorTour(step))
        {
            actions.Children.Add(Wide(Button(step == Step.Export ? "Finish tutorial" : "Next", tutorial.Next, true)));
            actions.Children.Add(Wide(Link(Button("Finish tour", tutorial.Dismiss))));
        }
        else
        {
            if (step == Step.Retry) actions.Children.Add(Wide(Button("Return to setup", () => { createStep = 0; session.Screen = Screen.ImportSource; Refresh(); }, true)));
            actions.Children.Add(Wide(Link(Button("Finish later", tutorial.Dismiss))));
        }
        Grid.SetColumn(actions, 2); grid.Children.Add(actions);
        tutorialCoach.Child = grid;
        System.Windows.Automation.AutomationProperties.SetName(tutorialCoach, FirstRunTutorial.Title(step));
    }

    FrameworkElement? CurrentTarget(Step step)
        => FirstRunTutorial.IsEditorTour(step) ? editor.TutorialTargets.GetValueOrDefault(step) : tutorialTargets.GetValueOrDefault(step);

    /// Redrawn only when the highlighted control moved, so it follows scrolling and resizing without a layout loop.
    void PlaceSpotlight()
    {
        if (tutorialShade.Visibility != Visibility.Visible || session.Tutorial.Current is not { } step) return;
        var whole = new Rect(0, 0, tutorialShade.ActualWidth, tutorialShade.ActualHeight);
        if (whole.IsEmpty || whole.Width == 0) return;
        Rect spot = Rect.Empty;
        if (CurrentTarget(step) is { IsVisible: true } target && target.ActualWidth > 0 && target.IsDescendantOf(this))
        {
            spot = target.TransformToVisual(tutorialShade).TransformBounds(new Rect(target.RenderSize));
            // On the setup pages, only the part inside the scrolling page is highlighted, never what is scrolled away.
            if (session.Screen != Screen.Editor && content.IsDescendantOf(this))
                spot.Intersect(content.TransformToVisual(tutorialShade).TransformBounds(new Rect(content.RenderSize)));
            if (!spot.IsEmpty) { spot.Inflate(4, 4); spot.Intersect(whole); }
        }
        var key = spot.IsEmpty ? whole : spot;
        if (lastSpotlight == key && tutorialShade.Children.Count > 0) return;
        lastSpotlight = key;
        tutorialShade.Children.Clear();
        var shape = new GeometryGroup { FillRule = FillRule.EvenOdd };
        shape.Children.Add(new RectangleGeometry(whole));
        if (!spot.IsEmpty) shape.Children.Add(new RectangleGeometry(spot, 14, 14));
        tutorialShade.Children.Add(new Path { Data = shape, Fill = new SolidColorBrush(Color.FromArgb(171, 0, 0, 0)) });
        if (spot.IsEmpty) return;
        var ring = new Rectangle { Width = spot.Width, Height = spot.Height, RadiusX = 14, RadiusY = 14, StrokeThickness = 2, IsHitTestVisible = false };
        ring.SetResourceReference(Shape.StrokeProperty, "Action");
        Canvas.SetLeft(ring, spot.X); Canvas.SetTop(ring, spot.Y);
        tutorialShade.Children.Add(ring);
    }
}
