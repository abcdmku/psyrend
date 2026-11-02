import type { LookContext } from '../types';

/**
 * Shared pieces of the LSD perceptual looks (lsd*.ts). No default export, so the registry skips it.
 *
 * Every LSD look reads the music only through eased, slow quantities: nothing here follows a kick,
 * a snare or the beat sawtooth, so nothing can snap or pulse.
 *
 * Common params (L.p[0] and L.p[1]):
 *   p0.x  beat clock: continuous beat count, tempo-locked but never stepping
 *   p0.y  flow clock: seconds scaled by energy (slows in quiet, never stops)
 *   p0.z  energy (energySlow, eased over ~1.5 s)
 *   p0.w  fine-detail drive: highs, upper melody and hats, eased over ~0.6 s
 *   p1.x  backing pads (backingHeld, eased over ~1.5 s)
 *   p1.y  phrase position: 8-bar phrase count, eased over ~2 s (a smooth step per phrase)
 *   p1.z  upper melody pitch (eased), 0..1
 *   p1.w  bar length in beats
 * Look-specific params start at p[8] (L.p[2]).
 */
export class Groove {
  private beat = 0;
  private flow = 0;
  private energy = 0.4;
  private detail = 0;
  private backing = 0;
  private phrase = 0;
  private pitch = 0.5;
  private primed = false;

  update(ctx: LookContext, p: Float32Array): void {
    const m = ctx.music;
    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
    const beatPos = m.beatIndex + m.beatPhase;
    const phraseTarget = Math.floor(m.barIndex / 8);
    if (!this.primed || Math.abs(beatPos - this.beat) > 8 || dt === 0) {
      // First frame or a seek: jump, then stay continuous.
      this.beat = beatPos;
      this.phrase = phraseTarget;
      this.energy = m.energySlow;
      this.primed = true;
    } else {
      // Advance at the tempo and pull gently toward the true beat, so the clock never steps.
      this.beat += (dt * m.bpm) / 60;
      this.beat += (beatPos - this.beat) * (1 - Math.exp(-dt / 0.5));
    }
    const ease = (cur: number, target: number, tau: number) => cur + (target - cur) * (1 - Math.exp(-dt / tau));
    this.energy = ease(this.energy, m.energySlow, 1.5);
    const fine = Math.min(1, 0.55 * m.high + 0.35 * m.upperHeld + 0.25 * m.upper + 0.15 * m.hat);
    this.detail = ease(this.detail, fine, 0.6);
    this.backing = ease(this.backing, m.backingHeld, 1.5);
    this.phrase = ease(this.phrase, phraseTarget, 2.0);
    if (m.upperHeld > 0.05) this.pitch = ease(this.pitch, m.upperPitch, 0.8);
    this.flow += dt * (0.35 + 0.9 * this.energy);
    p[0] = this.beat;
    p[1] = this.flow;
    p[2] = this.energy;
    p[3] = this.detail;
    p[4] = this.backing;
    p[5] = this.phrase;
    p[6] = this.pitch;
    p[7] = m.beatsPerBar || 4;
  }
}

/** WGSL helpers shared by the LSD looks. Prepend to each look's own code. */
export const LSD_WGSL = /* wgsl */ `
fn lsd_beat() -> f32 { return L.p[0].x; }
fn lsd_flow() -> f32 { return L.p[0].y; }
fn lsd_energy() -> f32 { return L.p[0].z; }
fn lsd_detail() -> f32 { return L.p[0].w; }
fn lsd_backing() -> f32 { return L.p[1].x; }
fn lsd_phrase() -> f32 { return L.p[1].y; }
fn lsd_pitch() -> f32 { return L.p[1].z; }
/** Bars elapsed (continuous). */
fn lsd_bars() -> f32 { return L.p[0].x / max(L.p[1].w, 1.0); }
/** Aspect-correct centred coordinates (height = 1). */
fn lsd_p(uv: vec2f) -> vec2f { return (uv - 0.5) * vec2f(L.res.x / L.res.y, 1.0); }
fn lsd_uv(p: vec2f) -> vec2f { return p / vec2f(L.res.x / L.res.y, 1.0) + 0.5; }
/** 0 at the frame border, 1 inside: warps fade out there so they never pull in mirrored edges. */
fn lsd_edge(uv: vec2f) -> f32 { let m = min(uv, 1.0 - uv); return smoothstep(0.0, 0.1, min(m.x, m.y)); }

/**
 * A smooth stream function: a few rotated, slowly drifting sine waves. No hash noise, so it never
 * reads as grain. Returns (psi, dpsi/dx, dpsi/dy).
 */
fn lsd_psi(p: vec2f, t: f32, k: f32) -> vec3f {
  var s = vec3f(0.0);
  var a = 1.0;
  var f = k;
  for (var i = 0; i < 4; i++) {
    let fi = f32(i);
    let ang = fi * 2.399 + 0.6 + 0.07 * t * (1.0 + 0.3 * fi);
    let d = vec2f(cos(ang), sin(ang));
    let ph = dot(d, p) * f + t * (0.45 + 0.17 * fi) + fi * 1.7;
    s += vec3f(sin(ph), d * cos(ph) * f) * a;
    a *= 0.55;
    f *= 1.83;
  }
  return s;
}
/** Divergence-free flow (curl of psi): drifts like a slow liquid, no sources or sinks. */
fn lsd_curl(p: vec2f, t: f32, k: f32) -> vec2f {
  let s = lsd_psi(p, t, k);
  return vec2f(s.z, -s.y);
}
/** Rotate hue around the grey axis, preserving luma (Rec.709 weights, small-angle exact). */
fn lsd_hue(c: vec3f, a: f32) -> vec3f {
  let k = vec3f(0.57735);
  let ca = cos(a);
  let r = c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);
  return max(r + (luma(c) - luma(r)), vec3f(0.0));
}
/** Saturation boost that leaves greys and darks alone. */
fn lsd_vivid(c: vec3f, s: f32) -> vec3f {
  let y = luma(c);
  return max(vec3f(y) + (c - vec3f(y)) * s, vec3f(0.0));
}
`;

/**
 * The look pass returns mix(base, look, L.amount). For warps that would cross-fade two images
 * (a ghosted double exposure), so warp looks scale their own strength by L.amount and return
 * this, which makes the final mix land exactly on the warped image.
 */
export const LSD_OUT_WGSL = /* wgsl */ `
fn lsd_out(base: vec3f, res: vec3f) -> vec3f { return base + (res - base) / max(L.amount, 0.05); }
`;
