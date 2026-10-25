using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Data.Sqlite;

namespace Prism.Core;

/// JSON exactly as the macOS app writes it: camelCase names and enum values, uppercase UUIDs,
/// dates as seconds since 2001-01-01, and nil fields left out.
public static class PrismJson
{
    public static readonly JsonSerializerOptions Options = Create();

    static JsonSerializerOptions Create()
    {
        var options = new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
            PropertyNameCaseInsensitive = true,
            NumberHandling = JsonNumberHandling.AllowNamedFloatingPointLiterals,
        };
        options.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.CamelCase));
        options.Converters.Add(new UuidConverter());
        options.Converters.Add(new ReferenceDateConverter());
        return options;
    }

    public static string Serialize<T>(T value) => JsonSerializer.Serialize(value, Options);
    public static T? Deserialize<T>(string json) => JsonSerializer.Deserialize<T>(json, Options);

    /// <summary>A deep copy, used for undo snapshots.</summary>
    public static T Clone<T>(T value) => JsonSerializer.Deserialize<T>(JsonSerializer.Serialize(value, Options), Options)!;

    /// <summary>The key a media item's transcript is saved under, as macOS writes UUIDs.</summary>
    public static string Key(Guid id) => id.ToString("D").ToUpperInvariant();

    sealed class UuidConverter : JsonConverter<Guid>
    {
        public override Guid Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) => Guid.Parse(reader.GetString()!);
        public override void Write(Utf8JsonWriter writer, Guid value, JsonSerializerOptions options) => writer.WriteStringValue(Key(value));
    }

    /// Swift's default Date encoding: a number of seconds since 2001-01-01 UTC.
    sealed class ReferenceDateConverter : JsonConverter<DateTime>
    {
        static readonly DateTime Reference = new(2001, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        public override DateTime Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
            reader.TokenType == JsonTokenType.Number
                ? Reference.AddSeconds(reader.GetDouble())
                : DateTime.Parse(reader.GetString()!, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal);
        public override void Write(Utf8JsonWriter writer, DateTime value, JsonSerializerOptions options) =>
            writer.WriteNumberValue((value.ToUniversalTime() - Reference).TotalSeconds);
    }
}

public sealed class StoreException(string message) : Exception(message);

/// A project's SQLite file: one table of JSON values by key, the same layout as the macOS app.
public sealed class ProjectStore : IDisposable
{
    public string Root { get; }
    readonly SqliteConnection connection;

    /// <param name="create">False opens only an existing project, so reading a moved, deleted or wrong folder never leaves a database behind.</param>
    public ProjectStore(string root, bool create = true)
    {
        Root = root;
        var file = System.IO.Path.Combine(root, "project.sqlite");
        if (create) Directory.CreateDirectory(root);
        else if (!File.Exists(file)) throw new StoreException("This folder is not a Prism project.");
        connection = new SqliteConnection(new SqliteConnectionStringBuilder
        { DataSource = file, Mode = create ? SqliteOpenMode.ReadWriteCreate : SqliteOpenMode.ReadWrite, Pooling = false }.ToString());
        try
        {
            connection.Open();
            Execute("PRAGMA journal_mode=WAL");
            if (create) Execute("CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value BLOB NOT NULL)");
        }
        catch (SqliteException error) { connection.Dispose(); throw new StoreException($"The project database could not be read or saved. {error.Message}"); }
    }

    void Execute(string sql)
    {
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        command.ExecuteNonQuery();
    }

    public void Save<T>(T value, string key)
    {
        var data = JsonSerializer.SerializeToUtf8Bytes(value, PrismJson.Options);
        using var command = connection.CreateCommand();
        command.CommandText = "INSERT OR REPLACE INTO state(key,value) VALUES($key,$value)";
        command.Parameters.AddWithValue("$key", key);
        command.Parameters.AddWithValue("$value", data);
        try { command.ExecuteNonQuery(); }
        catch (SqliteException error) { throw new StoreException($"The project could not be saved. {error.Message}"); }
    }

    public T? Load<T>(string key)
    {
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT value FROM state WHERE key=$key";
        command.Parameters.AddWithValue("$key", key);
        using var reader = command.ExecuteReader();
        if (!reader.Read()) return default;
        var bytes = (byte[])reader.GetValue(0);
        var value = JsonSerializer.Deserialize<T>(bytes, PrismJson.Options);
        if (value is ProjectData project && (project.Media is null || project.Segments is null
            || project.Media.Any(media => media is null) || project.Segments.Any(segment => segment is null)))
            throw new StoreException("The saved project contains invalid media or clips.");
        return value;
    }

