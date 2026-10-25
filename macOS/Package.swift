// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Relio",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "Relio", targets: ["RelioApp"])],
    dependencies: [
        // Sparkle: the standard updater for native macOS apps (EdDSA-signed appcasts). Pinned so releases are reproducible.
        .package(url: "https://github.com/sparkle-project/Sparkle", exact: "2.9.6")
    ],
    targets: [
        .systemLibrary(name: "CSQLite", pkgConfig: "sqlite3"),
        .executableTarget(
            name: "RelioApp",
            dependencies: ["CSQLite", .product(name: "Sparkle", package: "Sparkle")],
            // The app bundle carries Sparkle.framework in Contents/Frameworks.
            linkerSettings: [.unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"])]
        )
    ]
)
