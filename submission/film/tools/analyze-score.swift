// Measures the film score, since nobody on the team can listen to it from a shell.
//
//   swiftc -O -sdk /Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk \
//     submission/film/tools/analyze-score.swift -o submission/film/.build/analyze-score
//   submission/film/.build/analyze-score submission/film/audio/score.wav submission/film/review
//
// Reads the WAV (or the finished MP4's AAC track) back through AVFoundation, then checks:
// integrated loudness (ITU-R BS.1770-4, -14 LUFS), sample peak and an estimated true peak (both below
// -1 dBFS), DC offset, RMS per second (a table), energy per story section, that a transient lands on each
// hit cue, that the wrist cues stand out (the music dips under them), the near silence before the lift
// at 128, the share of energy per band (a top end, not too much above 10 kHz), stereo width, and digital
// silence after 159.0 s. Writes score-levels.txt, score-waveform.png and score-spectrogram.png.
// Exit code 0 only if every check passes.

import Foundation
import AVFoundation
import Accelerate
import CoreGraphics
import CoreText
import ImageIO
import UniformTypeIdentifiers

func fail(_ m: String) -> Never { FileHandle.standardError.write(("analyze-score: " + m + "\n").data(using: .utf8)!); exit(2) }

let args = CommandLine.arguments
guard args.count == 3 else { fail("usage: analyze-score <score.wav> <review-folder>") }
let wavURL = URL(fileURLWithPath: args[1])
let outDir = URL(fileURLWithPath: args[2])
try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

// MARK: read

let file: AVAudioFile
do { file = try AVAudioFile(forReading: wavURL) } catch { fail("cannot open \(wavURL.path): \(error.localizedDescription)") }
let fmt = file.processingFormat
let sr = fmt.sampleRate
let channels = Int(fmt.channelCount)
let frames = Int(file.length)
guard channels == 2 else { fail("expected stereo, got \(channels) channels") }
guard let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: AVAudioFrameCount(frames)) else { fail("out of memory") }
try file.read(into: buf)
let L = Array(UnsafeBufferPointer(start: buf.floatChannelData![0], count: frames))
let R = Array(UnsafeBufferPointer(start: buf.floatChannelData![1], count: frames))
let duration = Double(frames) / sr
let fileFormat = file.fileFormat.settings

var report: [String] = []
var failures: [String] = []
func say(_ s: String) { report.append(s); print(s) }
func db(_ x: Double) -> Double { x > 0 ? 20 * log10(x) : -200 }
func f1(_ x: Double) -> String { x <= -199 ? "  -inf" : String(format: "%6.1f", x) }

say("Overnight film score: measurements")
say("file: \(wavURL.lastPathComponent), \(String(format: "%.3f", duration)) s, \(Int(sr)) Hz, \(channels) channels, \(fileFormat[AVLinearPCMBitDepthKey] ?? "?")-bit")
say("")

// MARK: peak, true peak, DC

var peak = 0.0, peakAt = 0
var sumL = 0.0, sumR = 0.0
for i in 0..<frames {
    let p = max(abs(Double(L[i])), abs(Double(R[i])))
    if p > peak { peak = p; peakAt = i }
    sumL += Double(L[i]); sumR += Double(R[i])
}
// True peak estimate: 4x oversampling with a windowed-sinc interpolator, around every loud sample.
func truePeak(_ x: [Float]) -> Double {
    let taps = 16
    var kernels: [[Double]] = []
    for phase in 1..<4 {
        let frac = Double(phase) / 4
        var k: [Double] = []
        for j in -taps + 1...taps {
            let t = Double(j) - frac
            let sinc = t == 0 ? 1 : sin(Double.pi * t) / (Double.pi * t)
            let w = 0.5 + 0.5 * cos(Double.pi * t / Double(taps))
            k.append(sinc * w)
        }
        kernels.append(k)
    }
    var best = 0.0
    let threshold = peak * 0.7
    for i in taps..<(x.count - taps) where abs(Double(x[i])) > threshold || abs(Double(x[i + 1])) > threshold {
        best = max(best, abs(Double(x[i])))
        for k in kernels {
            var acc = 0.0
            for (n, c) in k.enumerated() { acc += c * Double(x[i + n - taps + 1]) }
            best = max(best, abs(acc))
        }
    }
    return best
}
let tp = max(truePeak(L), truePeak(R))
let dcL = sumL / Double(frames), dcR = sumR / Double(frames)
say(String(format: "sample peak     %6.2f dBFS at %.3f s   (must be below -1.0)", db(peak), Double(peakAt) / sr))
say(String(format: "true peak (4x)  %6.2f dBFS            (must be below -1.0)", db(tp)))
say(String(format: "DC offset       L %.2e  R %.2e  (%.0f / %.0f dBFS; must be below -90)", dcL, dcR, db(abs(dcL)), db(abs(dcR))))
if db(peak) >= -1 { failures.append("sample peak at or above -1 dBFS") }
if db(tp) >= -1 { failures.append("true peak at or above -1 dBFS") }
if db(abs(dcL)) > -90 || db(abs(dcR)) > -90 { failures.append("DC offset") }