    /// <summary>The saved project, or null when the folder isn't a readable Prism project.</summary>
    public static ProjectData? ReadProject(string root)
    {
        try { using var store = new ProjectStore(root, create: false); return store.Load<ProjectData>("project"); }
        catch (Exception) { return null; }
    }

    public void Dispose() => connection.Dispose();
}

/// Where Prism keeps its library and settings on each system.
public static class AppPaths
{
    public static StringComparer PathComparer => OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal;
    /// <summary>%LOCALAPPDATA%\Prism on Windows, ~/.local/share/prism on Linux (XDG_DATA_HOME). Never the macOS app's library.</summary>
    public static string AppData { get; set; } = DefaultAppData();
    /// <summary>%APPDATA%\Prism on Windows, ~/.config/prism on Linux (XDG_CONFIG_HOME).</summary>
    public static string Config { get; set; } = DefaultConfig();

    public static string Library => System.IO.Path.Combine(AppData, "Library");
    public static string Projects => System.IO.Path.Combine(Library, "Projects");

    static string DefaultAppData()
    {
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        return System.IO.Path.Combine(local, OperatingSystem.IsWindows() ? "Prism" : "prism");
    }

    static string DefaultConfig()
    {
        var config = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        return System.IO.Path.Combine(config, OperatingSystem.IsWindows() ? "Prism" : "prism");
    }
}

/// App settings that macOS keeps in UserDefaults, saved as one JSON file.
public sealed class AppSettings
{
    public string GeminiModel { get; set; } = "gemini-3.1-flash-lite";
    public bool GeminiKeySaved { get; set; }
    public List<string> RecentProjects { get; set; } = [];
    public string? LastProject { get; set; }
    public List<ProjectFolder> ProjectFolders { get; set; } = [];
    public ExportQuality ExportQuality { get; set; } = ExportQuality.Full;
    public string Appearance { get; set; } = "dark";
    public double ResourceRefreshSeconds { get; set; } = 60;
    public double LeftSidebarWidth { get; set; } = 248;
    public double RightSidebarWidth { get; set; } = 282;
    public double TimelineHeight { get; set; } = 278;
    public bool ShortsBestFirst { get; set; }
    public bool ShortsCollapsed { get; set; }
    public bool MainVideoCollapsed { get; set; }
    public bool CaptionStyleCollapsed { get; set; }
    public bool CaptionTextCollapsed { get; set; }


    static string FilePath => System.IO.Path.Combine(AppPaths.Config, "settings.json");

    public static AppSettings Load()
    {
        try
        {
            var settings = PrismJson.Deserialize<AppSettings>(File.ReadAllText(FilePath)) ?? new AppSettings();
            settings.RecentProjects ??= [];
            settings.ProjectFolders = (settings.ProjectFolders ?? []).Where(folder => folder is not null).ToList();
            foreach (var folder in settings.ProjectFolders) { folder.ProjectPaths ??= []; folder.Name ??= "Folder"; }
            if (string.IsNullOrWhiteSpace(settings.GeminiModel)) settings.GeminiModel = "gemini-3.1-flash-lite";
            if (!Enum.IsDefined(settings.ExportQuality)) settings.ExportQuality = ExportQuality.Full;
            static double Positive(double value, double fallback) => double.IsFinite(value) && value > 0 ? value : fallback;
            settings.ResourceRefreshSeconds = Math.Clamp(Positive(settings.ResourceRefreshSeconds, 60), 1, 3600);
            settings.LeftSidebarWidth = Positive(settings.LeftSidebarWidth, 248);
            settings.RightSidebarWidth = Positive(settings.RightSidebarWidth, 282);
            settings.TimelineHeight = Positive(settings.TimelineHeight, 278);
            return settings;
        }
        catch (Exception) { return new AppSettings(); }
    }

    /// <summary>Written to a temporary file and moved into place, so a crash mid-write can't leave half a settings file.</summary>
    public void Save()
    {
        try
        {
            Directory.CreateDirectory(AppPaths.Config);
            var temporary = FilePath + ".tmp";
            File.WriteAllText(temporary, PrismJson.Serialize(this));
            File.Move(temporary, FilePath, overwrite: true);
        }
        catch (Exception) { }
    }
}
