// Overnight launch film: the composer.
//
// From a folder of numbered PNG frames, a frame rate and a WAV, writes one MP4:
// H.264 video (High profile, CABAC, about 18 Mbit/s by default) and AAC audio (256 kbit/s),
// both starting at 0, the file exactly as long as the frames. Audio longer than the frames is
// cut; shorter is padded with silence. Frames are read one at a time, so memory stays small.
//
// Build and run from the repo root:
//   swiftc -O -sdk /Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk \
//     submission/film/compose.swift -o submission/film/.build/compose
//   submission/film/.build/compose <frames-folder> 30 submission/film/audio/score.wav <out.mp4> [--bitrate 18000000]
//
// Frames are ordered by the last number in their file name (frame-00001.png, 2.png, ...).
// All frames must be the same size (the film is 1920x1080).

import Foundation
import AVFoundation
import CoreGraphics
import CoreVideo
import ImageIO

func fail(_ m: String) -> Never {
    FileHandle.standardError.write(("compose: " + m + "\n").data(using: .utf8)!)
    exit(1)
}
func note(_ m: String) { FileHandle.standardError.write(("compose: " + m + "\n").data(using: .utf8)!) }

let usage = "usage: compose <frames-folder> <fps> <audio.wav> <out.mp4> [--bitrate <bits per second>]"
var args = Array(CommandLine.arguments.dropFirst())
var bitrate = 18_000_000
if let i = args.firstIndex(of: "--bitrate") {
    guard i + 1 < args.count, let b = Int(args[i + 1]), b >= 1_000_000, b <= 100_000_000 else { fail(usage) }
    bitrate = b
    args.removeSubrange(i...(i + 1))
}
guard args.count == 4 else { fail(usage) }
let framesDir = URL(fileURLWithPath: args[0])
guard let fpsInt = Int32(args[1]), fpsInt > 0, fpsInt <= 240 else { fail("the frame rate must be a whole number, like 30") }
let fps = fpsInt
let wavURL = URL(fileURLWithPath: args[2])
let outURL = URL(fileURLWithPath: args[3])
guard outURL.pathExtension.lowercased() == "mp4" else { fail("the output must end in .mp4") }

// MARK: frames

let started = Date()
let names: [String]
do {
    names = try FileManager.default.contentsOfDirectory(atPath: framesDir.path)
        .filter { $0.lowercased().hasSuffix(".png") && !$0.hasPrefix(".") }
} catch { fail("cannot read the frames folder \(framesDir.path): \(error.localizedDescription)") }
guard !names.isEmpty else { fail("no .png frames in \(framesDir.path)") }

/// The last run of digits in a file name: "frame-00042.png" is 42.
func frameNumber(_ name: String) -> Int? {
    let base = (name as NSString).deletingPathExtension
    var digits = ""
    for ch in base.reversed() {
        if ch.isASCII && ch.isNumber { digits.insert(ch, at: digits.startIndex) } else if !digits.isEmpty { break }
    }
    return digits.isEmpty ? nil : Int(digits)
}
let numbered = names.map { ($0, frameNumber($0)) }
guard numbered.allSatisfy({ $0.1 != nil }) else {
    fail("every frame's name needs a number (found \(numbered.first { $0.1 == nil }!.0))")
}
let sorted = numbered.sorted { $0.1! < $1.1! }
let nums = sorted.map { $0.1! }
if Set(nums).count != nums.count { fail("two frames have the same number") }
if nums.last! - nums.first! + 1 != nums.count {
    note("warning: frame numbers \(nums.first!) to \(nums.last!) have gaps; \(nums.count) frames are used in order")
}
let frameURLs = sorted.map { framesDir.appendingPathComponent($0.0) }
let frameCount = frameURLs.count

