// Overnight launch film: the score and the sound design.
//
// Synthesizes the film's whole soundtrack (160 s, 48 kHz, stereo, 24-bit WAV) from code alone.
// No samples, no files read: every sound below is an oscillator, filtered noise or a reverb.
//
// Build and run from the repo root:
//   swiftc -O submission/film/score.swift -o submission/film/.build/score
//   submission/film/.build/score submission/film/audio/score.wav
//
// It also writes <out>.cues.json, the cue sheet (what lands when), next to the WAV.
//
// The cue times come from the film's edit (1920x1080, 30 fps, 160 s):
//   13.5, 21.0, 65.0  haptic double pulse (the wrist buzzes)
//   26.0              the drop into night (impact)
//   34.0 to 58.0      the build pulse (90 BPM)
//   58.0 to 64.0      the sunrise swell, peaking at 64.0
//   65.0              the morning to-do: chime with the haptic
//   86.5              the wordmark impact
//   96.0 to 128.0     how it works: six beats of 16/3 s (8 beats at 90 BPM), a soft ping on each
//   128.0             a soft lift
//   150.5             the final hit
//   159.0             silence from here to the end
//
// Style: restrained, more keynote than trailer. Pads of detuned saws through gentle low-pass
// filters, a soft sub pulse, filtered-noise risers, deep impacts, a clean chime, a long
// algorithmic reverb, air on top. Mastered to -14 LUFS with a true-peak ceiling of -1.5 dBTP; no clipping.

import Foundation
import Dispatch

// MARK: - Constants and small helpers

let SR = 48_000.0
let DURATION = 160.0
let N = Int(DURATION * SR)
let TWO_PI = 2.0 * Double.pi
/// 90 BPM. Eight beats are 16/3 s, so the six "how it works" beats (96 to 128) fall on bar lines.
let BEAT = 60.0 / 90.0
let NODE = 8.0 * BEAT

@inline(__always) func dbToGain(_ db: Double) -> Double { pow(10.0, db / 20.0) }
@inline(__always) func midiHz(_ m: Double) -> Double { 440.0 * pow(2.0, (m - 69.0) / 12.0) }
@inline(__always) func smp(_ t: Double) -> Int { Int((t * SR).rounded()) }
/// Equal-power pan, -1 (left) to 1 (right).
@inline(__always) func panGains(_ p: Double) -> (Double, Double) {
    let a = (max(-1, min(1, p)) + 1) * Double.pi / 4
    return (cos(a), sin(a))
}

/// A small, fast, seeded random source, so every render is identical.
struct RNG {
    var s: UInt64
    init(_ seed: UInt64) { s = (seed &* 0x9E37_79B9_7F4A_7C15) | 1 }
    @inline(__always) mutating func next() -> UInt64 {
        s ^= s >> 12; s ^= s << 25; s ^= s >> 27
        return s &* 2_685_821_657_736_338_717
    }
    @inline(__always) mutating func unit() -> Double { Double(next() >> 11) * (1.0 / 9_007_199_254_740_992.0) }
    @inline(__always) mutating func bi() -> Double { unit() * 2 - 1 }
}

/// A breakpoint curve over absolute film time. `log` interpolates in log space (for frequencies).
struct Curve {
    let pts: [(Double, Double)]
    let log: Bool
    init(_ pts: [(Double, Double)], log: Bool = true) { self.pts = pts; self.log = log }
    func at(_ t: Double) -> Double {
        if t <= pts[0].0 { return pts[0].1 }
        if t >= pts[pts.count - 1].0 { return pts[pts.count - 1].1 }
        var i = 1
        while pts[i].0 < t { i += 1 }
        let (t0, v0) = pts[i - 1], (t1, v1) = pts[i]
        let x = (t - t0) / (t1 - t0)
        return log ? v0 * pow(v1 / v0, x) : v0 + (v1 - v0) * x
    }
}

/// Topology-preserving state-variable filter (Zavalishin). Smooth under modulation.
struct SVF {
    var ic1 = 0.0, ic2 = 0.0
    var k = 1.0, a1 = 0.0, a2 = 0.0, a3 = 0.0
    mutating func set(_ cutoff: Double, _ q: Double) {
        let g = tan(Double.pi * min(max(cutoff, 10), SR * 0.45) / SR)
        k = 1 / q
        a1 = 1 / (1 + g * (g + k)); a2 = g * a1; a3 = g * a2
    }
    @inline(__always) mutating func tick(_ v0: Double) -> (Double, Double) {
        let v3 = v0 - ic2
        let v1 = a1 * ic1 + a2 * v3
        let v2 = ic2 + a2 * ic1 + a3 * v3
        ic1 = 2 * v1 - ic1; ic2 = 2 * v2 - ic2
        return (v1, v2)
    }
    /// Take another filter's coefficients, keeping this one's state.
    mutating func take(_ o: SVF) { k = o.k; a1 = o.a1; a2 = o.a2; a3 = o.a3 }
    @inline(__always) mutating func lp(_ x: Double) -> Double { tick(x).1 }
    /// Band-pass with unity gain at the centre.
    @inline(__always) mutating func bp(_ x: Double) -> Double { k * tick(x).0 }
}

/// RBJ biquad, for the master bus.
struct Biquad {
    var b0 = 1.0, b1 = 0.0, b2 = 0.0, a1 = 0.0, a2 = 0.0
    var z1 = 0.0, z2 = 0.0
    static func lowpass(_ f: Double, _ q: Double) -> Biquad {
        let w = TWO_PI * f / SR, c = cos(w), al = sin(w) / (2 * q), a0 = 1 + al
        return Biquad(b0: (1 - c) / 2 / a0, b1: (1 - c) / a0, b2: (1 - c) / 2 / a0, a1: -2 * c / a0, a2: (1 - al) / a0)
    }
    static func highpass(_ f: Double, _ q: Double) -> Biquad {
        let w = TWO_PI * f / SR, c = cos(w), al = sin(w) / (2 * q), a0 = 1 + al
        return Biquad(b0: (1 + c) / 2 / a0, b1: -(1 + c) / a0, b2: (1 + c) / 2 / a0, a1: -2 * c / a0, a2: (1 - al) / a0)
    }
    /// RBJ shelves and a peaking band, for the master EQ (gain in dB).
    static func lowShelf(_ f: Double, _ db: Double) -> Biquad {
        let A = pow(10, db / 40), w = TWO_PI * f / SR, c = cos(w), al = sin(w) / 2 * sqrt(2.0), sa = 2 * sqrt(A) * al
        let a0 = (A + 1) + (A - 1) * c + sa
        return Biquad(b0: A * ((A + 1) - (A - 1) * c + sa) / a0, b1: 2 * A * ((A - 1) - (A + 1) * c) / a0, b2: A * ((A + 1) - (A - 1) * c - sa) / a0,
                      a1: -2 * ((A - 1) + (A + 1) * c) / a0, a2: ((A + 1) + (A - 1) * c - sa) / a0)
    }
    static func highShelf(_ f: Double, _ db: Double) -> Biquad {
        let A = pow(10, db / 40), w = TWO_PI * f / SR, c = cos(w), al = sin(w) / 2 * sqrt(2.0), sa = 2 * sqrt(A) * al
        let a0 = (A + 1) - (A - 1) * c + sa
        return Biquad(b0: A * ((A + 1) + (A - 1) * c + sa) / a0, b1: -2 * A * ((A - 1) + (A + 1) * c) / a0, b2: A * ((A + 1) + (A - 1) * c - sa) / a0,
                      a1: 2 * ((A - 1) - (A + 1) * c) / a0, a2: ((A + 1) - (A - 1) * c - sa) / a0)
    }
    static func peaking(_ f: Double, _ q: Double, _ db: Double) -> Biquad {
        let A = pow(10, db / 40), w = TWO_PI * f / SR, c = cos(w), al = sin(w) / (2 * q)
        let a0 = 1 + al / A
        return Biquad(b0: (1 + al * A) / a0, b1: -2 * c / a0, b2: (1 - al * A) / a0, a1: -2 * c / a0, a2: (1 - al / A) / a0)
    }
    @inline(__always) mutating func run(_ x: Double) -> Double {
        let y = b0 * x + z1
        z1 = b1 * x - a1 * y + z2
        z2 = b2 * x - a2 * y
        return y
    }
}

@inline(__always) func polyblep(_ t: Double, _ dt: Double) -> Double {
    if t < dt { let x = t / dt; return x + x - x * x - 1 }
    if t > 1 - dt { let x = (t - 1) / dt; return x * x + x + x + 1 }
    return 0
}

/// One rendered sound: a stereo buffer placed at `start` (samples), sent `dry` to the mix and `send` to the reverb.
struct Piece {
    var start: Int
    var l: [Float]
    var r: [Float]
    var dry: Float
    var send: Float
    var fx: Bool = false   // true: a sound effect on top of the music (not ducked under the cues)
}

// MARK: - The instruments

enum Wave { case saw, sine }

/// A sustained chord: every note a few detuned oscillators through a slowly moving 24 dB/oct low-pass.
struct Pad {
    var start: Double
    var end: Double            // the release begins here
    var attack: Double
    var release: Double
    var notes: [Double]        // MIDI note numbers
    var gainDb: Double
    var cutoff: Curve
    var wave: Wave = .saw
    var decayTo: Double = 1    // after the attack, settle to this fraction...
    var decayTime: Double = 0  // ...with this time constant (0: no settling)
    var duck: Bool = false     // breathe with the sub pulse
    var send: Double = 0.35
    var dry: Double = 1
    var width: Double = 1.0
    var tremolo: Double = 0    // slow amplitude shimmer, 0 to 1
    var level: Curve? = nil    // a swell over film time, in dB (linear in dB)
}

func padEnv(_ e: Pad, _ t: Double) -> Double {
    let a = t - e.start
    if a <= 0 { return 0 }
    var g = a < e.attack ? 0.5 - 0.5 * cos(Double.pi * a / e.attack) : 1.0
    if e.decayTime > 0 && a > e.attack {
        g *= e.decayTo + (1 - e.decayTo) * exp(-(a - e.attack) / e.decayTime)
    }
    if t > e.end {
        let r = (t - e.end) / e.release
        if r >= 1 { return 0 }
        g *= 0.5 + 0.5 * cos(Double.pi * r)
    }
    return g
}

