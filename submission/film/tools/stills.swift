// Extracts exact stills from an MP4 with AVFoundation: stills <file.mp4> <outDir> <prefix> <t1,t2,...>
//   swiftc -O -sdk /Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk submission/film/tools/stills.swift -o submission/film/.build/stills
// Writes <outDir>/<prefix><seconds>.png, seconds as in the list (e.g. final-14.png).
import Foundation
import AVFoundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

func fail(_ m: String) -> Never { FileHandle.standardError.write(("stills: " + m + "\n").data(using: .utf8)!); exit(1) }
let a = Array(CommandLine.arguments.dropFirst())
guard a.count == 4 else { fail("usage: stills <file.mp4> <outDir> <prefix> <t1,t2,...>") }
let asset = AVURLAsset(url: URL(fileURLWithPath: a[0]))
let outDir = URL(fileURLWithPath: a[1])
try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
let gen = AVAssetImageGenerator(asset: asset)
gen.requestedTimeToleranceBefore = .zero
gen.requestedTimeToleranceAfter = .zero
gen.appliesPreferredTrackTransform = true
for item in a[3].split(separator: ",") {
    let label = String(item)
    guard let s = Double(label) else { fail("not a time: \(label)") }
    // The middle of the frame that shows time s, so rounding never lands on the frame before.
    let frame = (s * 30).rounded(.down)
    let t = CMTime(value: CMTimeValue(frame * 2 + 1), timescale: 60)
    let img: CGImage
    do { img = try await gen.image(at: t).image } catch { fail("no image at \(label) s: \(error.localizedDescription)") }
    let out = outDir.appendingPathComponent("\(a[2])\(label).png")
    guard let dest = CGImageDestinationCreateWithURL(out as CFURL, UTType.png.identifier as CFString, 1, nil) else { fail("cannot write \(out.path)") }
    CGImageDestinationAddImage(dest, img, nil)
    guard CGImageDestinationFinalize(dest) else { fail("cannot finish \(out.path)") }
    print("\(label) s -> \(out.lastPathComponent) (\(img.width)x\(img.height))")
}