// MARK: silence after 159.0

var tailMax = 0.0
for i in Int(159.0 * sr)..<frames { tailMax = max(tailMax, abs(Double(L[i])), abs(Double(R[i]))) }
say(tailMax == 0 ? "silence         exact digital zero from 159.000 s to the end" : String(format: "silence         NOT silent after 159.0 s (max %.2e)", tailMax))
if tailMax != 0 { failures.append("not silent after 159.0") }
var firstSample = 0.0
for i in 0..<Int(0.002 * sr) { firstSample = max(firstSample, abs(Double(L[i])), abs(Double(R[i]))) }
say(String(format: "start           first 2 ms max %.2e (starts from silence)", firstSample))
say("")

// MARK: RMS per second, per section

struct Section { let t0: Double; let t1: Double; let name: String }
let sections = [
    Section(t0: 0, t1: 4, name: "black: ideas said out loud"),
    Section(t0: 4, t1: 12, name: "the wrist, the spoken line"),
    Section(t0: 12, t1: 20, name: "push in, the ask arrives"),
    Section(t0: 20, t1: 26, name: "the tick, one tap"),
    Section(t0: 26, t1: 34, name: "night, 1:00 a.m."),
    Section(t0: 34, t1: 58, name: "real build (dashboard)"),
    Section(t0: 58, t1: 64, name: "sunrise"),
    Section(t0: 64, t1: 72, name: "the morning to-do"),
    Section(t0: 72, t1: 86, name: "it's live (the app)"),
    Section(t0: 86, t1: 96, name: "wordmark"),
    Section(t0: 96, t1: 128, name: "how it works"),
    Section(t0: 128, t1: 150, name: "it already works"),
    Section(t0: 150, t1: 160, name: "end card"),
]
func sectionName(_ t: Double) -> String { sections.first { t >= $0.t0 && t < $0.t1 }?.name ?? "" }

