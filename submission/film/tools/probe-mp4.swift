// Checks a composed MP4 with AVFoundation: duration, tracks, codecs, frame count, audio length and peak.
// With --sync, also finds the brightest video frame and the strongest audio onset, and prints both,
// so a flash frame and a hit placed at the same time prove the two tracks are aligned.
//
//   swiftc -O -sdk /Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk \
//     submission/film/tools/probe-mp4.swift -o submission/film/.build/probe-mp4
//   submission/film/.build/probe-mp4 <file.mp4> [--sync]

import Foundation
import AVFoundation
import CoreMedia

func fail(_ m: String) -> Never { FileHandle.standardError.write(("probe-mp4: " + m + "\n").data(using: .utf8)!); exit(1) }
let args = Array(CommandLine.arguments.dropFirst())
guard let path = args.first(where: { !$0.hasPrefix("--") }) else { fail("usage: probe-mp4 <file.mp4> [--sync]") }
let wantSync = args.contains("--sync")
let url = URL(fileURLWithPath: path)
let asset = AVURLAsset(url: url)

func fourCC(_ v: FourCharCode) -> String {
    let bytes = [UInt8((v >> 24) & 0xFF), UInt8((v >> 16) & 0xFF), UInt8((v >> 8) & 0xFF), UInt8(v & 0xFF)]
    return String(bytes: bytes, encoding: .ascii) ?? "\(v)"
}
func secs(_ t: CMTime) -> String { String(format: "%.4f s", t.seconds) }

let duration = try await asset.load(.duration)
let tracks = try await asset.load(.tracks)
let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
print("file: \(url.lastPathComponent), \(String(format: "%.1f", Double(size) / 1e6)) MB")
print("duration: \(secs(duration)) (\(duration.value)/\(duration.timescale))")
print("tracks: \(tracks.count)")

var videoTrack: AVAssetTrack?
var audioTrack: AVAssetTrack?
for t in tracks {
    let type = t.mediaType
    let range = try await t.load(.timeRange)
    let rate = try await t.load(.estimatedDataRate)
    let fds = try await t.load(.formatDescriptions)
    let codec = fds.first.map { fourCC(CMFormatDescriptionGetMediaSubType($0)) } ?? "?"
    var line = "  \(type.rawValue): codec \(codec), start \(secs(range.start)), length \(secs(range.duration)), \(String(format: "%.0f", rate / 1000)) kbit/s"
    if type == .video {
        videoTrack = t
        let ns = try await t.load(.naturalSize)
        let fr = try await t.load(.nominalFrameRate)
        line += ", \(Int(ns.width))x\(Int(ns.height)), \(String(format: "%.3f", fr)) fps"
        if let fd = fds.first, let ext = CMFormatDescriptionGetExtensions(fd) as? [String: Any] {
            let prim = ext[kCMFormatDescriptionExtension_ColorPrimaries as String] as? String ?? "-"
            line += ", primaries \(prim)"
        }
    } else if type == .audio {
        audioTrack = t
        if let fd = fds.first, let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fd)?.pointee {
            line += ", \(Int(asbd.mSampleRate)) Hz, \(asbd.mChannelsPerFrame) channels"
        }
    }
    print(line)
}
guard let videoTrack else { fail("no video track") }
guard let audioTrack else { fail("no audio track") }