func renderPad(_ e: Pad, seed: UInt64) -> [Piece] {
    let s0 = max(0, smp(e.start))
    let s1 = min(N, smp(e.end + e.release))
    let len = s1 - s0
    if len <= 0 { return [] }
    var L = [Float](repeating: 0, count: len)
    var R = [Float](repeating: 0, count: len)
    var rng = RNG(seed)
    let isSaw = e.wave == .saw
    let dets: [Double] = isSaw ? [-10.5, -3.5, 3.5, 10.5] : [-2.5, 2.5]
    let pans: [Double] = isSaw ? [-e.width, e.width * 0.4, -e.width * 0.4, e.width] : [-e.width * 0.5, e.width * 0.5]
    let oscScale = 0.35
    let base = dbToGain(e.gainDb) / sqrt(Double(e.notes.count))
    let t0 = Double(s0) / SR
    // The envelope (and the duck) are the same for every note: compute them once.
    var env = [Double](repeating: 0, count: len)
    for i in 0..<len {
        let t = t0 + Double(i) / SR
        var g = padEnv(e, t)
        if let lv = e.level { g *= dbToGain(lv.at(t)) }
        if e.duck { g *= Double(duckBuf[s0 + i]) }
        g *= Double(hapticDuck[s0 + i])
        env[i] = g
    }
    L.withUnsafeMutableBufferPointer { lp in
        R.withUnsafeMutableBufferPointer { rp in
            env.withUnsafeBufferPointer { ep in
                for m in e.notes {
                    let f = midiHz(m)
                    let nOsc = dets.count
                    var ph = (0..<nOsc).map { _ in rng.unit() }
                    let dtBase = dets.map { f * pow(2, $0 / 1200) / SR }
                    let dRate = (0..<nOsc).map { _ in 0.05 + 0.1 * rng.unit() }
                    let dPh = (0..<nOsc).map { _ in rng.unit() * TWO_PI }
                    var dt = dtBase
                    let gl = pans.map { panGains($0).0 }, gr = pans.map { panGains($0).1 }
                    let lfoR = 0.03 + 0.06 * rng.unit(), lfoP = rng.unit() * TWO_PI
                    let ampR = 0.04 + 0.07 * rng.unit(), ampP = rng.unit() * TWO_PI
                    let tremR = 0.18 + 0.2 * rng.unit(), tremP = rng.unit() * TWO_PI
                    let key = pow(f / 220, 0.3)
                    // Low notes a little softer (no mud), the highest a little softer (no glare).
                    let reg = m < 40 ? 0.65 : (m >= 66 ? 0.8 : 1.0)
                    var fl1 = SVF(), fl2 = SVF(), fr1 = SVF(), fr2 = SVF()
                    var i = 0
                    while i < len {
                        let bEnd = min(len, i + 64)
                        let t = t0 + Double(i) / SR
                        let c = min(11_000, e.cutoff.at(t) * key * (1 + 0.12 * sin(TWO_PI * lfoR * t + lfoP)))
                        fl1.set(c, 0.6); fl2.take(fl1); fr1.take(fl1); fr2.take(fl1)
                        for o in 0..<nOsc { dt[o] = dtBase[o] * (1 + 0.0008 * sin(TWO_PI * dRate[o] * t + dPh[o])) }
                        var amp = base * reg * oscScale * (1 + 0.1 * sin(TWO_PI * ampR * t + ampP))
                        if e.tremolo > 0 { amp *= 1 - e.tremolo * (0.5 + 0.5 * sin(TWO_PI * tremR * t + tremP)) }
                        for j in i..<bEnd {
                            var sl = 0.0, sr = 0.0
                            for o in 0..<nOsc {
                                let p = ph[o]
                                let v = isSaw ? 2 * p - 1 - polyblep(p, dt[o]) : sin(TWO_PI * p)
                                sl += v * gl[o]; sr += v * gr[o]
                                var np = p + dt[o]
                                if np >= 1 { np -= 1 }
                                ph[o] = np
                            }
                            sl = fl2.lp(fl1.lp(sl)); sr = fr2.lp(fr1.lp(sr))
                            let g = ep[j] * amp
                            lp[j] += Float(sl * g); rp[j] += Float(sr * g)
                        }
                        i = bEnd
                    }
                }
            }
        }
    }
    // Pads leave the lowest octave to the pulse and the impacts.
    var hl = Biquad.highpass(75, 0.707), hr = Biquad.highpass(75, 0.707)
    for i in 0..<len { L[i] = Float(hl.run(Double(L[i]))); R[i] = Float(hr.run(Double(R[i]))) }
    return [Piece(start: s0, l: L, r: R, dry: Float(e.dry), send: Float(e.send))]
}

/// The soft sub pulse: a sine with a quick downward pitch blip, lightly saturated so small speakers hear it.
struct Pulse { let t: Double; let hz: Double; let vel: Double; let duck: Double }

func renderPulse(_ p: Pulse) -> [Piece] {
    let len = smp(0.6)
    var l = [Float](repeating: 0, count: len)
    var phase = 0.0
    let drive = 3.4, nd = tanh(drive)
    let amp = 0.5 * p.vel
    var rng = RNG(UInt64(p.t * 1000) &+ 11)
    var bp = SVF(); bp.set(2600, 1.3)
    for i in 0..<len {
        let dt = Double(i) / SR
        let f = p.hz * (1 + 0.9 * exp(-dt / 0.018))
        phase += TWO_PI * f / SR
        let atk = dt < 0.005 ? sin(0.5 * Double.pi * dt / 0.005) : 1
        let fade = dt > 0.55 ? (0.6 - dt) / 0.05 : 1
        let env = atk * exp(-dt / 0.2) * fade
        // Saturated, so its harmonics (2 to 5 times the root, 100 to 400 Hz) carry it on a laptop.
        let body = tanh(drive * sin(phase)) / nd * 0.8
        let knock = sin(2 * phase) * exp(-dt / 0.05) * 0.45 + sin(3 * phase) * exp(-dt / 0.03) * 0.2
        let click = bp.bp(rng.bi()) * exp(-dt / 0.004) * 0.5
        l[i] = Float((body + knock) * env * amp + click * amp)
    }
    return [Piece(start: smp(p.t), l: l, r: l, dry: 1, send: 0.05)]
}

/// A soft filtered-noise tick (off-beats and the fine "data" texture).
struct Tick { let t: Double; let vel: Double; let pan: Double; let fc: Double; let decay: Double }

func renderTick(_ k: Tick, seed: UInt64) -> [Piece] {
    let len = smp(k.decay * 8 + 0.004)
    var rng = RNG(seed)
    var f = SVF(); f.set(k.fc, 1.4)
    var l = [Float](repeating: 0, count: len), r = [Float](repeating: 0, count: len)
    let (gl, gr) = panGains(k.pan)
    for i in 0..<len {
        let dt = Double(i) / SR
        let env = (dt < 0.001 ? dt / 0.001 : 1) * exp(-dt / k.decay)
        let y = f.bp(rng.bi()) * env * k.vel
        l[i] = Float(y * gl); r[i] = Float(y * gr)
    }
    return [Piece(start: smp(k.t), l: l, r: r, dry: 1, send: 0.25)]
}

/// Filtered noise rising into a moment: a band-pass sweeping up, louder as it goes.
/// A short `tail` cuts it just before a hit; a long one lets it bloom and fall away.
struct Riser { let t0: Double; let tPeak: Double; let tail: Double; let f0: Double; let f1: Double; let q: Double; let gainDb: Double; let power: Double }

func renderRiser(_ z: Riser, seed: UInt64) -> [Piece] {
    let rise = z.tPeak - z.t0
    let len = smp(rise + z.tail)
    var rl = RNG(seed), rr = RNG(seed &+ 977)
    var bl = SVF(), br = SVF(), ll = SVF(), lr = SVF()
    var l = [Float](repeating: 0, count: len), r = [Float](repeating: 0, count: len)
    let g = dbToGain(z.gainDb)
    for i in 0..<len {
        let dt = Double(i) / SR
        var x = 1.0, amp: Double
        if dt <= rise {
            x = dt / rise
            amp = pow(x, z.power)
        } else {
            let d = (dt - rise) / z.tail
            amp = z.tail < 0.1 ? max(0, 1 - d) : exp(-4 * d) * max(0, 1 - d)
        }
        if i % 32 == 0 {
            let fc = z.f0 * pow(z.f1 / z.f0, x)
            bl.set(fc, z.q); br.set(fc, z.q); ll.set(fc * 0.5, 0.7); lr.set(fc * 0.5, 0.7)
        }
        let nl = rl.bi(), nr = rr.bi()
        l[i] = Float((bl.bp(nl) + 0.3 * ll.lp(nl)) * amp * g)
        r[i] = Float((br.bp(nr) + 0.3 * lr.lp(nr)) * amp * g)
    }
    return [Piece(start: smp(z.t0), l: l, r: r, dry: 1, send: 0.4)]
}

/// A deep impact: a pitched sine dropping into the sub, plus (optionally) a short noise transient.
struct Impact { let t: Double; let strength: Double; let noise: Bool; let fStart: Double; let fEnd: Double; let decay: Double; let noiseLP: Double }

func renderImpact(_ z: Impact, seed: UInt64) -> [Piece] {
    var pieces: [Piece] = []
    let len = smp(z.decay * 5.5)
    var sub = [Float](repeating: 0, count: len)
    var phase = 0.0
    let drive = 4.0, nd = tanh(drive)
    let g = 0.42 * z.strength
    for i in 0..<len {
        let dt = Double(i) / SR
        let f = z.fEnd + (z.fStart - z.fEnd) * exp(-dt / 0.11)
        phase += TWO_PI * f / SR
        let atk = dt < 0.002 ? dt / 0.002 : 1
        let fade = Double(len - i) < 0.05 * SR ? Double(len - i) / (0.05 * SR) : 1
        let env = atk * exp(-dt / z.decay) * fade
        let boom = tanh(drive * sin(phase)) / nd
        let body = sin(2 * phase) * exp(-dt / 0.18) * 0.5 + sin(3 * phase) * exp(-dt / 0.12) * 0.22
        sub[i] = Float((boom + body) * env * g)
    }
    pieces.append(Piece(start: smp(z.t), l: sub, r: sub, dry: 1, send: 0.12))
    // The attack: a bright burst of noise and a ring of metal (inharmonic partials, 1 to 5 kHz), so the
    // hit has an edge on small speakers, not only weight.
    if z.noise {
        let al = smp(1.8)
        var ml = [Float](repeating: 0, count: al), mr = [Float](repeating: 0, count: al)
        var ra = RNG(seed &+ 501), rb = RNG(seed &+ 777)
        var ba = SVF(), bb = SVF(); ba.set(4200, 0.9); bb.set(4600, 0.9)
        let partials: [(Double, Double, Double, Double)] = [(1180, 1.0, 0.9, -0.3), (1733, 0.7, 0.7, 0.35), (2467, 0.5, 0.55, -0.5), (3251, 0.35, 0.4, 0.5), (4380, 0.22, 0.28, 0)]
        for i in 0..<al {
            let dt = Double(i) / SR
            let atk = dt < 0.001 ? dt / 0.001 : 1
            let fade = Double(al - i) < 0.05 * SR ? Double(al - i) / (0.05 * SR) : 1
            let burst = exp(-dt / 0.03) * atk * 0.55
            var vl = ba.bp(ra.bi()) * burst, vr = bb.bp(rb.bi()) * burst
            for (f, a, d, pan) in partials {
                let v = sin(TWO_PI * f * dt * (1 + 0.002 * sin(TWO_PI * 5 * dt))) * a * exp(-dt / d) * atk * 0.11
                let (pl, pr) = panGains(pan)
                vl += v * pl * 1.41; vr += v * pr * 1.41
            }
            ml[i] = Float(vl * fade * z.strength); mr[i] = Float(vr * fade * z.strength)
        }
        pieces.append(Piece(start: smp(z.t), l: ml, r: mr, dry: 1, send: 0.6))
    }
    if z.noise {
        let tl = smp(2.6)
        var nl = [Float](repeating: 0, count: tl), nr = [Float](repeating: 0, count: tl)
        var ra = RNG(seed), rb = RNG(seed &+ 31)
        var fa = SVF(), fb = SVF(), ga = SVF(), gb = SVF()
        ga.set(180, 0.7); gb.set(180, 0.7)
        for i in 0..<tl {
            let dt = Double(i) / SR
            if i % 32 == 0 {
                let fc = 500 + (z.noiseLP - 500) * exp(-dt / 0.06)
                fa.set(fc, 0.7); fb.set(fc, 0.7)
            }
            let atk = dt < 0.0015 ? dt / 0.0015 : 1
            let crack = exp(-dt / 0.045) * atk
            let rumble = exp(-dt / 0.55) * atk * 1.1
            let fade = Double(tl - i) < 0.05 * SR ? Double(tl - i) / (0.05 * SR) : 1
            let a = ra.bi(), b = rb.bi()
            nl[i] = Float((fa.lp(a) * crack + ga.lp(a) * rumble) * fade * 0.5 * z.strength)
            nr[i] = Float((fb.lp(b) * crack + gb.lp(b) * rumble) * fade * 0.5 * z.strength)
        }
        pieces.append(Piece(start: smp(z.t), l: nl, r: nr, dry: 1, send: 0.75))
    }
    return pieces
}