func rms(_ a: Int, _ b: Int) -> Double {
    var acc = 0.0
    for i in a..<b { acc += Double(L[i]) * Double(L[i]) + Double(R[i]) * Double(R[i]) }
    return sqrt(acc / Double(2 * (b - a)))
}
func pk(_ a: Int, _ b: Int) -> Double {
    var m = 0.0
    for i in a..<b { m = max(m, abs(Double(L[i])), abs(Double(R[i]))) }
    return m
}
let seconds = Int(duration.rounded(.down))
var perSecond: [Double] = []
var perSecondPeak: [Double] = []
say("RMS per second (stereo, dBFS)")
say("  sec   RMS    peak   level                                   section")
for s in 0..<seconds {
    let a = Int(Double(s) * sr), b = Int(Double(s + 1) * sr)
    let r = db(rms(a, b)), p = db(pk(a, b))
    perSecond.append(r); perSecondPeak.append(p)
    let bar = r <= -60 ? "" : String(repeating: "#", count: max(0, Int(((r + 60) / 60 * 40).rounded())))
    let name = sections.contains { abs($0.t0 - Double(s)) < 0.01 } ? sectionName(Double(s)) : ""
    say(String(format: "  %3d  %@  %@   %@ %@", s, f1(r), f1(p), bar.padding(toLength: 40, withPad: " ", startingAt: 0), name))
}
say("")
say("Energy per section (RMS over the whole section)")
var sectionRMS: [String: Double] = [:]
for sec in sections {
    let v = db(rms(Int(sec.t0 * sr), Int(min(sec.t1, 159) * sr)))
    sectionRMS[sec.name] = v
    say(String(format: "  %5.1f to %5.1f  %@ dBFS  %@", sec.t0, sec.t1, f1(v), sec.name))
}
let loudest = perSecond.max()!
let loudestAt = perSecond.firstIndex(of: loudest)!
say("")
// Integrated loudness, BS.1770-4: K-weighting, 400 ms blocks every 100 ms, gated at -70 LUFS and -10 LU.
func kweight(_ x: [Float]) -> [Double] {
    var out = [Double](repeating: 0, count: x.count)
    let b1 = [1.53512485958697, -2.69169618940638, 1.19839281085285], a1 = [-1.69065929318241, 0.73248077421585]
    let a2 = [-1.99004745483398, 0.99007225036621]
    var z1 = 0.0, z2 = 0.0, w1 = 0.0, w2 = 0.0
    for i in 0..<x.count {
        let v = Double(x[i])
        let y = b1[0] * v + z1
        z1 = b1[1] * v - a1[0] * y + z2; z2 = b1[2] * v - a1[1] * y
        let u = y + w1
        w1 = -2 * y - a2[0] * u + w2; w2 = y - a2[1] * u
        out[i] = u
    }
    return out
}
let kL = kweight(L), kR = kweight(R)
func blockMS(_ a: Int, _ n: Int) -> Double {
    var acc = 0.0
    for j in a..<min(frames, a + n) { acc += kL[j] * kL[j] + kR[j] * kR[j] }
    return acc / Double(n)
}
func lu(_ ms: Double) -> Double { -0.691 + 10 * log10(ms + 1e-20) }
var blocks: [Double] = []
var bi = 0
while bi + Int(0.4 * sr) <= frames { blocks.append(blockMS(bi, Int(0.4 * sr))); bi += Int(0.1 * sr) }
let gated0 = blocks.filter { lu($0) > -70 }
let relGate = lu(gated0.reduce(0, +) / Double(gated0.count)) - 10
let gated = gated0.filter { lu($0) > relGate }
let integrated = lu(gated.reduce(0, +) / Double(gated.count))
var shortMax = (-200.0, 0.0)
var si = 0
while si + Int(3 * sr) <= frames { let v = lu(blockMS(si, Int(3 * sr))); if v > shortMax.0 { shortMax = (v, Double(si) / sr + 1.5) }; si += Int(0.1 * sr) }
say(String(format: "loudness        %.2f LUFS integrated (must be -14.7 to -13.3); loudest 3 s %.1f LUFS at %.1f s", integrated, shortMax.0, shortMax.1))
if integrated < -14.7 || integrated > -13.3 { failures.append("integrated loudness not about -14 LUFS") }
say(String(format: "loudest second  %.1f dBFS RMS at %d s (%@)", loudest, loudestAt, sectionName(Double(loudestAt))))
let quietest = perSecond[1..<12].max()!
say(String(format: "opening (1 to 12 s) loudest second %.1f dBFS: %.1f dB under the loudest", quietest, loudest - quietest))
if loudest - quietest < 8 { failures.append("the opening is not much quieter than the peak") }

// The story's shape, as checks.
func sec(_ name: String) -> Double { sectionRMS[name]! }
let shape: [(String, Bool)] = [
    ("the opening is the quietest stretch", sec("black: ideas said out loud") < sec("the wrist, the spoken line") && sec("the wrist, the spoken line") < sec("night, 1:00 a.m.")),
    ("the night build sits above the night (after its first hit)", sec("real build (dashboard)") > db(rms(Int(27 * sr), Int(34 * sr))) + 3),
    ("the sunrise peak (62.5 to 64.5) rises above the build", db(rms(Int(62.5 * sr), Int(64.5 * sr))) > sec("real build (dashboard)") + 2),
    ("the wordmark is among the loudest sections (within 1 dB of the loudest)", sections.allSatisfy { sec($0.name) <= sec("wordmark") + 1 }),
    ("how it works steps back under the wordmark", sec("how it works") < sec("wordmark") - 3),
    ("the build ends louder than it starts", db(rms(Int(54 * sr), Int(58 * sr))) > db(rms(Int(34 * sr), Int(38 * sr))) + 2),
]
for (what, ok) in shape {
    say("  \(ok ? "ok  " : "FAIL") \(what)")
    if !ok { failures.append(what) }
}
say("")

// MARK: cue onsets