func loadImage(_ url: URL) -> CGImage {
    guard let src = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
          let img = CGImageSourceCreateImageAtIndex(src, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
    else { fail("cannot read the frame \(url.lastPathComponent)") }
    return img
}
let first = loadImage(frameURLs[0])
let width = first.width, height = first.height
guard width % 2 == 0 && height % 2 == 0 else { fail("frame size \(width)x\(height) must be even") }
if width != 1920 || height != 1080 { note("note: frames are \(width)x\(height), not 1920x1080") }

// MARK: audio

let audioFile: AVAudioFile
do { audioFile = try AVAudioFile(forReading: wavURL) } catch { fail("cannot read the audio \(wavURL.path): \(error.localizedDescription)") }
let pf = audioFile.processingFormat
let sampleRate = pf.sampleRate
guard sampleRate == 48_000 || sampleRate == 44_100 else { fail("the audio must be 48 or 44.1 kHz (it is \(sampleRate) Hz)") }
let inChannels = Int(pf.channelCount)
guard inChannels == 1 || inChannels == 2 else { fail("the audio must be mono or stereo (it has \(inChannels) channels)") }
let sr = Int64(sampleRate)
// The film's length in audio samples: exactly the frames' length.
let totalSamples = (Int64(frameCount) * sr + Int64(fps) / 2) / Int64(fps)
let fileSamples = audioFile.length
if fileSamples > totalSamples {
    note(String(format: "audio is %.3f s, the frames %.3f s: the audio is cut to fit", Double(fileSamples) / Double(sr), Double(totalSamples) / Double(sr)))
} else if fileSamples < totalSamples {
    note(String(format: "audio is %.3f s, the frames %.3f s: the end is padded with silence", Double(fileSamples) / Double(sr), Double(totalSamples) / Double(sr)))
}

// MARK: writer

try? FileManager.default.removeItem(at: outURL)
let writer: AVAssetWriter
do { writer = try AVAssetWriter(outputURL: outURL, fileType: .mp4) } catch { fail("cannot create \(outURL.path): \(error.localizedDescription)") }
writer.shouldOptimizeForNetworkUse = true   // the index at the front, so it starts playing at once

let videoSettings: [String: Any] = [
    AVVideoCodecKey: AVVideoCodecType.h264,
    AVVideoWidthKey: width,
    AVVideoHeightKey: height,
    AVVideoColorPropertiesKey: [
        AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
        AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
        AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
    ],
    AVVideoCompressionPropertiesKey: [
        AVVideoAverageBitRateKey: bitrate,
        AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
        AVVideoH264EntropyModeKey: AVVideoH264EntropyModeCABAC,
        AVVideoMaxKeyFrameIntervalKey: Int(fps) * 2,
        AVVideoExpectedSourceFrameRateKey: Int(fps),
        AVVideoAllowFrameReorderingKey: true,
    ],
]
guard writer.canApply(outputSettings: videoSettings, forMediaType: .video) else { fail("this Mac cannot encode H.264 at \(width)x\(height)") }
let videoIn = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)
videoIn.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: videoIn, sourcePixelBufferAttributes: [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
    kCVPixelBufferWidthKey as String: width,
    kCVPixelBufferHeightKey as String: height,
    kCVPixelBufferCGBitmapContextCompatibilityKey as String: true,
])

var stereoLayout = AudioChannelLayout()
stereoLayout.mChannelLayoutTag = kAudioChannelLayoutTag_Stereo
let layoutData = Data(bytes: &stereoLayout, count: MemoryLayout<AudioChannelLayout>.size)
let audioSettings: [String: Any] = [
    AVFormatIDKey: kAudioFormatMPEG4AAC,
    AVSampleRateKey: sampleRate,
    AVNumberOfChannelsKey: 2,
    AVEncoderBitRateKey: 256_000,
    AVEncoderBitRateStrategyKey: AVAudioBitRateStrategy_Constant,
    AVChannelLayoutKey: layoutData,
]
guard writer.canApply(outputSettings: audioSettings, forMediaType: .audio) else { fail("this Mac cannot encode AAC at 256 kbit/s") }
let audioIn = AVAssetWriterInput(mediaType: .audio, outputSettings: audioSettings)
audioIn.expectsMediaDataInRealTime = false