/// The wrist's buzz: a crisp double tick, 140 ms apart (as the picture shakes): a bright click on a
/// short 200 Hz body.
func renderHaptic(_ t: Double, gainDb: Double, seed: UInt64) -> [Piece] {
    let len = smp(0.3)
    var l = [Float](repeating: 0, count: len)
    var rng = RNG(seed)
    let g = dbToGain(gainDb)
    for (offset, a) in [(0.0, 1.0), (0.14, 0.62)] {
        let s = smp(offset)
        var bp = SVF(); bp.set(3300, 1.1)
        var hp = SVF(); hp.set(6500, 0.8)
        var phase = 0.0
        for i in 0..<smp(0.11) {
            let dt = Double(i) / SR
            let f = 205.0 * (1 + 0.25 * exp(-dt / 0.006))
            phase += TWO_PI * f / SR
            let atk = dt < 0.0015 ? sin(0.5 * Double.pi * dt / 0.0015) : 1
            let fade = dt > 0.095 ? (0.11 - dt) / 0.015 : 1
            let env = atk * exp(-dt / 0.045) * fade
            let tone = tanh(2.2 * (sin(phase) + 0.45 * sin(2 * phase) + 0.2 * sin(3 * phase))) / tanh(2.2)
            let n = rng.bi()
            let click = (bp.bp(n) * 0.9 + 0.35 * (n - hp.lp(n))) * exp(-dt / 0.0028)
            l[s + i] += Float((tone * 0.8 * env + click * 0.55) * a * g)
        }
    }
    return [Piece(start: smp(t), l: l, r: l, dry: 1, send: 0.08, fx: true)]
}

/// A tap on glass: a short bright click with a little body. Used for the app's buttons.
func renderTap(_ t: Double, gainDb: Double, pan: Double, seed: UInt64) -> [Piece] {
    let len = smp(0.08)
    var l = [Float](repeating: 0, count: len), r = [Float](repeating: 0, count: len)
    var rng = RNG(seed)
    var bp = SVF(); bp.set(3800, 1.6)
    let g = dbToGain(gainDb)
    let (pl, pr) = panGains(pan)
    for i in 0..<len {
        let dt = Double(i) / SR
        let atk = dt < 0.0008 ? dt / 0.0008 : 1
        let v = (bp.bp(rng.bi()) * exp(-dt / 0.003) * 0.9 + sin(TWO_PI * 1500 * dt) * exp(-dt / 0.008) * 0.35 + sin(TWO_PI * 260 * dt) * exp(-dt / 0.012) * 0.3) * atk * g
        l[i] = Float(v * pl); r[i] = Float(v * pr)
    }
    return [Piece(start: smp(t), l: l, r: r, dry: 1, send: 0.12, fx: true)]
}

/// The approval: a tap, then a quick rising pair of glass notes (E6, B6). Unlike the ask or the morning.
func renderConfirm(_ t: Double, gainDb: Double, seed: UInt64) -> [Piece] {
    var out = renderTap(t, gainDb: gainDb + 2, pan: 0.05, seed: seed)
    // The press itself has weight: a short rounded "thock" under the click.
    let tl = smp(0.12)
    var th = [Float](repeating: 0, count: tl)
    var ph = 0.0
    for i in 0..<tl {
        let dt = Double(i) / SR
        ph += TWO_PI * 185 * (1 + 0.3 * exp(-dt / 0.008)) / SR
        let atk = dt < 0.002 ? sin(0.5 * Double.pi * dt / 0.002) : 1
        let fade = dt > 0.1 ? (0.12 - dt) / 0.02 : 1
        th[i] = Float(tanh(2.0 * (sin(ph) + 0.4 * sin(2 * ph))) / tanh(2.0) * exp(-dt / 0.035) * atk * fade * dbToGain(gainDb) * 0.8)
    }
    out.append(Piece(start: smp(t), l: th, r: th, dry: 1, send: 0.1, fx: true))
    let len = smp(1.6)
    var l = [Float](repeating: 0, count: len), r = [Float](repeating: 0, count: len)
    let g = dbToGain(gainDb)
    for (k, (f, off, pan)) in [(1318.5, 0.03, -0.2), (1975.5, 0.11, 0.2)].enumerated() {
        let s = smp(off)
        let (pl, pr) = panGains(pan)
        for i in 0..<(len - s) {
            let dt = Double(i) / SR
            let atk = dt < 0.003 ? 0.5 - 0.5 * cos(Double.pi * dt / 0.003) : 1
            let v = (sin(TWO_PI * f * dt) + 0.3 * sin(TWO_PI * f * 2.0 * dt) * exp(-dt / 0.12) + 0.12 * sin(TWO_PI * f * 3.01 * dt) * exp(-dt / 0.06)) * exp(-dt / (k == 0 ? 0.22 : 0.42)) * atk * g * 0.5
            l[s + i] += Float(v * pl); r[s + i] += Float(v * pr)
        }
    }
    out.append(Piece(start: smp(t), l: l, r: r, dry: 1, send: 0.45, fx: true))
    return out
}

/// Air: high, soft, wide noise (4 to 12 kHz), each side its own, so the score breathes on top.
struct Air { let t0: Double; let t1: Double; let fadeIn: Double; let fadeOut: Double; let level: Curve }

func renderAir(_ z: Air, seed: UInt64) -> [Piece] {
    let len = smp(z.t1 - z.t0)
    var l = [Float](repeating: 0, count: len), r = [Float](repeating: 0, count: len)
    for ch in 0..<2 {
        var rng = RNG(seed &+ UInt64(ch) * 97)
        var h1 = SVF(), h2 = SVF(), lp = SVF()
        h1.set(4200, 0.7); h2.set(4200, 0.7); lp.set(11_500, 0.7)
        let mr = 0.11 + 0.07 * Double(ch), mp = Double(ch) * 2.1
        for i in 0..<len {
            let dt = Double(i) / SR
            let t = z.t0 + dt
            let n = rng.bi()
            let a1 = n - h1.lp(n)
            let a2 = a1 - h2.lp(a1)
            var a = 1.0
            if dt < z.fadeIn { a = 0.5 - 0.5 * cos(Double.pi * dt / z.fadeIn) }
            let left = (z.t1 - z.t0) - dt
            if left < z.fadeOut { a *= 0.5 - 0.5 * cos(Double.pi * max(0, left) / z.fadeOut) }
            a *= 1 + 0.35 * sin(TWO_PI * mr * t + mp)
            let y = lp.lp(a2) * a * dbToGain(z.level.at(t))
            if ch == 0 { l[i] = Float(y) } else { r[i] = Float(y) }
        }
    }
    return [Piece(start: smp(z.t0), l: l, r: r, dry: 1, send: 0.3)]
}

/// A clean, glassy bell: a few partials (two of them slightly inharmonic) with exponential decays.
struct ChimeNote { let midi: Double; let offset: Double; let pan: Double; let amp: Double }
struct Chime { let t: Double; let notes: [ChimeNote]; let gainDb: Double; let decayScale: Double; let send: Double }

func renderChime(_ c: Chime) -> [Piece] {
    let ratios = [1.0, 2.0, 3.0, 4.17, 5.43]
    let gains = [1.0, 0.28, 0.09, 0.06, 0.025]
    let decays = [2.4, 1.1, 0.55, 0.32, 0.2]
    let maxOff = c.notes.map { $0.offset }.max() ?? 0
    let len = smp(maxOff + 2.4 * c.decayScale * 5)
    var l = [Float](repeating: 0, count: len), r = [Float](repeating: 0, count: len)
    let g = dbToGain(c.gainDb)
    for n in c.notes {
        let f = midiHz(n.midi)
        let (pl, pr) = panGains(n.pan)
        let s = smp(n.offset)
        for (pi, ratio) in ratios.enumerated() {
            let twins: [(Double, Double)] = pi == 0 ? [(1.0, 1.0), (1.0012, 0.5)] : [(1.0, 1.0)]
            for (tw, ta) in twins {
                let fp = f * ratio * tw
                if fp > 9_000 { continue }
                let dec = decays[pi] * c.decayScale
                let a0 = gains[pi] * ta * n.amp * g
                let w = TWO_PI * fp / SR
                for i in 0..<(len - s) {
                    let dt = Double(i) / SR
                    let atk = dt < 0.002 ? 0.5 - 0.5 * cos(Double.pi * dt / 0.002) : 1
                    let rem = Double(len - s - i)
                    let fade = rem < 0.05 * SR ? rem / (0.05 * SR) : 1
                    let v = sin(w * Double(i)) * a0 * atk * exp(-dt / dec) * fade
                    l[s + i] += Float(v * pl); r[s + i] += Float(v * pr)
                }
            }
        }
    }
    return [Piece(start: smp(c.t), l: l, r: r, dry: 1, send: Float(c.send))]
}

/// Room tone: pink noise, low-passed, barely there. Gives the black and the night some air.
struct Room { let t0: Double; let t1: Double; let fadeIn: Double; let fadeOut: Double; let gainDb: Double; let lp: Double }