/// The mono sum, high-passed at 150 Hz, so onsets are not lost in the low end.
let hpMono: [Float] = {
    let w = 2 * Double.pi * 150 / sr, c = cos(w), al = sin(w) / (2 * 0.707), a0 = 1 + al
    let b0 = (1 + c) / 2 / a0, b1 = -(1 + c) / a0, b2 = (1 + c) / 2 / a0, a1 = -2 * c / a0, a2 = (1 - al) / a0
    var z1 = 0.0, z2 = 0.0
    var out = [Float](repeating: 0, count: frames)
    for i in 0..<frames {
        let x = 0.5 * (Double(L[i]) + Double(R[i]))
        let y = b0 * x + z1
        z1 = b1 * x - a1 * y + z2; z2 = b2 * x - a2 * y
        out[i] = Float(y)
    }
    return out
}()
/// Finds the strongest onset near `t`: 10 ms windows every 5 ms, the biggest rise over the previous 50 ms.
func onset(near t: Double, window: Double = 0.2) -> (Double, Double) {
    let hop = Int(0.005 * sr), win = 2 * hop
    let a = Int((t - window) * sr), b = Int((t + window) * sr)
    var energies: [(Int, Double)] = []
    var i = a - 12 * hop
    while i + win <= b + win {
        var acc = 0.0
        for j in i..<(i + win) { acc += Double(hpMono[j]) * Double(hpMono[j]) }
        energies.append((i, acc / Double(win) + 1e-14))
        i += hop
    }
    var best = (0.0, -1e9)
    for k in 12..<energies.count where energies[k].0 >= a {
        var prev = 0.0
        for q in (k - 12)..<(k - 2) { prev += energies[q].1 }
        prev /= 10
        let jump = 10 * log10(energies[k].1 / prev)
        if jump > best.1 { best = (Double(energies[k].0) / sr, jump) }
    }
    return best
}
say("Hit cues: where the strongest onset lands (above 150 Hz; 10 ms windows every 5 ms)")
let hitCues: [(Double, String)] = [(13.5, "haptic, the ask"), (21.0, "haptic, the tick"), (26.0, "drop into night"), (34.0, "build pulse starts"), (65.0, "haptic and chime, the morning to-do"), (86.5, "wordmark impact"), (150.5, "final hit")]
for (t, what) in hitCues {
    let (found, jump) = onset(near: t)
    let off = (found - t) * 1000
    let ok = abs(off) <= 10 && jump > 3
    say(String(format: "  %@ %6.2f s  found %.3f s (%+.0f ms), +%.1f dB  %@", ok ? "ok  " : "FAIL", t, found, off, jump, what))
    if !ok { failures.append("no clear onset at \(t)") }
}
// The wrist cues stand out from the music: the level over the cue against the 250 ms before it.
func bandRMS(_ a: Double, _ b: Double) -> Double { db(rms(Int(a * sr), Int(b * sr))) }
for (t, what) in [(13.5, "the ask"), (21.0, "the approval"), (65.0, "the morning to-do")] {
    let jump = bandRMS(t, t + 0.06) - bandRMS(t - 0.27, t - 0.02)
    let ok = jump >= 6
    say(String(format: "  %@ %6.2f s  stands %+.1f dB above the 250 ms before it (at least +6)  %@", ok ? "ok  " : "FAIL", t, jump, what))
    if !ok { failures.append("the cue at \(t) does not stand out") }
}
let hush = bandRMS(127.5, 127.95), lift = bandRMS(128.0, 129.0)
let liftOK = lift - hush >= 15
say(String(format: "  %@ 128.00 s  the lift: 127.5 to 127.95 at %.1f dBFS, 128 to 129 at %.1f dBFS (%+.1f dB; at least +15)", liftOK ? "ok  " : "FAIL", hush, lift, lift - hush))
if !liftOK { failures.append("no lift at 128") }
// Swells: the sunrise peaks at 64.0; the build pulse runs from 34.0.
func shortRMS(_ t: Double) -> Double { db(rms(Int((t - 0.05) * sr), Int((t + 0.05) * sr))) }
var swellPeak = (58.0, -200.0)
var t = 58.0
while t <= 64.9 { let v = shortRMS(t); if v > swellPeak.1 { swellPeak = (t, v) }; t += 0.05 }   // up to the morning chime
let at64 = shortRMS(64.0)
let swellOK = abs(swellPeak.0 - 64.0) <= 0.3 && at64 >= swellPeak.1 - 0.5
say(String(format: "  %@ 58 to 64.9 sunrise swell: loudest 100 ms at %.2f s (%.1f dBFS; at 64.00 %.1f); %.1f dB above 58.0", swellOK ? "ok  " : "FAIL", swellPeak.0, swellPeak.1, at64, swellPeak.1 - shortRMS(58.1)))
if !swellOK { failures.append("sunrise swell does not peak at 64") }
say("")