guard writer.canAdd(videoIn), writer.canAdd(audioIn) else { fail("cannot add the tracks") }
writer.add(videoIn)
writer.add(audioIn)
guard writer.startWriting() else { fail("cannot start writing: \(writer.error?.localizedDescription ?? "unknown error")") }
writer.startSession(atSourceTime: .zero)

// The PCM we hand the AAC encoder: 32-bit float, interleaved stereo.
var asbd = AudioStreamBasicDescription(
    mSampleRate: sampleRate, mFormatID: kAudioFormatLinearPCM,
    mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
    mBytesPerPacket: 8, mFramesPerPacket: 1, mBytesPerFrame: 8, mChannelsPerFrame: 2, mBitsPerChannel: 32, mReserved: 0)
var pcmFormat: CMAudioFormatDescription?
guard CMAudioFormatDescriptionCreate(allocator: nil, asbd: &asbd, layoutSize: MemoryLayout<AudioChannelLayout>.size, layout: &stereoLayout,
                                     magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &pcmFormat) == noErr,
      let pcmFormat else { fail("cannot describe the audio format") }

// MARK: feeding

let group = DispatchGroup()
let videoQueue = DispatchQueue(label: "compose.video")
let audioQueue = DispatchQueue(label: "compose.audio")
let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
var nextFrame = 0
var videoDone = false
var videoFailure: String?

func makePixelBuffer(_ img: CGImage, _ name: String) -> CVPixelBuffer? {
    guard img.width == width && img.height == height else {
        videoFailure = "\(name) is \(img.width)x\(img.height); every frame must be \(width)x\(height)"
        return nil
    }
    guard let pool = adaptor.pixelBufferPool else { videoFailure = "no pixel buffer pool"; return nil }
    var pb: CVPixelBuffer?
    guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pb) == kCVReturnSuccess, let pb else { videoFailure = "cannot get a pixel buffer"; return nil }
    CVPixelBufferLockBaseAddress(pb, [])
    defer { CVPixelBufferUnlockBaseAddress(pb, []) }
    guard let ctx = CGContext(data: CVPixelBufferGetBaseAddress(pb), width: width, height: height, bitsPerComponent: 8,
                              bytesPerRow: CVPixelBufferGetBytesPerRow(pb), space: colorSpace,
                              bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
    else { videoFailure = "cannot draw into a pixel buffer"; return nil }
    let rect = CGRect(x: 0, y: 0, width: width, height: height)
    ctx.setFillColor(CGColor(gray: 0, alpha: 1))
    ctx.fill(rect)
    ctx.interpolationQuality = .high
    ctx.draw(img, in: rect)
    return pb
}

group.enter()
videoIn.requestMediaDataWhenReady(on: videoQueue) {
    while videoIn.isReadyForMoreMediaData && !videoDone {
        if nextFrame >= frameCount || videoFailure != nil {
            videoIn.markAsFinished()
            videoDone = true
            group.leave()
            return
        }
        autoreleasepool {
            let url = frameURLs[nextFrame]
            let img = nextFrame == 0 ? first : loadImage(url)
            if let pb = makePixelBuffer(img, url.lastPathComponent) {
                if !adaptor.append(pb, withPresentationTime: CMTime(value: Int64(nextFrame), timescale: fps)) {
                    videoFailure = "the encoder refused frame \(nextFrame): \(writer.error?.localizedDescription ?? "unknown error")"
                }
            }
        }
        nextFrame += 1
        if nextFrame % max(1, frameCount / 10) == 0 { note("frames \(nextFrame) of \(frameCount)") }
    }
}

var audioPos: Int64 = 0
var audioDone = false
var audioFailure: String?
let chunk: AVAudioFrameCount = 4800
let readBuf = AVAudioPCMBuffer(pcmFormat: pf, frameCapacity: chunk)!
var interleaved = [Float](repeating: 0, count: Int(chunk) * 2)