func renderRoom(_ z: Room, seed: UInt64) -> [Piece] {
    let len = smp(z.t1 - z.t0)
    var l = [Float](repeating: 0, count: len), r = [Float](repeating: 0, count: len)
    let g = dbToGain(z.gainDb)
    for (ch, sd) in [(0, seed), (1, seed &+ 5)] {
        var rng = RNG(sd)
        var b0 = 0.0, b1 = 0.0, b2 = 0.0
        var f1 = SVF(), f2 = SVF(); f1.set(z.lp, 0.6); f2.set(z.lp, 0.6)
        let modR = 0.07 + 0.05 * Double(ch), modP = Double(ch) * 1.7
        for i in 0..<len {
            let dt = Double(i) / SR
            let w = rng.bi()
            b0 = 0.99765 * b0 + w * 0.0990460
            b1 = 0.96300 * b1 + w * 0.2965164
            b2 = 0.57000 * b2 + w * 1.0526913
            let pink = (b0 + b1 + b2 + w * 0.1848) * 0.25
            var a = 1.0
            if dt < z.fadeIn { a = 0.5 - 0.5 * cos(Double.pi * dt / z.fadeIn) }
            let left = (z.t1 - z.t0) - dt
            if left < z.fadeOut { a *= 0.5 - 0.5 * cos(Double.pi * max(0, left) / z.fadeOut) }
            a *= 1 + 0.3 * sin(TWO_PI * modR * (z.t0 + dt) + modP)
            let y = f2.lp(f1.lp(pink)) * a * g
            if ch == 0 { l[i] = Float(y) } else { r[i] = Float(y) }
        }
    }
    return [Piece(start: smp(z.t0), l: l, r: r, dry: 1, send: 0.1)]
}

// MARK: - The score, in time

func midis(_ ns: [Int]) -> [Double] { ns.map(Double.init) }

/// Sub-pulse roots per chord (Hz, MIDI 31 to 38: low, so the saturation's harmonics carry it).
let hzB1 = midiHz(35), hzG1 = midiHz(31), hzD2 = midiHz(38), hzA1 = midiHz(33), hzCs2 = midiHz(37)

func rootAt(_ t: Double, _ table: [(Double, Double)]) -> Double {
    var hz = table[0].1
    for (start, h) in table where t >= start - 1e-9 { hz = h }
    return hz
}

let allPulses: [Pulse] = {
    var out: [Pulse] = []
    // The night build, 34.0 to 58.0: every beat, growing.
    let build: [(Double, Double)] = [(34, hzB1), (34 + 8 * BEAT, hzG1), (34 + 16 * BEAT, hzD2), (34 + 24 * BEAT, hzA1)]
    for k in 0..<36 {
        let t = 34 + Double(k) * BEAT, x = Double(k) / 35
        var v = 0.5 + 0.38 * x
        if k % 4 == 0 { v *= 1.12 }
        out.append(Pulse(t: t, hz: rootAt(t, build), vel: v, duck: 0.16 + 0.12 * x))
    }
    // It's live, 72.0 to 86.0: the pulse comes back, lighter.
    let live: [(Double, Double)] = [(72, hzG1), (72 + 8 * BEAT, hzD2), (72 + 16 * BEAT, hzA1)]
    for k in 0..<21 {
        let t = 72 + Double(k) * BEAT, x = Double(k) / 20
        var v = 0.42 + 0.33 * x
        if k % 4 == 0 { v *= 1.1 }
        out.append(Pulse(t: t, hz: rootAt(t, live), vel: v, duck: 0.12 + 0.08 * x))
    }
    // How it works, 96.0 to 128.0: half time, a calm heartbeat; each node's first beat a little firmer.
    let how: [(Double, Double)] = [(96, hzB1), (96 + NODE, hzG1), (96 + 2 * NODE, hzD2), (96 + 3 * NODE, hzA1), (96 + 4 * NODE, hzB1), (96 + 5 * NODE, hzG1)]
    for k in 0..<24 {
        let t = 96 + Double(k) * 2 * BEAT
        let v = k % 4 == 0 ? 0.62 : 0.42
        out.append(Pulse(t: t, hz: rootAt(t, how), vel: v, duck: 0.1))
    }
    // It already works: half time from 133.3, then every beat from 138.7 up to the final hit.
    for k in 0..<4 {
        let t = 128 + NODE + Double(k) * 2 * BEAT
        out.append(Pulse(t: t, hz: hzCs2, vel: 0.4, duck: 0.08))
    }
    for k in 0..<17 {
        let t = 128 + 2 * NODE + Double(k) * BEAT, x = Double(k) / 16
        var v = 0.6 + 0.4 * x
        if k % 4 == 0 { v *= 1.1 }
        out.append(Pulse(t: t, hz: t < 144 ? hzB1 : hzG1, vel: v, duck: 0.14 + 0.12 * x))
    }
    return out
}()

let duckBuf: [Float] = {
    var d = [Float](repeating: 1, count: N)
    for p in allPulses where p.duck > 0 {
        let s = smp(p.t)
        for i in 0..<smp(0.6) where s + i < N {
            let dt = Double(i) / SR
            let shape = dt < 0.012 ? dt / 0.012 : exp(-(dt - 0.012) / 0.17)
            let g = Float(1 - p.duck * shape)
            if g < d[s + i] { d[s + i] = g }
        }
    }
    return d
}()

/// Every pad dips 3 to 6 dB under each haptic pulse, so the wrist's tap reads clearly.
let hapticTimes: [(Double, Double)] = []   // (time, depth): the music bus ducks under the cues instead (see busDuck)
let hapticDuck: [Float] = {
    var d = [Float](repeating: 1, count: N)
    for (t, depth) in hapticTimes {
        let s = smp(t - 0.01)
        for i in 0..<smp(0.45) where s + i < N {
            let dt = Double(i) / SR
            let shape = dt < 0.01 ? dt / 0.01 : (dt < 0.2 ? 1 : exp(-(dt - 0.2) / 0.08))
            d[s + i] = Float(1 - depth * shape)
        }
    }
    return d
}()

enum Job {
    case pad(Pad)
    case pulse(Pulse)
    case tick(Tick)
    case riser(Riser)
    case impact(Impact)
    case haptic(Double, Double)
    case chime(Chime)
    case room(Room)
    case tap(Double, Double, Double)
    case confirm(Double, Double)
    case air(Air)
}

struct Cue: Codable { let t: Double; let what: String }