// MARK: spectrum

let fftN = 4096
let log2n = vDSP_Length(12)
guard let fft = vDSP_create_fftsetup(log2n, FFTRadix(kFFTRadix2)) else { fail("FFT setup") }
var window = [Float](repeating: 0, count: fftN)
vDSP_hann_window(&window, vDSP_Length(fftN), Int32(vDSP_HANN_NORM))
let windowSum = Double(window.reduce(0, +))
func spectrum(at start: Int) -> [Float] {
    var frame = [Float](repeating: 0, count: fftN)
    for i in 0..<fftN where start + i < frames && start + i >= 0 { frame[i] = 0.5 * (L[start + i] + R[start + i]) * window[i] }
    var re = [Float](repeating: 0, count: fftN / 2), im = [Float](repeating: 0, count: fftN / 2)
    var mags = [Float](repeating: 0, count: fftN / 2)
    re.withUnsafeMutableBufferPointer { rp in
        im.withUnsafeMutableBufferPointer { ip in
            var split = DSPSplitComplex(realp: rp.baseAddress!, imagp: ip.baseAddress!)
            frame.withUnsafeBufferPointer { fp in
                fp.baseAddress!.withMemoryRebound(to: DSPComplex.self, capacity: fftN / 2) { vDSP_ctoz($0, 2, &split, 1, vDSP_Length(fftN / 2)) }
            }
            vDSP_fft_zrip(fft, &split, 1, log2n, FFTDirection(FFT_FORWARD))
            split.imagp[0] = 0   // drop the packed Nyquist bin
            vDSP_zvmags(&split, 1, &mags, 1, vDSP_Length(fftN / 2))
        }
    }
    return mags   // |X|^2, where |X| / windowSum is the amplitude of a sine
}

// Band energy over the whole film.
var bandPower = [Double](repeating: 0, count: 5)
let bandEdges = [0.0, 100, 1000, 5000, 10000, 24000]
let binHz = sr / Double(fftN)
var pos = 0
while pos + fftN <= frames {
    let m = spectrum(at: pos)
    for k in 1..<(fftN / 2) {
        let f = Double(k) * binHz
        for b in 0..<5 where f >= bandEdges[b] && f < bandEdges[b + 1] { bandPower[b] += Double(m[k]) }
    }
    pos += fftN
}
let total = bandPower.reduce(0, +)
say("Spectrum over the whole film (share of energy per band)")
for b in 0..<5 {
    say(String(format: "  %5.0f to %5.0f Hz  %6.2f %%  (%6.1f dB)", bandEdges[b], bandEdges[b + 1], 100 * bandPower[b] / total, 10 * log10(bandPower[b] / total)))
}
let hfDb = 10 * log10(bandPower[4] / total)
say(String(format: "  above 10 kHz: %.1f dB of the total (must be below -25)", hfDb))
if hfDb > -25 { failures.append("too much energy above 10 kHz") }
let topDb = 10 * log10((bandPower[2] * 0 + bandPower[3] + bandPower[4]) / total)
say(String(format: "  above 1 kHz (1 to 24 kHz): %.1f dB of the total (should be above -16: a top end for small speakers)", 10 * log10((bandPower[2] + bandPower[3] + bandPower[4]) / total)))
_ = topDb
// Stereo width: the correlation of the two sides over the whole film.
var sLL = 0.0, sRR = 0.0, sLR = 0.0
for i in 0..<frames { sLL += Double(L[i]) * Double(L[i]); sRR += Double(R[i]) * Double(R[i]); sLR += Double(L[i]) * Double(R[i]) }
say(String(format: "  stereo correlation %.2f (1 is mono; a wide score sits about 0.5 to 0.7)", sLR / sqrt(sLL * sRR)))
say("")

// MARK: pictures

