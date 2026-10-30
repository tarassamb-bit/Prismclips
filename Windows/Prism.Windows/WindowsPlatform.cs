using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.VisualBasic.FileIO;
using Prism.Core;

namespace Prism.Windows;

/// <summary>The Windows shell and user-scoped credential store. No macOS paths are used.</summary>
public sealed class WindowsPlatform : IPlatform
{
    public IKeyStore AccountStore { get; } = new WindowsKeyStore("account", "Prism.Account");
    static readonly Guid DownloadsId = new("374DE290-123F-4565-9164-39C4925E467B");

    public string DownloadsFolder
    {
        get
        {
            var id = DownloadsId;
            var result = SHGetKnownFolderPath(ref id, 0, IntPtr.Zero, out var pointer);
            try
            {
                if (result == 0 && Marshal.PtrToStringUni(pointer) is { Length: > 0 } path) return path;
            }
            finally { if (pointer != IntPtr.Zero) Marshal.FreeCoTaskMem(pointer); }
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");
        }
    }

    public void MoveToTrash(string path)
    {
        if (Directory.Exists(path))
            FileSystem.DeleteDirectory(path, UIOption.OnlyErrorDialogs, RecycleOption.SendToRecycleBin, UICancelOption.ThrowException);
        else FileSystem.DeleteFile(path, UIOption.OnlyErrorDialogs, RecycleOption.SendToRecycleBin, UICancelOption.ThrowException);
    }

    public void Reveal(IReadOnlyList<string> paths)
    {
        // Group by folder so an export batch opens one Explorer window with all its files selected.
        foreach (var group in paths.Select(Path.GetFullPath).GroupBy(path => Path.GetDirectoryName(path)!))
        {
            var folder = ILCreateFromPath(group.Key);
            if (folder == IntPtr.Zero) { OpenFolder(group.Key); continue; }
            var items = group.Select(ILCreateFromPath).Where(pointer => pointer != IntPtr.Zero).ToArray();
            try
            {
                var children = items.Select(ILFindLastID).ToArray();
                if (items.Length == 0 || SHOpenFolderAndSelectItems(folder, (uint)children.Length, children, 0) != 0)
                    RevealOne(group.First());
            }
            finally
            {
                foreach (var item in items) ILFree(item);
                ILFree(folder);
            }
        }
    }

    static void RevealOne(string path)
    {
        var start = new ProcessStartInfo("explorer.exe") { UseShellExecute = false };
        start.Arguments = "/select,\"" + Path.GetFullPath(path).Replace("\"", "") + "\"";
        using var process = Process.Start(start);
        if (process is null) throw new IOException("File Explorer could not show this file.");
    }

    public void OpenFolder(string path)
    {
        Directory.CreateDirectory(path);
        OpenExternal(Path.GetFullPath(path));
    }

    public static void OpenExternal(string target)
    {
        using var process = Process.Start(new ProcessStartInfo(target) { UseShellExecute = true });
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    static extern int SHGetKnownFolderPath(ref Guid folder, uint flags, IntPtr token, out IntPtr path);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr ILCreateFromPath(string path);
    [DllImport("shell32.dll")] static extern void ILFree(IntPtr item);
    [DllImport("shell32.dll")] static extern IntPtr ILFindLastID(IntPtr item);
    [DllImport("shell32.dll")] static extern int SHOpenFolderAndSelectItems(IntPtr folder, uint count, [In] IntPtr[] items, uint flags);
}

public sealed class WindowsKeyStore(string name, string entropy) : IKeyStore
{
    readonly byte[] Entropy = Encoding.UTF8.GetBytes(entropy);
    string KeyPath => Path.Combine(AppPaths.Config, name + ".key");

    public string Read()
    {
        if (!File.Exists(KeyPath)) return "";
        return Encoding.UTF8.GetString(ProtectedData.Unprotect(File.ReadAllBytes(KeyPath), Entropy, DataProtectionScope.CurrentUser)).Trim();
    }

    public void Save(string key)
    {
        key = key.Trim();
        if (key.Length == 0) { File.Delete(KeyPath); return; }
        var encrypted = ProtectedData.Protect(Encoding.UTF8.GetBytes(key), Entropy, DataProtectionScope.CurrentUser);
        Directory.CreateDirectory(AppPaths.Config);
        var temporary = KeyPath + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None)) stream.Write(encrypted);
            File.Move(temporary, KeyPath, overwrite: true);
        }
        finally { File.Delete(temporary); }
    }
}