func buildScore() -> (jobs: [Job], cues: [Cue]) {
    var jobs: [Job] = []
    var cues: [Cue] = []
    func cue(_ t: Double, _ what: String) { cues.append(Cue(t: (t * 1000).rounded() / 1000, what: what)) }

    // 0 to 4: black. Air, and a low open D rising out of nothing; the light leak glints high.
    jobs.append(.room(Room(t0: 0, t1: 26.0, fadeIn: 3.0, fadeOut: 0.3, gainDb: -50, lp: 900)))
    jobs.append(.pad(Pad(start: 0.2, end: 8.0, attack: 4.5, release: 3.5, notes: midis([38, 45, 52, 57]), gainDb: -12, cutoff: Curve([(0, 240), (8, 480)]))))
    jobs.append(.pad(Pad(start: 0.8, end: 3.4, attack: 2.0, release: 3.0, notes: midis([81, 88]), gainDb: -31, cutoff: Curve([(0, 9000)]), wave: .sine, send: 0.9, dry: 0.5, tremolo: 0.4)))
    cue(0, "black: air and a low open D fade in from silence")

    // 4 to 12: the wrist in the dark. The chord turns under the spoken line.
    jobs.append(.pad(Pad(start: 6.5, end: 14.0, attack: 3.5, release: 3.0, notes: midis([38, 47, 54, 61]), gainDb: -11, cutoff: Curve([(6.5, 400), (14, 700)]))))
    cue(4, "the man, then the wrist: a quiet bed for the spoken line")
    jobs.append(.riser(Riser(t0: 5.0, tPeak: 7.25, tail: 1.6, f0: 180, f1: 2600, q: 0.9, gainDb: -24, power: 2.0)))
    jobs.append(.impact(Impact(t: 7.3, strength: 0.22, noise: false, fStart: 95, fEnd: 44, decay: 1.0, noiseLP: 0)))
    jobs.append(.chime(Chime(t: 7.32, notes: [ChimeNote(midi: 74, offset: 0, pan: 0.15, amp: 1)], gainDb: -30, decayScale: 1.2, send: 0.8)))
    cue(5.0, "the push into the watch: air rising to 7.25, a soft low bloom as the wrist appears (7.3)")

    // 12 to 20: the push in; the screen wakes; the ask arrives at 13.5.
    jobs.append(.riser(Riser(t0: 12.0, tPeak: 19.0, tail: 2.5, f0: 140, f1: 900, q: 0.8, gainDb: -30, power: 1.6)))
    jobs.append(.pad(Pad(start: 12.4, end: 20.5, attack: 3.0, release: 2.0, notes: midis([43, 50, 54, 57, 59]), gainDb: -9.5, cutoff: Curve([(12.4, 560), (20.5, 1200)]))))
    jobs.append(.haptic(13.5, 1))
    jobs.append(.chime(Chime(t: 13.52, notes: [ChimeNote(midi: 78, offset: 0, pan: -0.1, amp: 1)], gainDb: -22, decayScale: 0.8, send: 0.55)))
    cue(12, "push in: a slow low air swell")
    cue(13.5, "haptic double tick (the ask arrives), soft F#5 glass tone at 13.52; the music dips 6 dB for 0.3 s")
    jobs.append(.riser(Riser(t0: 18.9, tPeak: 19.8, tail: 0.25, f0: 900, f1: 5200, q: 0.8, gainDb: -32, power: 2.0)))
    cue(19.8, "a breath of air into the cut to the phone")

    // 20 to 26: the tick at 21.0. "One tap." Tension gathers toward the night.
    jobs.append(.confirm(21.0, -3))
    jobs.append(.pad(Pad(start: 19.6, end: 25.55, attack: 2.0, release: 0.33, notes: midis([45, 50, 52, 57, 62]), gainDb: -8.5, cutoff: Curve([(19.6, 800), (25.9, 2200)]))))
    jobs.append(.riser(Riser(t0: 23.0, tPeak: 25.9, tail: 0.04, f0: 300, f1: 3800, q: 1.2, gainDb: -22, power: 2.4)))
    cue(21.0, "the approval: a tap on glass and a rising pair of glass notes (E6, B6); the music dips 6 dB")
    cue(23.0, "riser into the night, cut at 25.94; 60 ms of air before the drop")

    // 26: the drop into night. 26 to 34: a dark, wide B minor; stars high up.
    jobs.append(.impact(Impact(t: 26.0, strength: 0.75, noise: true, fStart: 140, fEnd: 36, decay: 1.4, noiseLP: 1600)))
    jobs.append(.pad(Pad(start: 26.0, end: 33.9, attack: 0.35, release: 1.4, notes: midis([35, 42, 50, 54, 61]), gainDb: -11, cutoff: Curve([(26, 260), (34, 800)]))))
    jobs.append(.pad(Pad(start: 26.4, end: 33.5, attack: 3.0, release: 3.5, notes: midis([74, 78, 85]), gainDb: -28, cutoff: Curve([(0, 9000)]), wave: .sine, send: 0.9, dry: 0.5, tremolo: 0.5)))
    jobs.append(.room(Room(t0: 26.0, t1: 34.5, fadeIn: 1.5, fadeOut: 1.5, gainDb: -47, lp: 380)))
    cue(26.0, "impact: the drop into night (pitched sine 140 to 36 Hz, noise transient)")

    // 34 to 58: the build. 90 BPM, a chord every 8 beats, the filter opening, the pulse growing.
    let buildCut = Curve([(34, 800), (58, 2400)])
    let buildChords: [[Int]] = [[35, 47, 54, 57, 62], [43, 50, 55, 59, 66], [38, 45, 54, 57, 64], [45, 52, 57, 61, 64]]
    for (i, ch) in buildChords.enumerated() {
        let s = 34 + Double(i) * NODE
        jobs.append(.pad(Pad(start: s, end: s + NODE, attack: i == 0 ? 0.2 : 0.35, release: 0.6, notes: midis(ch), gainDb: -10.5 + Double(i) * 1.1, cutoff: buildCut, duck: true)))
    }
    jobs.append(.pad(Pad(start: 34 + 4 * NODE, end: 58.2, attack: 0.35, release: 2.2, notes: midis([45, 52, 57, 62, 64]), gainDb: -6, cutoff: buildCut, duck: true)))
    jobs.append(.impact(Impact(t: 34.0, strength: 0.3, noise: false, fStart: 110, fEnd: 50, decay: 0.8, noiseLP: 0)))
    cue(34.0, "the build pulse starts: sub pulse every beat at 90 BPM (beat 0.667 s) to 57.33")
    for k in 8..<36 {
        let t = 34 + (Double(k) + 0.5) * BEAT, x = Double(k - 8) / 27
        jobs.append(.tick(Tick(t: t, vel: 0.05 + 0.05 * x, pan: k % 2 == 0 ? -0.3 : 0.3, fc: 3200, decay: 0.018)))
    }
    var dataRng = RNG(77)
    for k in 0..<76 {   // 16ths from 44.67 to 57.33, sparse and soft
        let t = 34 + 2 * NODE + Double(k) * BEAT / 4
        if t > 57.3 { break }
        if dataRng.unit() < 0.4 { continue }
        jobs.append(.tick(Tick(t: t, vel: 0.02 + 0.025 * dataRng.unit(), pan: dataRng.bi() * 0.5, fc: 2400, decay: 0.01)))
    }

    // The close-ups cut on the beat; each chip that turns green, and each step on the rail, rings.
    for t in [46.0, 46.0 + 2 * BEAT, 46.0 + 4 * BEAT, 50.0] { jobs.append(.tap(t, -21, 0)) }
    for (t, m) in [(46.3, 86.0), (46.9, 88.0), (48.95, 90.0)] {
        jobs.append(.chime(Chime(t: t, notes: [ChimeNote(midi: m, offset: 0, pan: 0.2, amp: 1)], gainDb: -24, decayScale: 0.35, send: 0.5)))
    }
    // (When each step appears in the footage, by the film's clock in scenes/shots/night.js.)
    jobs.append(.chime(Chime(t: 34.86, notes: [ChimeNote(midi: 83, offset: 0, pan: 0.2, amp: 1)], gainDb: -26, decayScale: 0.4, send: 0.5)))
    for (t, m) in [(50.0, 74.0), (50.88, 78.0)] {
        jobs.append(.chime(Chime(t: t, notes: [ChimeNote(midi: m, offset: 0, pan: -0.15, amp: 1), ChimeNote(midi: m + 12, offset: 0.02, pan: 0.15, amp: 0.4)], gainDb: -19, decayScale: 0.9, send: 0.6)))
    }
    // Published and Delivered light up together, with the link: a chord.
    jobs.append(.chime(Chime(t: 54.12, notes: [ChimeNote(midi: 81, offset: 0, pan: -0.25, amp: 1), ChimeNote(midi: 86, offset: 0.04, pan: 0.25, amp: 0.9), ChimeNote(midi: 93, offset: 0.08, pan: 0, amp: 0.45)], gainDb: -16, decayScale: 1.2, send: 0.65)))
    cue(46.0, "close-ups cut on the beat (46.0, 47.33, 48.67, 50.0); chips ring as they turn green (46.3, 46.9, 48.95)")
    cue(50.0, "the rail lights up: Built 50.0, Checked 50.88, Published and Delivered together with the link 54.12 (a chord); the sandbox check chip 34.86")

    // 58 to 64: sunrise. G major swells and opens, noise rises, peaking at 64.0.
    jobs.append(.pad(Pad(start: 57.2, end: 64.0, attack: 1.2, release: 1.6, notes: midis([43, 50, 55, 59, 62, 66]), gainDb: -3.5, cutoff: Curve([(58, 700), (64, 4000)]), level: Curve([(57.2, -7), (58.0, -5.5), (64.0, 0)], log: false))))
    jobs.append(.riser(Riser(t0: 58.0, tPeak: 64.0, tail: 0.5, f0: 220, f1: 5000, q: 1.1, gainDb: -16, power: 2.0)))
    jobs.append(.pad(Pad(start: 59.0, end: 64.3, attack: 4.5, release: 3.0, notes: midis([74, 79, 83, 86]), gainDb: -24, cutoff: Curve([(0, 9000)]), wave: .sine, send: 0.9, dry: 0.5, tremolo: 0.3)))
    cue(58.0, "sunrise swell: noise riser 220 Hz to 5 kHz and a G major swell")

    // 64: the bloom; D major add9, bright, then settling into the morning.
    jobs.append(.pad(Pad(start: 63.25, end: 71.5, attack: 0.6, release: 2.5, notes: midis([38, 45, 50, 54, 57, 64, 66]), gainDb: -3, cutoff: Curve([(63.9, 4000), (65, 2400), (68, 1800)]), decayTo: 0.4, decayTime: 0.8)))
    jobs.append(.impact(Impact(t: 63.9, strength: 0.5, noise: false, fStart: 90, fEnd: 46, decay: 0.6, noiseLP: 0)))
    jobs.append(.pad(Pad(start: 64.0, end: 71.0, attack: 1.5, release: 3.0, notes: midis([78, 81, 86]), gainDb: -30, cutoff: Curve([(0, 9000)]), wave: .sine, send: 0.9, dry: 0.5, tremolo: 0.3)))
    cue(64.0, "sunrise peak: the D major bloom (soft low bloom, no transient)")

    // 65: the morning to-do. Haptic and the clean two-note chime.
    jobs.append(.haptic(65.0, 0))
    jobs.append(.chime(Chime(t: 65.02, notes: [ChimeNote(midi: 81, offset: 0, pan: -0.15, amp: 1), ChimeNote(midi: 86, offset: 0.09, pan: 0.15, amp: 0.85)], gainDb: -7.5, decayScale: 1.0, send: 0.5)))
    cue(65.0, "haptic double tick (the morning to-do), chime A5 at 65.02 and D6 at 65.11; the music dips 6 dB")
    jobs.append(.riser(Riser(t0: 70.2, tPeak: 71.97, tail: 0.04, f0: 300, f1: 6000, q: 1.1, gainDb: -20, power: 2.2)))
    jobs.append(.impact(Impact(t: 72.0, strength: 0.42, noise: true, fStart: 120, fEnd: 45, decay: 1.0, noiseLP: 3000)))
    jobs.append(.chime(Chime(t: 72.02, notes: [ChimeNote(midi: 81, offset: 0, pan: -0.2, amp: 1), ChimeNote(midi: 88, offset: 0.05, pan: 0.2, amp: 0.7)], gainDb: -17, decayScale: 1.2, send: 0.6)))
    cue(70.2, "the dive into the link: a riser cut at 71.97")
    cue(72.0, "it's live: a bright hit as the phone appears")
    // The app being used: a tap on glass for every real tap in the capture (the picture's frame/30 + 71.7).
    for (k, f) in [25, 48, 61, 86, 97, 122, 139, 166, 193, 220, 250, 274, 304, 331, 361, 385, 415].enumerated() {
        jobs.append(.tap(Double(f) / 30 + 71.7, -19, k % 2 == 0 ? 0.25 : 0.35))
    }
    cue(72.53, "taps on the app's buttons, one for each real tap (17, to 85.53)")

    // 72 to 86: it's live. The pulse returns, lighter; the chords climb toward the wordmark.
    let liveChords: [([Int], Double, Double)] = [([43, 50, 55, 59, 66], 72, 72 + NODE), ([42, 50, 54, 57, 62, 69], 72 + NODE, 72 + 2 * NODE)]
    for (ch, s, e) in liveChords {
        jobs.append(.pad(Pad(start: s, end: e, attack: s == 72 ? 1.0 : 0.35, release: 0.6, notes: midis(ch), gainDb: -6.5, cutoff: Curve([(72, 1100), (82.7, 1800)]), duck: true)))
    }
    jobs.append(.pad(Pad(start: 72 + 2 * NODE, end: 86.2, attack: 0.35, release: 0.15, notes: midis([45, 52, 57, 62, 64, 69]), gainDb: -5, cutoff: Curve([(82.7, 1800), (86.3, 3500)]), duck: true)))
    for k in 0..<21 {
        let t = 72 + (Double(k) + 0.5) * BEAT
        if t > 85.7 { break }
        jobs.append(.tick(Tick(t: t, vel: 0.05 + 0.025 * Double(k) / 20, pan: k % 2 == 0 ? -0.3 : 0.3, fc: 3400, decay: 0.016)))
    }
    jobs.append(.riser(Riser(t0: 82.8, tPeak: 86.38, tail: 0.04, f0: 250, f1: 6500, q: 1.2, gainDb: -13, power: 2.2)))
    cue(72.0, "it's live: the pulse returns at 90 BPM, lighter, to 85.33")
    cue(82.8, "riser into the wordmark, cut at 86.42")

    // 86.5: the wordmark. The biggest hit; a wide, full D major blooming and falling away.
    jobs.append(.impact(Impact(t: 86.5, strength: 0.85, noise: true, fStart: 160, fEnd: 38, decay: 1.6, noiseLP: 2600)))
    jobs.append(.pad(Pad(start: 86.5, end: 95.0, attack: 0.08, release: 2.6, notes: midis([38, 45, 50, 54, 57, 62, 64, 69]), gainDb: -1.0, cutoff: Curve([(86.5, 3500), (95.5, 1200)]), decayTo: 0.6, decayTime: 5.0)))
    jobs.append(.pad(Pad(start: 86.6, end: 95.0, attack: 1.5, release: 3.0, notes: midis([74, 78, 81, 86, 90]), gainDb: -22, cutoff: Curve([(0, 9000)]), wave: .sine, send: 0.9, dry: 0.5, tremolo: 0.3)))
    cue(86.5, "impact: the wordmark (pitched sine 160 to 38 Hz, noise transient), D major bloom")

    // 96 to 128: how it works. Six beats of 16/3 s, a chord and a soft glass ping on each.
    let howChords: [[Int]] = [[35, 47, 54, 57, 62], [43, 50, 55, 59, 66], [38, 45, 54, 57, 64], [45, 52, 57, 61, 64], [35, 47, 54, 57, 62], [43, 50, 55, 59, 62, 66]]
    for (i, ch) in howChords.enumerated() {
        let s = 96 + Double(i) * NODE
        let last = i == howChords.count - 1
        jobs.append(.pad(Pad(start: s, end: s + NODE, attack: i == 0 ? 1.2 : 0.35, release: last ? 1.0 : 0.6, notes: midis(ch), gainDb: -10.5, cutoff: Curve([(96, 1100), (122, 1400), (128, 1800)]), duck: true)))
        jobs.append(.chime(Chime(t: s, notes: [ChimeNote(midi: 81, offset: 0, pan: i % 2 == 0 ? -0.25 : 0.25, amp: 1)], gainDb: -22, decayScale: 1.4, send: 0.65)))
        cue(s, "how it works, beat \(i + 1) of 6: chord change and a soft A5 ping")
    }
    for k in 0..<48 {
        let t = 96 + (Double(k) + 0.5) * BEAT
        jobs.append(.tick(Tick(t: t, vel: 0.035, pan: k % 2 == 0 ? -0.3 : 0.3, fc: 3000, decay: 0.014)))
    }
    jobs.append(.haptic(96 + 2 * NODE + 0.05, -8))
    jobs.append(.haptic(96 + 5 * NODE + 0.05, -8))
    for f in [274, 304, 331, 361, 385, 415, 445] { jobs.append(.tap(Double(f) / 30 + 107.933, -23, 0.3)) }
    cue(106.72, "how it works: the wrist buzzes on beats 3 and 6 (106.72, 122.72); taps on the app in beat 5")
    jobs.append(.riser(Riser(t0: 125.6, tPeak: 127.4, tail: 0.04, f0: 300, f1: 3500, q: 1.0, gainDb: -26, power: 1.8)))
    cue(127.45, "near silence for half a second before the lift")

    // 128: a soft lift. "It already works." Brighter chords; the pulse returns and climbs to the final hit.
    let workChords: [([Int], Double, Double)] = [([38, 45, 50, 54, 57, 64], 128, 128 + NODE), ([37, 45, 52, 57, 61, 64], 128 + NODE, 128 + 2 * NODE), ([35, 47, 54, 57, 62, 66], 128 + 2 * NODE, 144)]
    for (ch, s, e) in workChords {
        jobs.append(.pad(Pad(start: s, end: e, attack: s == 128 ? 0.6 : 0.35, release: 0.6, notes: midis(ch), gainDb: -7.5, cutoff: Curve([(128, 1800), (144, 2400)]), duck: true)))
    }
    jobs.append(.pad(Pad(start: 144.0, end: 150.25, attack: 0.35, release: 0.15, notes: midis([43, 50, 55, 59, 62, 66]), gainDb: -5.5, cutoff: Curve([(144, 2400), (150.4, 3500)]), duck: true)))
    jobs.append(.impact(Impact(t: 128.0, strength: 0.38, noise: true, fStart: 110, fEnd: 48, decay: 1.0, noiseLP: 2600)))
    jobs.append(.chime(Chime(t: 128.02, notes: [ChimeNote(midi: 81, offset: 0, pan: -0.25, amp: 1), ChimeNote(midi: 88, offset: 0.04, pan: 0.25, amp: 0.8), ChimeNote(midi: 93, offset: 0.08, pan: 0, amp: 0.5)], gainDb: -16, decayScale: 1.3, send: 0.7)))
    for f in [31, 103, 163] { jobs.append(.tap(Double(f) / 30 + 132.0, -21, -0.3)) }
    // The numbers: each has its moment (141.6, 144.2, 146.8); the nine builds and thirteen checks light up.
    for (i, (t, m)) in [(141.6, 74.0), (144.2, 78.0), (146.8, 81.0)].enumerated() {
        jobs.append(.impact(Impact(t: t, strength: 0.2, noise: false, fStart: 90, fEnd: 46, decay: 0.7, noiseLP: 0)))
        jobs.append(.chime(Chime(t: t + 0.01, notes: [ChimeNote(midi: m, offset: 0, pan: Double(i - 1) * 0.4, amp: 1), ChimeNote(midi: m + 7, offset: 0.03, pan: Double(i - 1) * 0.4, amp: 0.5)], gainDb: -18, decayScale: 1.0, send: 0.6)))
    }
    for d in 0..<9 { jobs.append(.tap(141.8 + Double(d) * 0.11, -28, -0.4 + Double(d) * 0.1)) }
    for d in 0..<13 { jobs.append(.tap(144.4 + Double(d) * 0.07, -30, -0.4 + Double(d) * 0.066)) }
    cue(141.6, "the numbers: a soft hit and a chime for each (141.6, 144.2, 146.8), ticks as the lights come on")
    jobs.append(.pad(Pad(start: 128.0, end: 136.0, attack: 1.2, release: 3.5, notes: midis([81, 86, 88]), gainDb: -30, cutoff: Curve([(0, 9000)]), wave: .sine, send: 0.9, dry: 0.5, tremolo: 0.3)))
    for k in 0..<17 {
        let t = 128 + 2 * NODE + (Double(k) + 0.5) * BEAT
        if t > 149.8 { break }
        jobs.append(.tick(Tick(t: t, vel: 0.05 + 0.04 * Double(k) / 16, pan: k % 2 == 0 ? -0.3 : 0.3, fc: 3200, decay: 0.018)))
    }
    var dataRng2 = RNG(91)
    for k in 0..<48 {
        let t = 128 + 2 * NODE + Double(k) * BEAT / 4
        if t > 149.3 { break }
        if dataRng2.unit() < 0.4 { continue }
        jobs.append(.tick(Tick(t: t, vel: 0.02 + 0.025 * dataRng2.unit(), pan: dataRng2.bi() * 0.5, fc: 2400, decay: 0.01)))
    }
    jobs.append(.riser(Riser(t0: 146.7, tPeak: 150.38, tail: 0.04, f0: 250, f1: 6500, q: 1.2, gainDb: -15, power: 2.2)))
    cue(128.0, "the lift: after half a second of near silence, a bright hit, a high chord and air; taps on the plant app (133.03, 135.43, 137.43)")
    cue(133.333, "the pulse returns in half time")
    cue(138.667, "the pulse every beat, climbing to 149.33")
    cue(146.7, "riser into the final hit, cut at 150.42")

    // 150.5: the final hit. The last chord rings out and is gone by 159.0.
    jobs.append(.impact(Impact(t: 150.5, strength: 0.8, noise: true, fStart: 160, fEnd: 38, decay: 1.6, noiseLP: 2400)))
    jobs.append(.pad(Pad(start: 150.5, end: 155.0, attack: 0.08, release: 4.0, notes: midis([38, 45, 50, 54, 57, 62, 64, 69]), gainDb: -2, cutoff: Curve([(150.5, 3200), (158, 800)]), decayTo: 0.5, decayTime: 3.0)))
    jobs.append(.pad(Pad(start: 150.6, end: 155.0, attack: 1.2, release: 4.0, notes: midis([74, 78, 81, 86]), gainDb: -23, cutoff: Curve([(0, 9000)]), wave: .sine, send: 0.9, dry: 0.5, tremolo: 0.3)))
    cue(150.5, "impact: the final hit, the last D major rings out")
    cue(155.5, "master fade begins")
    cue(159.0, "digital silence to the end (160.0)")

    // Air on top of the score, so it has a top end: the night, the build, the sunrise, the brand half.
    jobs.append(.air(Air(t0: 26.0, t1: 34.6, fadeIn: 1.5, fadeOut: 0.8, level: Curve([(26, -44), (34, -40)], log: false))))
    jobs.append(.air(Air(t0: 34.0, t1: 58.5, fadeIn: 0.5, fadeOut: 0.6, level: Curve([(34, -44), (57, -37)], log: false))))
    jobs.append(.air(Air(t0: 57.5, t1: 72.2, fadeIn: 2.0, fadeOut: 0.3, level: Curve([(58, -42), (64, -31), (68, -38), (72, -36)], log: false))))
    jobs.append(.air(Air(t0: 72.0, t1: 86.4, fadeIn: 0.3, fadeOut: 0.3, level: Curve([(72, -36), (86, -38)], log: false))))
    jobs.append(.air(Air(t0: 86.5, t1: 96.5, fadeIn: 0.05, fadeOut: 1.5, level: Curve([(86.5, -30), (96, -40)], log: false))))
    jobs.append(.air(Air(t0: 96.0, t1: 127.45, fadeIn: 1.0, fadeOut: 0.1, level: Curve([(96, -42), (127, -40)], log: false))))
    jobs.append(.air(Air(t0: 128.0, t1: 150.4, fadeIn: 0.05, fadeOut: 0.1, level: Curve([(128, -32), (131, -40), (149, -35)], log: false))))
    jobs.append(.air(Air(t0: 150.5, t1: 159.0, fadeIn: 0.05, fadeOut: 3.0, level: Curve([(150.5, -30), (158, -40)], log: false))))
    // A high shimmer over the sunrise and the end: soft sines two octaves up.
    jobs.append(.pad(Pad(start: 60.0, end: 66.0, attack: 3.5, release: 3.0, notes: midis([98, 103, 107]), gainDb: -36, cutoff: Curve([(0, 14000)]), wave: .sine, send: 0.9, dry: 0.4, tremolo: 0.5)))
    jobs.append(.pad(Pad(start: 150.6, end: 156.0, attack: 1.0, release: 3.0, notes: midis([98, 102, 105]), gainDb: -36, cutoff: Curve([(0, 14000)]), wave: .sine, send: 0.9, dry: 0.4, tremolo: 0.5)))

    return (jobs, cues)
}