let W = 2400, H = 1000
func makeContext(_ w: Int, _ h: Int) -> CGContext {
    CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
}
func color(_ r: Double, _ g: Double, _ b: Double, _ a: Double = 1) -> CGColor { CGColor(srgbRed: r, green: g, blue: b, alpha: a) }
func text(_ c: CGContext, _ s: String, _ x: Double, _ yTop: Double, size: Double = 18, col: CGColor = color(0.85, 0.87, 0.92), right: Bool = false, h: Int) {
    let font = CTFontCreateWithName("Helvetica" as CFString, size, nil)
    let attrs: [NSAttributedString.Key: Any] = [NSAttributedString.Key(kCTFontAttributeName as String): font, NSAttributedString.Key(kCTForegroundColorAttributeName as String): col]
    let line = CTLineCreateWithAttributedString(NSAttributedString(string: s, attributes: attrs))
    let width = CTLineGetTypographicBounds(line, nil, nil, nil)
    c.textPosition = CGPoint(x: right ? x - width : x, y: Double(h) - yTop - size)
    CTLineDraw(line, c)
}
func savePNG(_ c: CGContext, _ name: String) {
    let url = outDir.appendingPathComponent(name)
    guard let img = c.makeImage(), let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else { fail("cannot write \(name)") }
    CGImageDestinationAddImage(dest, img, nil)
    guard CGImageDestinationFinalize(dest) else { fail("cannot write \(name)") }
    print("wrote \(url.path)")
}
let plotX0 = 90.0, plotX1 = Double(W) - 30
func xOf(_ t: Double) -> Double { plotX0 + (plotX1 - plotX0) * t / duration }
let cueMarks: [(Double, String)] = [(13.5, "13.5 haptic"), (21.0, "21 haptic"), (26.0, "26 night"), (34.0, "34 build"), (58.0, "58 sunrise"), (64.0, "64"), (65.0, "65 haptic+chime"), (86.5, "86.5 wordmark"), (96.0, "96 how"), (128.0, "128 lift"), (150.5, "150.5 final"), (159.0, "159 silence")]

func drawFrame(_ c: CGContext, h: Int, top: Double, bottom: Double, title: String) {
    c.setFillColor(color(0.055, 0.06, 0.08)); c.fill(CGRect(x: 0, y: 0, width: W, height: h))
    text(c, title, plotX0, 14, size: 24, col: color(0.95, 0.96, 1), h: h)
    // section bands
    for (i, s) in sections.enumerated() {
        let x0 = xOf(s.t0), x1 = xOf(s.t1)
        c.setFillColor(i % 2 == 0 ? color(1, 1, 1, 0.035) : color(1, 1, 1, 0.0))
        c.fill(CGRect(x: x0, y: Double(h) - bottom, width: x1 - x0, height: bottom - top))
    }
    for (i, s) in sections.enumerated() {
        text(c, s.name, xOf(s.t0) + 4, top - 44 + Double(i % 3) * 14, size: 12, col: color(0.6, 0.65, 0.75), h: h)
    }
}
func drawCues(_ c: CGContext, h: Int, top: Double, bottom: Double) {
    for (i, (t, label)) in cueMarks.enumerated() {
        let x = xOf(t)
        c.setStrokeColor(color(1, 0.75, 0.3, 0.55)); c.setLineWidth(1.2)
        c.setLineDash(phase: 0, lengths: [5, 4])
        c.move(to: CGPoint(x: x, y: Double(h) - top)); c.addLine(to: CGPoint(x: x, y: Double(h) - bottom)); c.strokePath()
        c.setLineDash(phase: 0, lengths: [])
        text(c, label, x + 3, bottom + 4 + Double(i % 3) * 16, size: 13, col: color(1, 0.8, 0.45), h: h)
    }
}
func drawTimeAxis(_ c: CGContext, h: Int, y: Double) {
    var s = 0.0
    while s <= duration + 0.001 {
        text(c, String(format: "%.0f s", s), xOf(s) - 12, y, size: 13, col: color(0.6, 0.63, 0.7), h: h)
        s += 10
    }
}

