// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "MediapipeCaptureIOS",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
    ],
    products: [
        .library(name: "CaptureCore", targets: ["CaptureCore"]),
        .executable(name: "CaptureCoreSelfTest", targets: ["CaptureCoreSelfTest"]),
    ],
    targets: [
        .target(name: "CaptureCore"),
        .executableTarget(
            name: "CaptureCoreSelfTest",
            dependencies: ["CaptureCore"]
        ),
    ]
)
