// Makes a short test sample for compose: numbered 1920x1080 PNG frames with one white flash frame,
// and a slice of the score whose big hit lands on that flash. Used to prove compose keeps sound and
// picture aligned from 0. Nothing here goes into the film.
//
//   swiftc -O -sdk /Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk \
//     submission/film/tools/make-test-sample.swift -o submission/film/.build/make-test-sample
//   submission/film/.build/make-test-sample <score.wav> <out-folder> [from-s=84.0] [seconds=5] [flash-at-s=2.5] [fps=30] [grain=0]
//
// grain (0 to 1) adds film-grain noise, which makes the frames as hard to encode as the real film.
//
// Writes <out-folder>/frames/frame-00001.png ... and <out-folder>/sample.wav.
// With the defaults the wordmark impact (86.5 s in the score) lands at 2.5 s, on frame 76 (index 75).

import Foundation
import AVFoundation
import CoreGraphics
import CoreText
import ImageIO
import UniformTypeIdentifiers

func fail(_ m: String) -> Never { FileHandle.standardError.write(("make-test-sample: " + m + "\n").data(using: .utf8)!); exit(1) }
let a = CommandLine.arguments
guard a.count >= 3 else { fail("usage: make-test-sample <score.wav> <out-folder> [from-s] [seconds] [flash-at-s] [fps]") }
let wav = URL(fileURLWithPath: a[1])
let out = URL(fileURLWithPath: a[2])
let from = a.count > 3 ? Double(a[3])! : 84.0
let seconds = a.count > 4 ? Double(a[4])! : 5.0
let flashAt = a.count > 5 ? Double(a[5])! : 2.5
let fps = a.count > 6 ? Int(a[6])! : 30
let grain = a.count > 7 ? Double(a[7])! : 0
let framesDir = out.appendingPathComponent("frames")
try? FileManager.default.removeItem(at: framesDir)
try FileManager.default.createDirectory(at: framesDir, withIntermediateDirectories: true)

// The audio slice.
let src = try AVAudioFile(forReading: wav)
let sr = src.processingFormat.sampleRate
let count = AVAudioFrameCount((seconds * sr).rounded())
src.framePosition = AVAudioFramePosition((from * sr).rounded())
let buf = AVAudioPCMBuffer(pcmFormat: src.processingFormat, frameCapacity: count)!
try src.read(into: buf, frameCount: count)
let sliceURL = out.appendingPathComponent("sample.wav")
try? FileManager.default.removeItem(at: sliceURL)
do {
    let dst = try AVAudioFile(forWriting: sliceURL, settings: [
        AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: sr, AVNumberOfChannelsKey: src.processingFormat.channelCount,
        AVLinearPCMBitDepthKey: 24, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false,
    ], commonFormat: .pcmFormatFloat32, interleaved: false)
    try dst.write(from: buf)
}
print("make-test-sample: wrote sample.wav, \(String(format: "%.3f", Double(buf.frameLength) / sr)) s from \(from) s")

// The frames.
let W = 1920, H = 1080
let n = Int((seconds * Double(fps)).rounded())
let flashFrame = Int((flashAt * Double(fps)).rounded())
let space = CGColorSpace(name: CGColorSpace.sRGB)!
func text(_ c: CGContext, _ s: String, _ x: CGFloat, _ y: CGFloat, _ size: CGFloat, _ col: CGColor) {
    let font = CTFontCreateWithName("Helvetica-Bold" as CFString, size, nil)
    let attrs: [NSAttributedString.Key: Any] = [NSAttributedString.Key(kCTFontAttributeName as String): font, NSAttributedString.Key(kCTForegroundColorAttributeName as String): col]
    let line = CTLineCreateWithAttributedString(NSAttributedString(string: s, attributes: attrs))
    c.textPosition = CGPoint(x: x, y: y)
    CTLineDraw(line, c)
}
for i in 0..<n {
    let c = CGContext(data: nil, width: W, height: H, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    if i == flashFrame {
        c.setFillColor(CGColor(gray: 1, alpha: 1)); c.fill(CGRect(x: 0, y: 0, width: W, height: H))
        text(c, "FLASH: the hit is here", 120, 500, 96, CGColor(gray: 0, alpha: 1))
    } else {
        let g = CGGradient(colorsSpace: space, colors: [CGColor(srgbRed: 0.04, green: 0.05, blue: 0.09, alpha: 1), CGColor(srgbRed: 0.10, green: 0.12, blue: 0.22, alpha: 1)] as CFArray, locations: [0, 1])!
        c.drawLinearGradient(g, start: CGPoint(x: 0, y: 0), end: CGPoint(x: W, y: H), options: [])
        text(c, "compose test, frame \(i + 1) of \(n)", 120, 640, 72, CGColor(gray: 0.9, alpha: 1))
        text(c, String(format: "t = %.3f s   (flash and hit at %.3f s)", Double(i) / Double(fps), Double(flashFrame) / Double(fps)), 120, 540, 44, CGColor(gray: 0.6, alpha: 1))
        let x = CGFloat(i) / CGFloat(max(1, n - 1)) * CGFloat(W - 240)
        c.setFillColor(CGColor(srgbRed: 1, green: 0.75, blue: 0.3, alpha: 1)); c.fill(CGRect(x: 120 + x, y: 300, width: 24, height: 120))
    }
    if grain > 0, let data = c.data {
        let p = data.assumingMemoryBound(to: UInt8.self)
        let rb = c.bytesPerRow
        var s: UInt64 = 0x9E37_79B9_7F4A_7C15 &* UInt64(i + 1)
        let amp = grain * 60
        for y in 0..<H {
            for x in 0..<W {
                s ^= s >> 12; s ^= s << 25; s ^= s >> 27
                let r = Double((s &* 2_685_821_657_736_338_717) >> 40) / 16_777_216.0 - 0.5
                let d = Int(r * amp)
                let o = y * rb + x * 4
                for ch in 0..<3 { p[o + ch] = UInt8(max(0, min(255, Int(p[o + ch]) + d))) }
            }
        }
    }
    let url = framesDir.appendingPathComponent(String(format: "frame-%05d.png", i + 1))
    let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, c.makeImage()!, nil)
    guard CGImageDestinationFinalize(dest) else { fail("cannot write \(url.lastPathComponent)") }
}
print("make-test-sample: wrote \(n) frames (\(W)x\(H)); the flash is frame index \(flashFrame) at \(String(format: "%.3f", Double(flashFrame) / Double(fps))) s")