// Waveform and levels
do {
    let c = makeContext(W, H)
    drawFrame(c, h: H, top: 90, bottom: 860, title: "Overnight film score: waveform (top, L up and R down) and RMS per second (bottom)")
    // waveform panel 90 to 460
    let wTop = 90.0, wBot = 460.0, mid = (wTop + wBot) / 2, half = (wBot - wTop) / 2
    c.setStrokeColor(color(1, 1, 1, 0.15)); c.setLineWidth(1)
    c.move(to: CGPoint(x: plotX0, y: Double(H) - mid)); c.addLine(to: CGPoint(x: plotX1, y: Double(H) - mid)); c.strokePath()
    let cols = Int(plotX1 - plotX0)
    for col in 0..<cols {
        let a = Int(Double(col) / Double(cols) * Double(frames)), b = min(frames, Int(Double(col + 1) / Double(cols) * Double(frames)))
        var pl = 0.0, pr = 0.0, el = 0.0, er = 0.0
        for i in a..<b {
            pl = max(pl, abs(Double(L[i]))); pr = max(pr, abs(Double(R[i])))
            el += Double(L[i]) * Double(L[i]); er += Double(R[i]) * Double(R[i])
        }
        el = sqrt(el / Double(max(1, b - a))); er = sqrt(er / Double(max(1, b - a)))
        let x = plotX0 + Double(col) + 0.5
        c.setStrokeColor(color(0.35, 0.55, 0.95, 0.85))
        c.move(to: CGPoint(x: x, y: Double(H) - mid)); c.addLine(to: CGPoint(x: x, y: Double(H) - (mid - pl * half))); c.strokePath()
        c.move(to: CGPoint(x: x, y: Double(H) - mid)); c.addLine(to: CGPoint(x: x, y: Double(H) - (mid + pr * half))); c.strokePath()
        c.setStrokeColor(color(0.75, 0.88, 1, 0.95))
        c.move(to: CGPoint(x: x, y: Double(H) - mid)); c.addLine(to: CGPoint(x: x, y: Double(H) - (mid - el * half))); c.strokePath()
        c.move(to: CGPoint(x: x, y: Double(H) - mid)); c.addLine(to: CGPoint(x: x, y: Double(H) - (mid + er * half))); c.strokePath()
    }
    // -1 dBFS lines
    let ceil1 = pow(10, -1.0 / 20)
    c.setStrokeColor(color(1, 0.35, 0.35, 0.6))
    for y in [mid - ceil1 * half, mid + ceil1 * half] { c.move(to: CGPoint(x: plotX0, y: Double(H) - y)); c.addLine(to: CGPoint(x: plotX1, y: Double(H) - y)); c.strokePath() }
    text(c, "-1 dBFS", plotX0 - 8, mid - ceil1 * half - 8, size: 12, col: color(1, 0.5, 0.5), right: true, h: H)
    // level panel 520 to 860: -60 to 0 dBFS
    let lTop = 520.0, lBot = 860.0
    func yOf(_ d: Double) -> Double { lBot - (max(-60, min(0, d)) + 60) / 60 * (lBot - lTop) }
    c.setFillColor(color(0.3, 0.85, 0.55, 0.12)); c.fill(CGRect(x: plotX0, y: Double(H) - yOf(-14), width: plotX1 - plotX0, height: yOf(-16) - yOf(-14)))
    for d in stride(from: 0.0, through: -60.0, by: -10.0) {
        c.setStrokeColor(color(1, 1, 1, 0.08))
        c.move(to: CGPoint(x: plotX0, y: Double(H) - yOf(d))); c.addLine(to: CGPoint(x: plotX1, y: Double(H) - yOf(d))); c.strokePath()
        text(c, String(format: "%.0f dB", d), plotX0 - 8, yOf(d) - 8, size: 12, col: color(0.6, 0.63, 0.7), right: true, h: H)
    }
    text(c, "target band for the loudest section: -14 to -16 dBFS RMS", plotX1, lTop - 20, size: 13, col: color(0.5, 0.9, 0.65), right: true, h: H)
    for (s, r) in perSecond.enumerated() {
        let x0 = xOf(Double(s)) + 1, x1 = xOf(Double(s + 1)) - 1
        c.setFillColor(color(0.45, 0.7, 1, 0.85))
        c.fill(CGRect(x: x0, y: Double(H) - lBot, width: x1 - x0, height: lBot - yOf(r)))
        c.setFillColor(color(1, 0.55, 0.35, 0.9))
        c.fill(CGRect(x: x0, y: Double(H) - yOf(perSecondPeak[s]) - 1.5, width: x1 - x0, height: 3))
    }
    text(c, "bars: RMS per second   orange ticks: peak per second", plotX0, lTop - 20, size: 13, col: color(0.7, 0.75, 0.85), h: H)
    drawCues(c, h: H, top: 90, bottom: 860)
    drawTimeAxis(c, h: H, y: 920)
    savePNG(c, "score-waveform.png")
}