func render(_ job: Job, seed: UInt64) -> [Piece] {
    switch job {
    case .pad(let p): return renderPad(p, seed: seed)
    case .pulse(let p): return renderPulse(p)
    case .tick(let k): return renderTick(k, seed: seed)
    case .riser(let z): return renderRiser(z, seed: seed)
    case .impact(let z): return renderImpact(z, seed: seed)
    case .haptic(let t, let db): return renderHaptic(t, gainDb: db, seed: seed)
    case .chime(let c): return renderChime(c)
    case .room(let z): return renderRoom(z, seed: seed)
    case .tap(let t, let db, let pan): return renderTap(t, gainDb: db, pan: pan, seed: seed)
    case .confirm(let t, let db): return renderConfirm(t, gainDb: db, seed: seed)
    case .air(let z): return renderAir(z, seed: seed)
    }
}

// MARK: - Reverb: an 8-line feedback delay network with input diffusion

func reverb(_ inL: [Float], _ inR: [Float], rt60: Double, preDelay: Double) -> ([Float], [Float]) {
    let n = inL.count
    var outL = [Float](repeating: 0, count: n), outR = [Float](repeating: 0, count: n)
    // Input diffusion: four allpasses per side.
    func diffuse(_ x: [Float], _ lens: [Int]) -> [Float] {
        var y = x
        for len in lens {
            var buf = [Double](repeating: 0, count: len)
            var idx = 0
            let g = 0.62
            for i in 0..<n {
                let d = buf[idx]
                let v = Double(y[i]) + g * d
                let o = d - g * v
                buf[idx] = v
                idx += 1; if idx == len { idx = 0 }
                y[i] = Float(o)
            }
        }
        return y
    }
    let dl = diffuse(inL, [185, 139, 491, 359])
    let dr = diffuse(inR, [207, 157, 523, 383])
    let lens = [1433, 1601, 1867, 2053, 2251, 2399, 2617, 2833].map { Int(Double($0) * 1.3) }
    let gains = lens.map { pow(10.0, -3.0 * Double($0) / (rt60 * SR)) }
    let damp = exp(-TWO_PI * 6500 / SR)
    var lines = lens.map { [Double](repeating: 0, count: $0) }
    var pos = [Int](repeating: 0, count: 8)
    var lpState = [Double](repeating: 0, count: 8)
    let pre = smp(preDelay)
    var o = [Double](repeating: 0, count: 8)
    let signs: [Double] = [1, -1, 1, -1, -1, 1, -1, 1]
    for i in 0..<n {
        let j = i - pre
        let xl = j >= 0 ? Double(dl[j]) : 0
        let xr = j >= 0 ? Double(dr[j]) : 0
        var sum = 0.0
        for k in 0..<8 {
            var v = lines[k][pos[k]] * gains[k]
            lpState[k] = (1 - damp) * v + damp * lpState[k]
            v = lpState[k]
            o[k] = v
            sum += v
        }
        let s = sum * (2.0 / 8.0)
        for k in 0..<8 {
            let inj = (k % 2 == 0 ? xl : xr) * signs[k] * 0.35
            lines[k][pos[k]] = (o[k] - s) + inj
            pos[k] += 1; if pos[k] == lens[k] { pos[k] = 0 }
        }
        outL[i] = Float((o[0] - o[2] + o[4] - o[6]) * 0.5)
        outR[i] = Float((o[1] - o[3] + o[5] - o[7]) * 0.5)
    }
    // Keep the wet warm and out of the low end.
    var hl = Biquad.highpass(140, 0.7), hr = Biquad.highpass(140, 0.7)
    var ll = Biquad.lowpass(11_000, 0.7), lr = Biquad.lowpass(11_000, 0.7)
    for i in 0..<n {
        outL[i] = Float(ll.run(hl.run(Double(outL[i]))))
        outR[i] = Float(lr.run(hr.run(Double(outR[i]))))
    }
    return (outL, outR)
}