// Decode the video frames (times on the film's timeline) and, with --sync, measure their brightness.
var frameTimes: [Double] = []
var frameLuma: [Double] = []
do {
    let reader = try AVAssetReader(asset: asset)
    let settings: [String: Any] = [kCVPixelBufferPixelFormatTypeKey as String: wantSync ? kCVPixelFormatType_32BGRA : kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange]
    let out = AVAssetReaderTrackOutput(track: videoTrack, outputSettings: settings)
    out.alwaysCopiesSampleData = false
    reader.add(out)
    guard reader.startReading() else { fail("cannot read video: \(reader.error?.localizedDescription ?? "?")") }
    while let sb = out.copyNextSampleBuffer() {
        if CMSampleBufferGetNumSamples(sb) == 0 { continue }
        frameTimes.append(CMSampleBufferGetPresentationTimeStamp(sb).seconds)
        if wantSync, let pb = CMSampleBufferGetImageBuffer(sb) {
            CVPixelBufferLockBaseAddress(pb, .readOnly)
            let w = CVPixelBufferGetWidth(pb), h = CVPixelBufferGetHeight(pb), rb = CVPixelBufferGetBytesPerRow(pb)
            let p = CVPixelBufferGetBaseAddress(pb)!.assumingMemoryBound(to: UInt8.self)
            var acc = 0.0, n = 0.0
            for y in stride(from: 0, to: h, by: 16) {
                for x in stride(from: 0, to: w, by: 16) {
                    let o = y * rb + x * 4
                    acc += 0.0722 * Double(p[o]) + 0.7152 * Double(p[o + 1]) + 0.2126 * Double(p[o + 2]); n += 1
                }
            }
            CVPixelBufferUnlockBaseAddress(pb, .readOnly)
            frameLuma.append(acc / n)
        }
    }
    if reader.status == .failed { fail("video read failed: \(reader.error?.localizedDescription ?? "?")") }
}
frameTimes.sort()
print("video frames: \(frameTimes.count), first at \(String(format: "%.4f", frameTimes.first ?? -1)) s, last at \(String(format: "%.4f", frameTimes.last ?? -1)) s")

// Decode the audio.
var mono: [Float] = []
var audioPeak: Float = 0
var audioStart = -1.0
var audioRate = 48_000.0
do {
    let reader = try AVAssetReader(asset: asset)
    let out = AVAssetReaderTrackOutput(track: audioTrack, outputSettings: [
        AVFormatIDKey: kAudioFormatLinearPCM, AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true,
        AVLinearPCMIsNonInterleaved: false, AVLinearPCMIsBigEndianKey: false, AVNumberOfChannelsKey: 2,
    ])
    reader.add(out)
    guard reader.startReading() else { fail("cannot read audio: \(reader.error?.localizedDescription ?? "?")") }
    while let sb = out.copyNextSampleBuffer() {
        if audioStart < 0 { audioStart = CMSampleBufferGetPresentationTimeStamp(sb).seconds }
        if let fd = CMSampleBufferGetFormatDescription(sb), let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fd)?.pointee { audioRate = asbd.mSampleRate }
        guard let bb = CMSampleBufferGetDataBuffer(sb) else { continue }
        let len = CMBlockBufferGetDataLength(bb)
        var data = [Float](repeating: 0, count: len / 4)
        _ = data.withUnsafeMutableBytes { CMBlockBufferCopyDataBytes(bb, atOffset: 0, dataLength: len, destination: $0.baseAddress!) }
        var i = 0
        while i + 1 < data.count {
            audioPeak = max(audioPeak, abs(data[i]), abs(data[i + 1]))
            mono.append(0.5 * (data[i] + data[i + 1]))
            i += 2
        }
    }
    if reader.status == .failed { fail("audio read failed: \(reader.error?.localizedDescription ?? "?")") }
}
print(String(format: "audio decoded: %d samples = %.4f s at %.0f Hz, first buffer at %.4f s, peak %.2f dBFS",
             mono.count, Double(mono.count) / audioRate, audioRate, audioStart, 20 * log10(Double(max(audioPeak, 1e-9)))))

if wantSync {
    // Brightest frame.
    var best = 0
    for i in frameLuma.indices where frameLuma[i] > frameLuma[best] { best = i }
    let flashT = frameTimes[best]
    // Strongest onset: 5 ms hops, energy against the previous 50 ms.
    let hop = Int(0.005 * audioRate)
    var energies: [Double] = []
    var k = 0
    while k + hop <= mono.count {
        var acc = 0.0
        for j in k..<(k + hop) { acc += Double(mono[j]) * Double(mono[j]) }
        energies.append(acc / Double(hop) + 1e-14)
        k += hop
    }
    var bestJump = -1e9, bestAt = 0
    for i in 10..<energies.count {
        var prev = 0.0
        for q in (i - 10)..<(i) { prev += energies[q] }
        let jump = 10 * log10(energies[i] / (prev / 10))
        if jump > bestJump { bestJump = jump; bestAt = i }
    }
    let hitT = Double(bestAt * hop) / audioRate + audioStart
    print(String(format: "sync: brightest frame %d at %.4f s (luma %.0f); strongest audio onset at %.4f s (+%.1f dB); offset %+.1f ms",
                 best, flashT, frameLuma[best], hitT, bestJump, (hitT - flashT) * 1000))
}