/// The next block of the film's audio as a CMSampleBuffer: read from the WAV, or silence past its end.
func nextAudioBuffer() -> CMSampleBuffer? {
    let want = Int(min(Int64(chunk), totalSamples - audioPos))
    for i in 0..<(want * 2) { interleaved[i] = 0 }
    if audioPos < fileSamples {
        readBuf.frameLength = 0
        let fromFile = AVAudioFrameCount(min(Int64(want), fileSamples - audioPos))
        do { try audioFile.read(into: readBuf, frameCount: fromFile) } catch {
            audioFailure = "cannot read the audio at \(audioPos): \(error.localizedDescription)"
            return nil
        }
        let got = Int(readBuf.frameLength)
        let ch = readBuf.floatChannelData!
        for i in 0..<min(got, want) {
            interleaved[2 * i] = ch[0][i]
            interleaved[2 * i + 1] = inChannels == 2 ? ch[1][i] : ch[0][i]
        }
    }
    let bytes = want * 8
    var block: CMBlockBuffer?
    guard CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: nil, blockLength: bytes, blockAllocator: nil, customBlockSource: nil,
                                             offsetToData: 0, dataLength: bytes, flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block) == noErr,
          let block else { audioFailure = "cannot allocate audio memory"; return nil }
    let copied = interleaved.withUnsafeBytes { raw in
        CMBlockBufferReplaceDataBytes(with: raw.baseAddress!, blockBuffer: block, offsetIntoDestination: 0, dataLength: bytes)
    }
    guard copied == noErr else { audioFailure = "cannot copy audio"; return nil }
    var sb: CMSampleBuffer?
    guard CMAudioSampleBufferCreateReadyWithPacketDescriptions(allocator: nil, dataBuffer: block, formatDescription: pcmFormat, sampleCount: want,
                                                               presentationTimeStamp: CMTime(value: audioPos, timescale: Int32(sr)),
                                                               packetDescriptions: nil, sampleBufferOut: &sb) == noErr, let sb
    else { audioFailure = "cannot make an audio sample buffer"; return nil }
    audioPos += Int64(want)
    return sb
}

group.enter()
audioIn.requestMediaDataWhenReady(on: audioQueue) {
    while audioIn.isReadyForMoreMediaData && !audioDone {
        if audioPos >= totalSamples || audioFailure != nil {
            audioIn.markAsFinished()
            audioDone = true
            group.leave()
            return
        }
        guard let sb = nextAudioBuffer() else { continue }
        if !audioIn.append(sb) {
            audioFailure = "the encoder refused audio at \(audioPos): \(writer.error?.localizedDescription ?? "unknown error")"
        }
    }
}

group.wait()
if let videoFailure { writer.cancelWriting(); fail(videoFailure) }
if let audioFailure { writer.cancelWriting(); fail(audioFailure) }

let end = CMTime(value: Int64(frameCount), timescale: fps)
writer.endSession(atSourceTime: end)
let finished = DispatchSemaphore(value: 0)
writer.finishWriting { finished.signal() }
finished.wait()
guard writer.status == .completed else { fail("writing failed: \(writer.error?.localizedDescription ?? "unknown error")") }

let size = (try? FileManager.default.attributesOfItem(atPath: outURL.path)[.size] as? Int) ?? 0
let seconds = Double(frameCount) / Double(fps)
print(String(format: "compose: wrote %@: %d frames at %d fps = %.3f s, %dx%d H.264 at %.1f Mbit/s target, AAC 256 kbit/s; %.1f MB (%.1f Mbit/s overall) in %.1f s",
             outURL.lastPathComponent, frameCount, fps, seconds, width, height, Double(bitrate) / 1e6,
             Double(size) / 1e6, Double(size) * 8 / seconds / 1e6, Date().timeIntervalSince(started)))