// MARK: - Master bus helpers

func secondRMSdB(_ l: [Float], _ r: [Float]) -> [Double] {
    let per = Int(SR)
    return (0..<Int(DURATION)).map { s in
        var acc = 0.0
        for i in (s * per)..<((s + 1) * per) { acc += Double(l[i]) * Double(l[i]) + Double(r[i]) * Double(r[i]) }
        let ms = acc / Double(2 * per)
        return ms > 0 ? 10 * log10(ms) : -200
    }
}

/// Look-ahead peak limiter: never lets a sample past `ceiling`; smooth attack (look-ahead), slow release.
func limit(_ l: inout [Float], _ r: inout [Float], ceiling: Double) -> Double {
    let n = l.count
    let look = smp(0.005)
    var hold = [Double](repeating: 1, count: n)
    for i in 0..<n {
        let p = max(abs(Double(l[i])), abs(Double(r[i])))
        if p > ceiling {
            let g = ceiling / p
            for k in max(0, i - look)...i where g < hold[k] { hold[k] = g }
        }
    }
    let rel = exp(-1.0 / (0.15 * SR))
    var env = 1.0
    for i in 0..<n {
        env = hold[i] < env ? hold[i] : hold[i] + (env - hold[i]) * rel
        hold[i] = env
    }
    var minGain = 1.0
    var acc = 0.0
    var window = [Double](repeating: 1, count: look)
    for i in 0..<look { acc += 1; window[i] = 1 }
    var wi = 0
    for i in 0..<n {
        acc += hold[i] - window[wi]
        window[wi] = hold[i]
        wi += 1; if wi == look { wi = 0 }
        let g = min(1.0, acc / Double(look))
        minGain = min(minGain, g)
        l[i] = Float(Double(l[i]) * g); r[i] = Float(Double(r[i]) * g)
    }
    return 20 * log10(minGain)
}

func writeWav24(_ url: URL, _ l: [Float], _ r: [Float]) throws {
    let frames = l.count
    let dataBytes = frames * 2 * 3
    var d = Data(capacity: 44 + dataBytes)
    func u32(_ v: UInt32) { var x = v.littleEndian; withUnsafeBytes(of: &x) { d.append(contentsOf: $0) } }
    func u16(_ v: UInt16) { var x = v.littleEndian; withUnsafeBytes(of: &x) { d.append(contentsOf: $0) } }
    d.append(contentsOf: Array("RIFF".utf8)); u32(UInt32(36 + dataBytes)); d.append(contentsOf: Array("WAVE".utf8))
    d.append(contentsOf: Array("fmt ".utf8)); u32(16); u16(1); u16(2); u32(UInt32(SR)); u32(UInt32(SR) * 6); u16(6); u16(24)
    d.append(contentsOf: Array("data".utf8)); u32(UInt32(dataBytes))
    var bytes = [UInt8](repeating: 0, count: dataBytes)
    var b = 0
    @inline(__always) func put(_ v: Float) {
        let q = Int32(max(-8_388_608, min(8_388_607, (Double(v) * 8_388_608).rounded())))
        let u = UInt32(bitPattern: q)
        bytes[b] = UInt8(u & 0xFF); bytes[b + 1] = UInt8((u >> 8) & 0xFF); bytes[b + 2] = UInt8((u >> 16) & 0xFF)
        b += 3
    }
    for i in 0..<frames { put(l[i]); put(r[i]) }
    d.append(contentsOf: bytes)
    try d.write(to: url)
}

// MARK: - Main

let started = Date()
let outPath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "submission/film/audio/score.wav"
let outURL = URL(fileURLWithPath: outPath)

let (scoreJobs, scoreCues) = buildScore()
var jobs: [Job] = scoreJobs
for p in allPulses { jobs.append(.pulse(p)) }
_ = duckBuf.count + hapticDuck.count   // build the ducks before the threads read them

var results = [[Piece]](repeating: [], count: jobs.count)
results.withUnsafeMutableBufferPointer { buf in
    let basePtr = buf.baseAddress!
    DispatchQueue.concurrentPerform(iterations: jobs.count) { i in
        (basePtr + i).pointee = render(jobs[i], seed: UInt64(i) &* 7919 &+ 17)
    }
}
let renderSeconds = Date().timeIntervalSince(started)

// Two buses: the music, and the sound effects on top of it (haptics, taps, the approval). The music
// dips under each wrist cue and goes almost silent for half a second before the lift at 128.
var dryL = [Float](repeating: 0, count: N), dryR = [Float](repeating: 0, count: N)
var sendL = [Float](repeating: 0, count: N), sendR = [Float](repeating: 0, count: N)
var fxL = [Float](repeating: 0, count: N), fxR = [Float](repeating: 0, count: N)
var fxSendL = [Float](repeating: 0, count: N), fxSendR = [Float](repeating: 0, count: N)
for pieces in results {
    for p in pieces {
        let count = min(p.l.count, N - p.start)
        if count <= 0 || p.start < 0 { continue }
        for i in 0..<count {
            let x = p.start + i
            if p.fx {
                fxL[x] += p.l[i] * p.dry; fxR[x] += p.r[i] * p.dry
                fxSendL[x] += p.l[i] * p.send; fxSendR[x] += p.r[i] * p.send
            } else {
                dryL[x] += p.l[i] * p.dry; dryR[x] += p.r[i] * p.dry
                sendL[x] += p.l[i] * p.send; sendR[x] += p.r[i] * p.send
            }
        }
    }
}
results = []

let busDuck: [Float] = {
    var d = [Float](repeating: 1, count: N)
    func dip(_ t: Double, _ depthDb: Double, hold: Double, attack: Double, release: Double) {
        let g = dbToGain(depthDb)
        let a = smp(t - attack), b = smp(t + hold + release * 4)
        for i in max(0, a)..<min(N, b) {
            let x = Double(i) / SR
            var k: Double
            if x < t { k = (x - (t - attack)) / attack }
            else if x < t + hold { k = 1 }
            else { k = exp(-(x - t - hold) / release) }
            k = max(0, min(1, k))
            let v = Float(1 - (1 - g) * k)
            if v < d[i] { d[i] = v }
        }
    }
    // A breath just before each buzz, so it lands on a gap.
    for (t, depth, a) in [(13.5, -7.0, 0.08), (21.0, -9.0, 0.08), (65.0, -10.0, 0.16)] { dip(t, depth, hold: 0.32, attack: a, release: 0.12) }
    for t in [96 + 2 * NODE + 0.05, 96 + 5 * NODE + 0.05] { dip(t, -4, hold: 0.25, attack: 0.03, release: 0.1) }
    // Half a second of near silence before "It already works." (the riser is cut at 127.41).
    for i in smp(127.42)..<smp(128.0) {
        let x = Double(i) / SR
        let k = min(1, (x - 127.42) / 0.05)
        d[i] = min(d[i], Float(1 - (1 - dbToGain(-34)) * k))
    }
    return d
}()

let (wetL, wetR) = reverb(sendL, sendR, rt60: 4.2, preDelay: 0.022)
sendL = []; sendR = []
let (fxWetL, fxWetR) = reverb(fxSendL, fxSendR, rt60: 2.2, preDelay: 0.012)
fxSendL = []; fxSendR = []

