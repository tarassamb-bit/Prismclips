# Prism for Windows

Native, code-only WPF interface sharing the Gemini engine and app model with Linux in `Shared/Prism.Core`. The library is separate from the macOS app.

## Requirements

- Windows with .NET 10 SDK to build; a published framework-dependent app needs the .NET 10 **Desktop Runtime**.
- `ffmpeg.exe` and `ffprobe.exe`: use a build with **libx264**, **libx265** and **libass**. Put both beside `Prism.exe` or on `PATH`.
- Windows media playback support for H.264/AAC MP4 previews. Windows N editions may need the Media Feature Pack. Preview videos use H.264; playing exported HEVC files may require HEVC playback support.
- A Google AI Studio API key. Gemini is the only AI provider.

Prism uses WPF `MediaElement` for playback and ffmpeg for rendering. The application explains missing ffmpeg tools when an import/render requires them.

## Build and run

From the repository root in PowerShell:

```powershell
dotnet build Windows/Prism.Windows
dotnet run --project Windows/Prism.Windows
```

The first window is a blocking **Welcome to Prism** card. Paste a Google AI Studio key and choose **Save and continue**. Google rejects invalid keys; a temporary Google/network outage does not prevent saving a key. Settings can show, replace, remove and test it.

To select explicit ffmpeg paths:

```powershell
$env:PRISM_FFMPEG = 'C:\Tools\ffmpeg\bin\ffmpeg.exe'
$env:PRISM_FFPROBE = 'C:\Tools\ffmpeg\bin\ffprobe.exe'
dotnet run --project Windows/Prism.Windows
```

Optional framework-dependent distribution:

```powershell
dotnet publish Windows/Prism.Windows -c Release -r win-x64 --self-contained false -o dist/win-x64
.\dist\win-x64\Prism.exe
```

Use `win-arm64` for Windows on ARM. Keep the complete output folder, including libraries, `Fonts/` and `Brand/`, and supply ffmpeg/ffprobe as above. The three Prism font families and their OFL licenses ship with the app.

The project uses `EnableWindowsTargeting` and can compile on macOS/Linux. WPF can only run on Windows.

## Preview from a Mac

`zsh Windows/preview.sh` runs the last commit on a GitHub Windows machine and opens its screen in your browser (`.github/workflows/windows-preview.yml`). The first run creates the `PREVIEW_PASSWORD` secret and keeps it in the Mac Keychain. Needs `gh` signed in with write access to the repo. Ctrl+C ends the session; it stops by itself after 3 hours. The screen has no GPU, so animations are slower than on a real PC.

## Files and desktop behavior

- Projects: `%LOCALAPPDATA%\Prism\Library\Projects`.
- Settings: `%APPDATA%\Prism\settings.json`.
- Key: `%APPDATA%\Prism\gemini.key`, encrypted with Windows DPAPI for the current Windows user.
- Downloads is resolved with the Windows known-folder API, including redirected locations. Exports default to `Downloads\Prism\<project title>`; the export card can choose another folder, tick Shorts and include untouched sources.
- Project removal uses the Recycle Bin. Export reveal selects files in Explorer, with `explorer.exe /select` as a fallback.

No .NET code reads or writes the macOS Relio library or Keychain.

## Check on a Windows PC

1. Launch with no saved Prism key. Confirm the welcome card blocks navigation, invalid keys are rejected, and the saved key survives restarting Prism. Test show/hide, replace, remove and connection testing in Settings.
2. Import a video using the dialog, file drop and typed path. Follow the five stages: video, settings, captions, content type, review/export. Check custom-range validation. Generate a batch, then cancel another; earlier Shorts must remain.
3. Play and seek source/Short previews. Try Fill, Fit, Split, captions/text/layout, trim, mute, undo, a manual clip from the source playhead and focus-point clicks/drags. Check Space, arrows, Shift+arrows, Delete and Ctrl+Z; typing and cards must suppress editor shortcuts. Try editor chat, both themes and pane resizing.
4. Export one Short, then all Shorts plus the source, with each quality. Check MP4 playback, framing, captions, audio, filenames and Explorer reveal. Try an unusable folder: the reason must stay on the export card. Cancel an export and inspect completed/temporary files.
5. On Home, create/rename folders, drag projects between them, remove folder membership, rename projects and inspect stats. Recycle a disposable open project and restore it from the Recycle Bin. Reopen a different project and check Exports points to its folder. Change the resource refresh interval.

## Automated checks

With ffmpeg/ffprobe available:

```powershell
dotnet test Shared/Prism.Core.Tests
```

The shared tests use temporary libraries/config/cache, fake key stores and fake Gemini HTTP replies. They never touch a real library or key. The WPF app was cross-compiled on the development Mac; Windows playback, DPAPI, Explorer, Recycle Bin and visual layout need the PC checks above.
