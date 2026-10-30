using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using Prism.Core;

namespace Prism.Linux;

/// <summary>Linux desktop integration; command arguments never pass through a shell.</summary>
public sealed class LinuxPlatform : IPlatform
{
    public IKeyStore AccountStore { get; } = new LinuxKeyStore("account", "Prism account sign-in");

    public string DownloadsFolder
    {
        get
        {
            var result = Run("xdg-user-dir", ["DOWNLOAD"]);
            var path = result.Output.Trim();
            return result.Code == 0 && Path.IsPathRooted(path) ? path
                : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");
        }
    }

    public void MoveToTrash(string path)
    {
        path = Path.GetFullPath(path);
        if (Run("gio", ["trash", "--", path]).Code == 0) return;
        // The home-volume freedesktop Trash fallback. A failed cross-volume move leaves the original intact.
        var dataHome = Environment.GetEnvironmentVariable("XDG_DATA_HOME");
        var trash = Path.Combine(string.IsNullOrWhiteSpace(dataHome)
            ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".local", "share") : dataHome, "Trash");
        var files = Path.Combine(trash, "files");
        var info = Path.Combine(trash, "info");
        PrivateDirectory(trash);
        PrivateDirectory(files);
        PrivateDirectory(info);
        var name = Path.GetFileName(Path.TrimEndingDirectorySeparator(path));
        var candidate = name;
        for (var suffix = 2; File.Exists(Path.Combine(files, candidate)) || Directory.Exists(Path.Combine(files, candidate))
            || File.Exists(Path.Combine(info, candidate + ".trashinfo")); suffix++) candidate = name + "." + suffix;
        var metadata = Path.Combine(info, candidate + ".trashinfo");
        var encoded = string.Join("/", path.Split('/').Select(Uri.EscapeDataString));
        File.WriteAllText(metadata, "[Trash Info]\nPath=" + encoded + "\nDeletionDate="
            + DateTime.Now.ToString("yyyy-MM-dd'T'HH:mm:ss", CultureInfo.InvariantCulture) + "\n");
        PrivateFile(metadata);
        try
        {
            if (Directory.Exists(path)) Directory.Move(path, Path.Combine(files, candidate));
            else File.Move(path, Path.Combine(files, candidate));
        }
        catch { File.Delete(metadata); throw; }
    }

    public void Reveal(IReadOnlyList<string> paths)
    {
        if (paths.Count == 0) return;
        // gdbus expects a GVariant array. Escape each URI for that syntax, independently of shell quoting.
        var uris = "[" + string.Join(", ", paths.Select(path => "'" + new Uri(Path.GetFullPath(path)).AbsoluteUri
            .Replace("\\", "\\\\").Replace("'", "\\'") + "'")) + "]";
        if (Run("gdbus", ["call", "--session", "--dest", "org.freedesktop.FileManager1", "--object-path",
            "/org/freedesktop/FileManager1", "--method", "org.freedesktop.FileManager1.ShowItems", uris, ""]).Code == 0) return;
        OpenFolder(Directory.Exists(paths[0]) ? paths[0] : Path.GetDirectoryName(Path.GetFullPath(paths[0]))!);
    }

    public void OpenFolder(string path)
    {
        Directory.CreateDirectory(path);
        OpenExternal(Path.GetFullPath(path));
    }

    public static void OpenExternal(string target)
    {
        var result = Run("xdg-open", [target]);
        if (result.Code != 0) throw new IOException("The desktop could not open this location. Check that xdg-utils is installed.");
    }

    internal static (int Code, string Output, string Error) Run(string program, IEnumerable<string> arguments, string? input = null)
    {
        try
        {
            var start = new ProcessStartInfo(program) { UseShellExecute = false, RedirectStandardOutput = true,
                RedirectStandardError = true, RedirectStandardInput = input is not null, CreateNoWindow = true };
            foreach (var argument in arguments) start.ArgumentList.Add(argument);
            using var process = Process.Start(start);
            if (process is null) return (-1, "", "");
            var output = process.StandardOutput.ReadToEndAsync();
            var error = process.StandardError.ReadToEndAsync();
            if (input is not null) { process.StandardInput.Write(input); process.StandardInput.Close(); }
            if (!process.WaitForExit(10_000))
            {
                process.Kill(entireProcessTree: true);
                process.WaitForExit();
                return (-1, "", "The desktop service did not respond.");
            }
            return (process.ExitCode, output.GetAwaiter().GetResult(), error.GetAwaiter().GetResult());
        }
        catch (Exception error) when (error is System.ComponentModel.Win32Exception or IOException or InvalidOperationException)
        { return (-1, "", "The desktop command is unavailable."); }
    }

    internal static void PrivateDirectory(string path)
    {
        Directory.CreateDirectory(path);
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
    }

    internal static void PrivateFile(string path)
    {
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
    }

    public static void RegisterFonts()
    {
        try
        {
            var config = FcConfigGetCurrent();
            FcConfigAppFontAddDir(config, Path.Combine(AppContext.BaseDirectory, "Fonts"));
            FcConfigBuildFonts(config);
        }
        catch (DllNotFoundException) { }
        catch (EntryPointNotFoundException) { }
    }

    [DllImport("libfontconfig.so.1")] static extern IntPtr FcConfigGetCurrent();
    [DllImport("libfontconfig.so.1", CharSet = CharSet.Ansi)] static extern int FcConfigAppFontAddDir(IntPtr config, string directory);
    [DllImport("libfontconfig.so.1")] static extern int FcConfigBuildFonts(IntPtr config);
}

/// <summary>Secret Service first; a private 0600 file when a desktop keyring is unavailable.</summary>
public sealed class LinuxKeyStore(string name, string label) : IKeyStore
{
    string KeyPath => Path.Combine(AppPaths.Config, name + ".key");
    string[] Attributes => ["application", "prism", "provider", name];

    public string Read()
    {
        // A fallback can hold a newer replacement while the desktop collection is locked.
        if (File.Exists(KeyPath)) { LinuxPlatform.PrivateFile(KeyPath); return File.ReadAllText(KeyPath).Trim(); }
        var result = LinuxPlatform.Run("secret-tool", ["lookup", .. Attributes]);
        return result.Code == 0 ? result.Output.Trim() : "";
    }

    public void Save(string key)
    {
        key = key.Trim();
        if (key.Length == 0)
        {
            var cleared = LinuxPlatform.Run("secret-tool", ["clear", .. Attributes]);
            if (cleared.Code > 0 && cleared.Error.Trim().Length > 0)
                throw new IOException("The desktop keyring could not remove the saved key. Unlock it and try again.");
            File.Delete(KeyPath);
            return;
        }
        if (LinuxPlatform.Run("secret-tool", ["store", "--label=" + label, .. Attributes], key + "\n").Code == 0)
        { File.Delete(KeyPath); return; }
        LinuxPlatform.PrivateDirectory(AppPaths.Config);
        var temporary = KeyPath + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            var options = new FileStreamOptions { Mode = FileMode.CreateNew, Access = FileAccess.Write, Share = FileShare.None };
            if (!OperatingSystem.IsWindows()) options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
            using (var stream = new FileStream(temporary, options))
            using (var writer = new StreamWriter(stream)) writer.Write(key);
            LinuxPlatform.PrivateFile(temporary);
            File.Move(temporary, KeyPath, overwrite: true);
        }
        finally { File.Delete(temporary); }
    }
}