// Spectrogram
do {
    let SH = 900
    let c = makeContext(W, SH)
    let top = 90.0, bottom = 780.0
    drawFrame(c, h: SH, top: top, bottom: bottom, title: "Overnight film score: spectrogram (mono sum, log frequency 20 Hz to 24 kHz, -110 to -10 dB)")
    let cols = Int(plotX1 - plotX0)
    let fLo = 20.0, fHi = sr / 2
    func yOfF(_ f: Double) -> Double { bottom - (log10(f / fLo) / log10(fHi / fLo)) * (bottom - top) }
    let rows = Int(bottom - top)
    let stops: [(Double, (Double, Double, Double))] = [(0, (0.0, 0.0, 0.02)), (0.25, (0.23, 0.06, 0.44)), (0.5, (0.55, 0.16, 0.51)), (0.72, (0.87, 0.29, 0.41)), (0.88, (0.99, 0.62, 0.43)), (1, (0.99, 0.99, 0.75))]
    func cmap(_ v: Double) -> (Double, Double, Double) {
        let x = max(0, min(1, v))
        for k in 1..<stops.count where x <= stops[k].0 {
            let (x0, c0) = stops[k - 1], (x1, c1) = stops[k]
            let u = (x - x0) / (x1 - x0)
            return (c0.0 + (c1.0 - c0.0) * u, c0.1 + (c1.1 - c0.1) * u, c0.2 + (c1.2 - c0.2) * u)
        }
        return stops.last!.1
    }
    var px = [UInt8](repeating: 255, count: cols * rows * 4)
    for col in 0..<cols {
        let centre = Int(Double(col) / Double(cols) * Double(frames))
        let m = spectrum(at: centre - fftN / 2)
        for row in 0..<rows {
            let y = top + Double(row)
            // the frequency band this pixel row covers
            let fa = fLo * pow(fHi / fLo, (bottom - y - 1) / (bottom - top)), fb = fLo * pow(fHi / fLo, (bottom - y) / (bottom - top))
            let ka = max(1, Int(fa / binHz)), kb = min(fftN / 2 - 1, max(ka, Int(fb / binHz)))
            var p: Float = 0
            for k in ka...kb { p = max(p, m[k]) }
            let amp = sqrt(Double(p)) / windowSum
            let d = amp > 0 ? 20 * log10(amp) : -200
            let (r, g, b) = cmap((d + 110) / 100)
            let o = (row * cols + col) * 4
            px[o] = UInt8(r * 255); px[o + 1] = UInt8(g * 255); px[o + 2] = UInt8(b * 255)
        }
    }
    let provider = CGDataProvider(data: Data(px) as CFData)!
    let img = CGImage(width: cols, height: rows, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: cols * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue), provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
    c.draw(img, in: CGRect(x: plotX0, y: Double(SH) - bottom, width: Double(cols), height: Double(rows)))
    for f in [50.0, 100, 200, 500, 1000, 2000, 5000, 10000, 20000] {
        let y = yOfF(f)
        c.setStrokeColor(color(1, 1, 1, f == 10000 ? 0.7 : 0.18)); c.setLineWidth(f == 10000 ? 1.5 : 1)
        if f == 10000 { c.setLineDash(phase: 0, lengths: [8, 5]) }
        c.move(to: CGPoint(x: plotX0, y: Double(SH) - y)); c.addLine(to: CGPoint(x: plotX1, y: Double(SH) - y)); c.strokePath()
        c.setLineDash(phase: 0, lengths: [])
        text(c, f >= 1000 ? String(format: "%.0fk", f / 1000) : String(format: "%.0f", f), plotX0 - 8, y - 8, size: 12, col: color(0.7, 0.73, 0.8), right: true, h: SH)
    }
    text(c, "10 kHz", plotX1 - 6, yOfF(10000) - 24, size: 13, col: color(1, 1, 1, 0.85), right: true, h: SH)
    drawCues(c, h: SH, top: top, bottom: bottom)
    drawTimeAxis(c, h: SH, y: 850)
    savePNG(c, "score-spectrogram.png")
}

say("")
if failures.isEmpty {
    say("ALL CHECKS PASS")
} else {
    say("FAILED: " + failures.joined(separator: "; "))
}
try report.joined(separator: "\n").appending("\n").write(to: outDir.appendingPathComponent("score-levels.txt"), atomically: true, encoding: .utf8)
exit(failures.isEmpty ? 0 : 1)