// Mix: the reverb a little wider than the dry sound (its sides lifted), the music ducked under the cues,
// the effects on top. Then high-pass at 25 Hz and a gentle roll-off above 16 kHz.
var mixL = [Float](repeating: 0, count: N), mixR = [Float](repeating: 0, count: N)
var sfxL = [Float](repeating: 0, count: N), sfxR = [Float](repeating: 0, count: N)
do {
    let wet = 0.55
    var hpL = Biquad.highpass(25, 0.707), hpR = Biquad.highpass(25, 0.707)
    var lpL = Biquad.lowpass(16_000, 0.707), lpR = Biquad.lowpass(16_000, 0.707)
    var fhL = Biquad.highpass(25, 0.707), fhR = Biquad.highpass(25, 0.707)
    // Master EQ for laptop speakers: less of the sub they cannot play, more presence and air.
    var e1L = Biquad.lowShelf(90, -3), e1R = Biquad.lowShelf(90, -3)
    var e2L = Biquad.peaking(2500, 0.8, 2.5), e2R = Biquad.peaking(2500, 0.8, 2.5)
    var e3L = Biquad.highShelf(6000, 4), e3R = Biquad.highShelf(6000, 4)
    for i in 0..<N {
        let wm = 0.5 * (Double(wetL[i]) + Double(wetR[i])), ws = 0.5 * (Double(wetL[i]) - Double(wetR[i])) * 1.7
        let d = Double(busDuck[i])
        let l = (Double(dryL[i]) + wet * (wm + ws)) * d
        let r = (Double(dryR[i]) + wet * (wm - ws)) * d
        mixL[i] = Float(e3L.run(e2L.run(e1L.run(lpL.run(hpL.run(l))))))
        mixR[i] = Float(e3R.run(e2R.run(e1R.run(lpR.run(hpR.run(r))))))
        sfxL[i] = Float(fhL.run(Double(fxL[i]) + 0.5 * Double(fxWetL[i])))
        sfxR[i] = Float(fhR.run(Double(fxR[i]) + 0.5 * Double(fxWetR[i])))
    }
}
fxL = []; fxR = []

// MARK: - Mastering: glue compression, the edges, then loudness to -14 LUFS under a true-peak ceiling.

/// The music bus compressor, both channels linked, after the loudness gain: a 10 ms RMS detector, soft
/// knee, 2.5:1 above -10 dBFS. It only takes the tops off the hits, so the limiter has less to do and
/// everything else keeps its place. (The effects bus is not compressed: the cues stay crisp.)
func compress(_ l: inout [Float], _ r: inout [Float]) -> Double {
    let thr = -10.0, ratio = 2.5, knee = 6.0
    let atk = exp(-1.0 / (0.004 * SR)), rel = exp(-1.0 / (0.15 * SR)), det = exp(-1.0 / (0.01 * SR))
    var ms = 0.0, gr = 0.0, most = 0.0
    for i in 0..<l.count {
        let x = max(Double(l[i]) * Double(l[i]), Double(r[i]) * Double(r[i]))
        ms = det * ms + (1 - det) * x
        let lv = 10 * log10(ms + 1e-20)
        var over = lv - thr
        if over < -knee / 2 { over = 0 } else if over < knee / 2 { over = (over + knee / 2) * (over + knee / 2) / (2 * knee) }
        let want = over * (1 - 1 / ratio)
        gr = want > gr ? atk * gr + (1 - atk) * want : rel * gr + (1 - rel) * want
        most = max(most, gr)
        let g = Float(dbToGain(-gr))
        l[i] *= g; r[i] *= g
    }
    return most
}

/// Integrated loudness, ITU-R BS.1770-4 (K-weighting, 400 ms blocks every 100 ms, absolute and relative gates).
func integratedLUFS(_ l: [Float], _ r: [Float]) -> Double {
    func kweight(_ x: [Float]) -> [Double] {
        var out = [Double](repeating: 0, count: x.count)
        let b1 = [1.53512485958697, -2.69169618940638, 1.19839281085285], a1 = [-1.69065929318241, 0.73248077421585]
        let b2 = [1.0, -2.0, 1.0], a2 = [-1.99004745483398, 0.99007225036621]
        var z1 = 0.0, z2 = 0.0, w1 = 0.0, w2 = 0.0
        for i in 0..<x.count {
            let v = Double(x[i])
            let y = b1[0] * v + z1
            z1 = b1[1] * v - a1[0] * y + z2; z2 = b1[2] * v - a1[1] * y
            let u = b2[0] * y + w1
            w1 = b2[1] * y - a2[0] * u + w2; w2 = b2[2] * y - a2[1] * u
            out[i] = u
        }
        return out
    }
    let kl = kweight(l), kr = kweight(r)
    let block = smp(0.4), hop = smp(0.1)
    var blocks: [Double] = []
    var i = 0
    while i + block <= kl.count {
        var acc = 0.0
        for j in i..<(i + block) { acc += kl[j] * kl[j] + kr[j] * kr[j] }
        blocks.append(acc / Double(block))
        i += hop
    }
    func lufs(_ ms: Double) -> Double { -0.691 + 10 * log10(ms + 1e-20) }
    let abs = blocks.filter { lufs($0) > -70 }
    let mean0 = abs.reduce(0, +) / Double(max(1, abs.count))
    let rel = abs.filter { lufs($0) > lufs(mean0) - 10 }
    return lufs(rel.reduce(0, +) / Double(max(1, rel.count)))
}

/// The peak between samples too: 4x oversampling with a windowed-sinc interpolator.
func truePeakEnvelope(_ l: [Float], _ r: [Float]) -> [Double] {
    let taps = 12
    var kernels: [[Double]] = []
    for phase in 1..<4 {
        let frac = Double(phase) / 4
        var k: [Double] = []
        for j in -taps + 1...taps {
            let t = Double(j) - frac
            let sinc = t == 0 ? 1 : sin(Double.pi * t) / (Double.pi * t)
            k.append(sinc * (0.5 + 0.5 * cos(Double.pi * t / Double(taps))))
        }
        kernels.append(k)
    }
    let n = l.count
    var env = [Double](repeating: 0, count: n)
    for ch in 0..<2 {
        let x = ch == 0 ? l : r
        for i in 0..<n {
            var p = abs(Double(x[i]))
            if i >= taps && i + taps < n && p > 0.3 {
                for k in kernels {
                    var acc = 0.0
                    for (m, c) in k.enumerated() { acc += c * Double(x[i + m - taps + 1]) }
                    p = max(p, abs(acc))
                }
            }
            env[i] = max(env[i], p)
        }
    }
    return env
}

var limiterAt = 0.0

/// Look-ahead limiter on a peak envelope: never lets the (true) peak past `ceiling`.
func limitTP(_ l: inout [Float], _ r: inout [Float], ceiling: Double) -> Double {
    let n = l.count
    let env = truePeakEnvelope(l, r)
    let look = smp(0.005)
    var hold = [Double](repeating: 1, count: n)
    for i in 0..<n where env[i] > ceiling {
        let g = ceiling / env[i]
        for k in max(0, i - look)...min(n - 1, i + 1) where g < hold[k] { hold[k] = g }
    }
    let rel = exp(-1.0 / (0.08 * SR))
    var e = 1.0
    for i in 0..<n {
        e = hold[i] < e ? hold[i] : hold[i] + (e - hold[i]) * rel
        hold[i] = e
    }
    var minGain = 1.0, acc = 0.0, wi = 0, minAt = 0
    var window = [Double](repeating: 1, count: look)
    acc = Double(look)
    for i in 0..<n {
        acc += hold[i] - window[wi]
        window[wi] = hold[i]
        wi += 1; if wi == look { wi = 0 }
        // The window's mean: every value in it is at or under what this sample needs (the look-ahead), so the
        // mean is too, and it moves smoothly.
        let g = min(acc / Double(look), 1.0)
        if g < minGain { minGain = g; minAt = i }
        l[i] = Float(Double(l[i]) * g); r[i] = Float(Double(r[i]) * g)
    }
    limiterAt = Double(minAt) / SR
    return 20 * log10(minGain)
}

// The edges: a 20 ms fade from true zero at the start, the master fade from 155.5, silence from 159.0.
for i in 0..<N {
    let t = Double(i) / SR
    var g = 1.0
    if t < 0.02 { g = t / 0.02 }
    if t >= 155.5 { g = t >= 159.0 ? 0 : 0.5 + 0.5 * cos(Double.pi * (t - 155.5) / 3.5) }
    if g != 1 {
        mixL[i] = Float(Double(mixL[i]) * g); mixR[i] = Float(Double(mixR[i]) * g)
        sfxL[i] = Float(Double(sfxL[i]) * g); sfxR[i] = Float(Double(sfxR[i]) * g)
    }
}

// Loudness: -14 LUFS integrated (what YouTube and Vimeo play at), true peak at or under -1.5 dBTP
// (AAC adds a little), found by a few rounds of gain and limiting.
let targetLUFS = -14.0
let ceilingDb = -1.5
var gainDb = targetLUFS - integratedLUFS(zip(mixL, sfxL).map { $0 + $1 }, zip(mixR, sfxR).map { $0 + $1 })
var outL = mixL, outR = mixR
var maxReduction = 0.0
var measured = 0.0
var glue = 0.0
for round in 0..<6 {
    outL = mixL; outR = mixR
    let g = Float(dbToGain(gainDb))
    for i in 0..<N { outL[i] *= g; outR[i] *= g }
    glue = compress(&outL, &outR)
    for i in 0..<N { outL[i] += sfxL[i] * g; outR[i] += sfxR[i] * g }
    maxReduction = limitTP(&outL, &outR, ceiling: dbToGain(ceilingDb))
    measured = integratedLUFS(outL, outR)
    print(String(format: "score: loudness round %d: gain %+.2f dB, limiter at most %.2f dB (at %.2f s), %.2f LUFS", round + 1, gainDb, maxReduction, limiterAt, measured))
    if abs(measured - targetLUFS) < 0.05 { break }
    gainDb += targetLUFS - measured
}
mixL = outL; mixR = outR
outL = []; outR = []
var peak = 0.0
var sumL = 0.0, sumR = 0.0
for i in 0..<N {
    peak = max(peak, abs(Double(mixL[i])), abs(Double(mixR[i])))
    sumL += Double(mixL[i]); sumR += Double(mixR[i])
}
let after = secondRMSdB(mixL, mixR)

try FileManager.default.createDirectory(at: outURL.deletingLastPathComponent(), withIntermediateDirectories: true)
try writeWav24(outURL, mixL, mixR)
let cuesURL = outURL.deletingPathExtension().appendingPathExtension("cues.json")
let enc = JSONEncoder(); enc.outputFormatting = [.prettyPrinted, .sortedKeys]
try enc.encode(scoreCues.sorted { $0.t < $1.t }).write(to: cuesURL)

print("score: \(jobs.count) sounds rendered in \(String(format: "%.1f", renderSeconds)) s, total \(String(format: "%.1f", Date().timeIntervalSince(started))) s")
print("score: wrote \(outURL.path) (160.000 s, 48 kHz, stereo, 24-bit)")
print("score: wrote \(cuesURL.path)")
let tpOut = truePeakEnvelope(mixL, mixR).max()!
print(String(format: "score: %.2f LUFS integrated (target %.1f); sample peak %.2f dBFS, true peak %.2f dBTP (ceiling %.1f); glue compression at most %.1f dB, limiter at most %.2f dB", measured, targetLUFS, 20 * log10(peak), 20 * log10(tpOut), ceilingDb, glue, maxReduction))
print(String(format: "score: loudest second %.2f dBFS RMS; DC L %.2e R %.2e", after.max()!, sumL / Double(N), sumR / Double(N)))
