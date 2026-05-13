/**
 * Counter-Plantation — Organic Liquid Transition + Botanical Photogram Atmosphere
 *
 * Sequence: DSC_4134 → Forest_Floor_Aug → Forest_Floor_Aug_2b → loop
 *
 * Pipeline (each frame):
 *   Pass 0  — Sobel      : edge detection, once per texture at load
 *   Pass 1  — Flow       : animated curl noise → velocity RT
 *   Pass 2  — Warp       : patch-based liquify, staggered exits, chromatic split
 *   Pass 3  — Ghost      : persistence trails (ping-pong)
 *   Pass 4  — Glow       : 16-sample radial spiral bloom + Sobel edge amplification
 *   Pass 5a — HBlur      : horizontal Gaussian (sigma 8 px)
 *   Pass 5b — Diffuse    : vertical Gaussian + frosted glass + vignette + additive glow
 *   Pass 6  — Grade      : hue shift + S-curve + black lift + color cast + film grain
 *
 * Keys: 1 / 2 / 3 → switch atmosphere mode live
 */

'use strict';

// ─── Configuration ───────────────────────────────────────────────────────────

const IMAGES = [
  'data/DSC_4134_2.jpg',
  'data/DSC_4134.JPG',
  'data/Forest_Floor_Aug.jpg',
  'data/Forest_Floor_Aug_2.jpg',
  'data/Forest_Floor_Aug_2b.jpg',
];

const TRANSITION_DURATION  = 26.0;
const HOLD_DURATION        = 4.0;
const FLOW_RES             = 512;
const EDGE_RES             = 512;
const WARP_STRENGTH        = 0.08;
const CHROMA_SEP           = 0.007;
const GHOST_DECAY_ACTIVE   = 0.96;
const GHOST_DECAY_HOLD     = 0.88;

const GLOW_INTENSITY     = 0.15;   // Lowered from 0.4/0.5
const DIFFUSION_STRENGTH = 0.32;   // Slightly less diffusion
const HUE_SHIFT          = 0.01;   // Subtle, or 0.0 for neutral
const INITIAL_MODE         = 0;    // 0 = deep teal, 1 = milky green, 2 = dark photogram

// ─── Renderer / Scene ────────────────────────────────────────────────────────

const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(1);
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const scene  = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const quad   = new THREE.Mesh(new THREE.PlaneBufferGeometry(2, 2));
scene.add(quad);

// ─── Render-target factory ───────────────────────────────────────────────────

function makeRT(w, h) {
  return new THREE.WebGLRenderTarget(w, h, {
    minFilter:       THREE.LinearFilter,
    magFilter:       THREE.LinearFilter,
    format:          THREE.RGBAFormat,
    type:            THREE.HalfFloatType,
    depthBuffer:     false,
    stencilBuffer:   false,
    generateMipmaps: false,
  });
}

// ─── GLSL ────────────────────────────────────────────────────────────────────

const VERT = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// ── Pass 0: Sobel edge detection — once per texture at load ──────────────────

const SOBEL_FRAG = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uTex;
  uniform vec2      uTexelSize;
  float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
  void main() {
    float tl = luma(texture2D(uTex, vUv + vec2(-uTexelSize.x,  uTexelSize.y)).rgb);
    float tc = luma(texture2D(uTex, vUv + vec2( 0.0,           uTexelSize.y)).rgb);
    float tr = luma(texture2D(uTex, vUv + vec2( uTexelSize.x,  uTexelSize.y)).rgb);
    float ml = luma(texture2D(uTex, vUv + vec2(-uTexelSize.x,  0.0         )).rgb);
    float mr = luma(texture2D(uTex, vUv + vec2( uTexelSize.x,  0.0         )).rgb);
    float bl = luma(texture2D(uTex, vUv + vec2(-uTexelSize.x, -uTexelSize.y)).rgb);
    float bc = luma(texture2D(uTex, vUv + vec2( 0.0,          -uTexelSize.y)).rgb);
    float br = luma(texture2D(uTex, vUv + vec2( uTexelSize.x, -uTexelSize.y)).rgb);
    float gx = -tl - 2.0*ml - bl + tr + 2.0*mr + br;
    float gy = -tl - 2.0*tc - tr + bl + 2.0*bc + br;
    float e  = clamp(sqrt(gx*gx + gy*gy) * 3.0, 0.0, 1.0);
    gl_FragColor = vec4(e, e, e, 1.0);
  }
`;

// ── Pass 1: Flow field — animated curl noise ──────────────────────────────────

const FLOW_FRAG = `
  precision highp float;
  varying vec2 vUv;
  uniform float u_time;

  vec3 mod289_3(vec3 x) { return x - floor(x * (1.0/289.0)) * 289.0; }
  vec2 mod289_2(vec2 x) { return x - floor(x * (1.0/289.0)) * 289.0; }
  vec3 permute3(vec3 x) { return mod289_3(((x*34.0)+1.0)*x); }
  float snoise(vec2 v) {
    const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                       -0.577350269189626, 0.024390243902439);
    vec2 i  = floor(v + dot(v, C.yy));
    vec2 x0 = v - i + dot(i, C.xx);
    vec2 i1  = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy  -= i1;
    i = mod289_2(i);
    vec3 p = permute3(permute3(i.y + vec3(0.0, i1.y, 1.0))
                              + i.x + vec3(0.0, i1.x, 1.0));
    vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
    m = m*m*m*m;
    vec3 x  = 2.0 * fract(p * C.www) - 1.0;
    vec3 h  = abs(x) - 0.5;
    vec3 ox = floor(x + 0.5);
    vec3 a0 = x - ox;
    m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
    vec3 g;
    g.x  = a0.x  * x0.x  + h.x  * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    return 130.0 * dot(m, g);
  }
  vec2 curl(vec2 p) {
    const float eps = 0.003;
    float n1 = snoise(p + vec2(0.0,  eps));
    float n2 = snoise(p - vec2(0.0,  eps));
    float n3 = snoise(p + vec2(eps,  0.0));
    float n4 = snoise(p - vec2(eps,  0.0));
    return vec2((n1 - n2) / (2.0 * eps), -(n3 - n4) / (2.0 * eps));
  }
  void main() {
    vec2 p = vUv * 2.3;
    vec2 f1   = curl(p * 1.0  + u_time * 0.025);
    vec2 f2   = curl(p * 2.71 + u_time * 0.012 + vec2(4.27, 7.13));
    vec2 f3   = curl(p * 5.83 + u_time * 0.007 + vec2(1.91, 3.57));
    vec2 flow = f1 * 0.55 + f2 * 0.30 + f3 * 0.15;
    float upBias = 0.08 * smoothstep(0.3, 0.7, 1.0 - abs(vUv.y - 0.5) * 2.0);
    flow.y += upBias;
    gl_FragColor = vec4(clamp(flow * 0.5 + 0.5, 0.0, 1.0), 0.0, 1.0);
  }
`;

// ── Pass 2: Patch-based warp — staggered entry AND staggered random exit ───────

const WARP_FRAG = `
  precision highp float;
  varying vec2 vUv;

  uniform sampler2D u_texA;
  uniform sampler2D u_texB;
  uniform sampler2D u_edgeA;
  uniform sampler2D u_flow;
  uniform float     u_progress;
  uniform float     u_warpStrength;
  uniform float     u_chromaSep;
  uniform vec2      u_seed;
  uniform float     u_ambientStr;

  const float PI = 3.14159265358979;

  vec3 _m3(vec3 x) { return x - floor(x*(1.0/289.0))*289.0; }
  vec2 _m2(vec2 x) { return x - floor(x*(1.0/289.0))*289.0; }
  vec3 _p3(vec3 x) { return _m3(((x*34.0)+1.0)*x); }
  float snoise2(vec2 v) {
    const vec4 C = vec4(0.211324865405187,0.366025403784439,-0.577350269189626,0.024390243902439);
    vec2 i  = floor(v + dot(v, C.yy));
    vec2 x0 = v - i + dot(i, C.xx);
    vec2 i1 = (x0.x > x0.y) ? vec2(1.0,0.0) : vec2(0.0,1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = _m2(i);
    vec3 p = _p3(_p3(i.y + vec3(0.0,i1.y,1.0)) + i.x + vec3(0.0,i1.x,1.0));
    vec3 m = max(0.5 - vec3(dot(x0,x0),dot(x12.xy,x12.xy),dot(x12.zw,x12.zw)), 0.0);
    m = m*m*m*m;
    vec3 x  = 2.0*fract(p*C.www) - 1.0;
    vec3 h  = abs(x) - 0.5;
    vec3 a0 = x - floor(x + 0.5);
    m *= 1.79284291400159 - 0.85373472095314*(a0*a0 + h*h);
    vec3 g;
    g.x  = a0.x *x0.x  + h.x *x0.y;
    g.yz = a0.yz*x12.xz + h.yz*x12.yw;
    return 130.0*dot(m, g);
  }

  void main() {
    float n1 = snoise2(vUv * 2.2 + u_seed);
    float n2 = snoise2(vUv * 5.1 + u_seed * 0.7 + vec2(8.1, 1.7));
    float patchNoise  = n1 * 0.7 + n2 * 0.3;
    float patchThresh = patchNoise * 0.5 + 0.5;
    float localP = clamp((u_progress - patchThresh * 0.65) / 0.35, 0.0, 1.0);

    float n3        = snoise2(vUv * 3.3 + u_seed * 1.5 + vec2(2.9, 6.1));
    float exitNoise  = n3 * 0.5 + 0.5;
    float exitT      = 0.25 + exitNoise * 0.75;
    float endBlend   = smoothstep(exitT - 0.05, exitT + 0.05, u_progress);

    vec2  flow    = texture2D(u_flow, vUv).rg * 2.0 - 1.0;
    float edge    = texture2D(u_edgeA, vUv).r;
    float edgeAmp = 1.0 + edge * 1.2;

    float env     = sin(localP * PI);
    float warpMag = u_warpStrength * env * edgeAmp;
    float chroma  = u_chromaSep * env;

    float flowLen = length(flow);
    vec2  flowDir = flowLen > 0.001 ? flow / flowLen : vec2(0.0, 1.0);
    vec2  ambient = flow * u_ambientStr;

    vec2 uvR = vUv + ambient + flow * warpMag + flowDir * chroma;
    vec2 uvG = vUv + ambient + flow * warpMag;
    vec2 uvB = vUv + ambient + flow * warpMag - flowDir * chroma;

    float aR = texture2D(u_texA, uvR).r;
    float aG = texture2D(u_texA, uvG).g;
    float aB = texture2D(u_texA, uvB).b;
    float bR = texture2D(u_texB, uvR).r;
    float bG = texture2D(u_texB, uvG).g;
    float bB = texture2D(u_texB, uvB).b;

    vec3 col = mix(vec3(aR, aG, aB), vec3(bR, bG, bB), endBlend);
    gl_FragColor = vec4(col, 1.0);
  }
`;

// ── Pass 3: Ghost persistence ─────────────────────────────────────────────────

const GHOST_FRAG = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D u_current;
  uniform sampler2D u_prev;
  uniform float     u_decay;
  void main() {
    vec4 curr = texture2D(u_current, vUv);
    vec4 prev = texture2D(u_prev,    vUv);
    gl_FragColor = mix(curr, prev, u_decay);
  }
`;

// ── Pass 4: Glow extraction + Sobel edge halo ─────────────────────────────────

const GLOW_FRAG = `
  precision highp float;
  varying vec2 vUv;

  uniform sampler2D u_src;
  uniform vec2      u_resolution;
  uniform float     u_aspect;
  uniform float     u_mode;

  float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

  float sobelEdge() {
    vec2 t = 1.0 / u_resolution;
    float tl = luma(texture2D(u_src, vUv + vec2(-t.x,  t.y)).rgb);
    float tc = luma(texture2D(u_src, vUv + vec2( 0.0,  t.y)).rgb);
    float tr = luma(texture2D(u_src, vUv + vec2( t.x,  t.y)).rgb);
    float ml = luma(texture2D(u_src, vUv + vec2(-t.x,  0.0)).rgb);
    float mr = luma(texture2D(u_src, vUv + vec2( t.x,  0.0)).rgb);
    float bl = luma(texture2D(u_src, vUv + vec2(-t.x, -t.y)).rgb);
    float bc = luma(texture2D(u_src, vUv + vec2( 0.0, -t.y)).rgb);
    float br = luma(texture2D(u_src, vUv + vec2( t.x, -t.y)).rgb);
    float gx = -tl - 2.0*ml - bl + tr + 2.0*mr + br;
    float gy = -tl - 2.0*tc - tr + bl + 2.0*bc + br;
    return clamp(sqrt(gx*gx + gy*gy) * 3.0, 0.0, 1.0);
  }

  void main() {
    float centerLuma = luma(texture2D(u_src, vUv).rgb);
    float glowAcc   = 0.0;
    float weightSum = 0.001;

    for (int i = 0; i < 16; i++) {
      float t      = float(i) / 15.0;
      float angle  = float(i) * 2.39996323;
      float radius = mix(0.02, 0.08, t);
      vec2  offset = vec2(cos(angle) / u_aspect, sin(angle)) * radius;
      float sLuma  = luma(texture2D(u_src, vUv + offset).rgb);
      float w      = sLuma * (1.0 - t * 0.6) + 0.001;
      glowAcc   += sLuma * w;
      weightSum += w;
    }

    float glow = max(glowAcc / weightSum, centerLuma * 0.30);
    float edgeMult = (u_mode > 1.5) ? 2.0 : 1.2;
    float edge     = sobelEdge();
    glow          *= (1.0 + edge * edgeMult);
    glow           = clamp(glow, 0.0, 1.0);
    gl_FragColor   = vec4(glow, glow, glow, 1.0);
  }
`;

// ── Pass 5a: Horizontal Gaussian blur ────────────────────────────────────────

const HBLUR_FRAG = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D u_src;
  uniform vec2      u_resolution;
  void main() {
    const float sigma = 8.0;
    vec2  texel = 1.0 / u_resolution;
    vec3  acc   = vec3(0.0);
    float wSum  = 0.0;
    for (int i = -16; i <= 16; i++) {
      float x = float(i);
      float w = exp(-0.5 * (x * x) / (sigma * sigma));
      acc  += texture2D(u_src, vUv + vec2(x * texel.x, 0.0)).rgb * w;
      wSum += w;
    }
    gl_FragColor = vec4(acc / wSum, 1.0);
  }
`;

// ── Pass 5b: Vertical blur + diffusion + vignette + additive glow ────────────

const DIFFUSE_FRAG = `
  precision highp float;
  varying vec2 vUv;

  uniform sampler2D u_src;
  uniform sampler2D u_hblur;
  uniform sampler2D u_glow;
  uniform vec2      u_resolution;
  uniform float     u_diffusion;
  uniform float     u_glowInt;
  uniform float     u_mode;

  void main() {
    vec3 original = texture2D(u_src, vUv).rgb;

    const float sigma = 8.0;
    vec2  texel   = 1.0 / u_resolution;
    vec3  blurred = vec3(0.0);
    float wSum    = 0.0;
    for (int i = -16; i <= 16; i++) {
      float y = float(i);
      float w = exp(-0.5 * (y * y) / (sigma * sigma));
      blurred += texture2D(u_hblur, vUv + vec2(0.0, y * texel.y)).rgb * w;
      wSum    += w;
    }
    blurred /= wSum;

    float diff = u_diffusion;
    if (u_mode > 0.5 && u_mode < 1.5) diff = min(diff + 0.25, 1.0);
    if (u_mode > 1.5)                  diff = max(diff - 0.15, 0.0);

    vec3  col  = mix(original, blurred, diff);
    float dist = length(vUv - 0.5) * 1.414;

    if (u_mode > 1.5) {
      float dark = smoothstep(0.25, 0.85, dist) * 0.55;
      col -= dark;
    } else {
      float vigAdd = (1.0 - smoothstep(0.0, 0.7, dist)) * 0.06;
      if (u_mode > 0.5) vigAdd *= 1.6;
      col += vigAdd;
    }

    float gIntensity = u_glowInt;
    if (u_mode < 0.5)                  gIntensity *= 1.3;
    if (u_mode > 0.5 && u_mode < 1.5) gIntensity *= 0.6;
    if (u_mode > 1.5)                  gIntensity *= 1.5;

    float g = texture2D(u_glow, vUv).r;
    col += g * gIntensity;
    gl_FragColor = vec4(col, 1.0);
  }
`;

// ── Pass 6: Tonal grade + film grain + color cast ─────────────────────────────

const GRADE_FRAG = `
  precision highp float;
  varying vec2 vUv;

  uniform sampler2D u_src;
  uniform float     u_time;
  uniform float     u_hueShift;
  uniform float     u_mode;

  vec3 rgb2hsl(vec3 c) {
    float maxC = max(c.r, max(c.g, c.b));
    float minC = min(c.r, min(c.g, c.b));
    float d    = maxC - minC;
    float l    = (maxC + minC) * 0.5;
    float s    = d < 0.001 ? 0.0 : d / (1.0 - abs(2.0 * l - 1.0));
    float h    = 0.0;
    if (d > 0.001) {
      if      (maxC == c.r) h = mod((c.g - c.b) / d, 6.0);
      else if (maxC == c.g) h = (c.b - c.r) / d + 2.0;
      else                  h = (c.r - c.g) / d + 4.0;
      h /= 6.0;
    }
    return vec3(h, s, l);
  }
  vec3 hsl2rgb(vec3 hsl) {
    float h = hsl.x, s = hsl.y, l = hsl.z;
    float C  = (1.0 - abs(2.0 * l - 1.0)) * s;
    float X  = C * (1.0 - abs(mod(h * 6.0, 2.0) - 1.0));
    float m  = l - C * 0.5;
    float hh = h * 6.0;
    vec3 rgb;
    if      (hh < 1.0) rgb = vec3(C, X, 0.0);
    else if (hh < 2.0) rgb = vec3(X, C, 0.0);
    else if (hh < 3.0) rgb = vec3(0.0, C, X);
    else if (hh < 4.0) rgb = vec3(0.0, X, C);
    else if (hh < 5.0) rgb = vec3(X, 0.0, C);
    else               rgb = vec3(C, 0.0, X);
    return clamp(rgb + m, 0.0, 1.0);
  }
  float hash21(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  void main() {
    vec3 col = texture2D(u_src, vUv).rgb;

    if (abs(u_hueShift) > 0.0005) {
      vec3 hsl = rgb2hsl(col);
      hsl.x    = fract(hsl.x + u_hueShift);
      col      = hsl2rgb(hsl);
    }

    vec3 scurve = col * col * (3.0 - 2.0 * col);
    col         = mix(col, scurve, 0.35);
    col        += 0.00;

    if      (u_mode < 0.5) col *= vec3(0.75, 0.90, 0.88);
    else if (u_mode < 1.5) col *= vec3(0.92, 0.98, 0.92);
    else                   col *= vec3(0.88, 0.96, 0.94);  

    float grain = hash21(vUv * 997.3 + fract(u_time * 0.17)) * 2.0 - 1.0;
    col        += grain * 0.04;

    gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
  }
`;

// ─── Material factory ────────────────────────────────────────────────────────

function makeMat(frag, uniforms) {
  return new THREE.ShaderMaterial({
    vertexShader:   VERT,
    fragmentShader: frag,
    uniforms,
    depthTest:  false,
    depthWrite: false,
  });
}

// ─── Materials ───────────────────────────────────────────────────────────────

const screenRes = new THREE.Vector2(window.innerWidth, window.innerHeight);

const matSobel = makeMat(SOBEL_FRAG, {
  uTex:       { value: null },
  uTexelSize: { value: new THREE.Vector2(1.0 / EDGE_RES, 1.0 / EDGE_RES) },
});

const matFlow = makeMat(FLOW_FRAG, {
  u_time: { value: 0.0 },
});

const matWarp = makeMat(WARP_FRAG, {
  u_texA:         { value: null },
  u_texB:         { value: null },
  u_edgeA:        { value: null },
  u_flow:         { value: null },
  u_progress:     { value: 0.0 },
  u_warpStrength: { value: WARP_STRENGTH },
  u_chromaSep:    { value: CHROMA_SEP },
  u_seed:         { value: new THREE.Vector2(0.0, 0.0) },
  u_ambientStr:   { value: 0.002 },
});

const matGhost = makeMat(GHOST_FRAG, {
  u_current: { value: null },
  u_prev:    { value: null },
  u_decay:   { value: GHOST_DECAY_HOLD },
});

const matGlow = makeMat(GLOW_FRAG, {
  u_src:        { value: null },
  u_resolution: { value: screenRes.clone() },
  u_aspect:     { value: window.innerWidth / window.innerHeight },
  u_mode:       { value: parseFloat(INITIAL_MODE) },
});

const matHBlur = makeMat(HBLUR_FRAG, {
  u_src:        { value: null },
  u_resolution: { value: screenRes.clone() },
});

const matDiffuse = makeMat(DIFFUSE_FRAG, {
  u_src:        { value: null },
  u_hblur:      { value: null },
  u_glow:       { value: null },
  u_resolution: { value: screenRes.clone() },
  u_diffusion:  { value: DIFFUSION_STRENGTH },
  u_glowInt:    { value: GLOW_INTENSITY },
  u_mode:       { value: parseFloat(INITIAL_MODE) },
});

const matGrade = makeMat(GRADE_FRAG, {
  u_src:      { value: null },
  u_time:     { value: 0.0 },
  u_hueShift: { value: HUE_SHIFT },
  u_mode:     { value: parseFloat(INITIAL_MODE) },
});

// ─── Render-pass helper ──────────────────────────────────────────────────────

function renderPass(material, target) {
  quad.material = material;
  renderer.setRenderTarget(target);
  renderer.render(scene, camera);
}

// ─── Render targets ──────────────────────────────────────────────────────────

const flowRT = makeRT(FLOW_RES, FLOW_RES);
let   warpRT = makeRT(window.innerWidth, window.innerHeight);
let   ghostRTs   = [makeRT(window.innerWidth, window.innerHeight),
                    makeRT(window.innerWidth, window.innerHeight)];
let   ghostWrite = 0;
let   glowRT  = makeRT(window.innerWidth, window.innerHeight);
let   hblurRT = makeRT(window.innerWidth, window.innerHeight);
let   diffRT  = makeRT(window.innerWidth, window.innerHeight);

// ─── Runtime state ───────────────────────────────────────────────────────────

const textures = [];
const edgeRTs  = [];

let currentIdx      = 0;
let nextIdx         = 1;
let progress        = 0.0;
let isTransitioning = false;
let holdTimer       = 0.0;
let globalTime      = 0.0;
let lastFrameTime   = null;
let animationReady  = false;

// ─── Mode switcher (keys 1/2/3) ──────────────────────────────────────────────

function setMode(m) {
  const mf = parseFloat(m);
  matGlow.uniforms.u_mode.value    = mf;
  matDiffuse.uniforms.u_mode.value = mf;
  matGrade.uniforms.u_mode.value   = mf;
}

window.addEventListener('keydown', (e) => {
  if (e.key === '1') setMode(0);
  if (e.key === '2') setMode(1);
  if (e.key === '3') setMode(2);
});

// ─── Sobel precomputation ─────────────────────────────────────────────────────

function computeEdgeMap(tex) {
  const rt = makeRT(EDGE_RES, EDGE_RES);
  matSobel.uniforms.uTex.value = tex;
  matSobel.uniforms.uTexelSize.value.set(1.0 / EDGE_RES, 1.0 / EDGE_RES);
  renderPass(matSobel, rt);
  return rt;
}

// ─── Texture loading ──────────────────────────────────────────────────────────

function makeFallbackTexture(seed) {
  const size = 256;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v   = ((x >> 5) + (y >> 5) + seed) % 2 === 0 ? 160 : 40;
      const idx = (y * size + x) * 4;
      data[idx]   = v + (seed === 0 ? 30 : 0);
      data[idx+1] = v;
      data[idx+2] = v + (seed === 2 ? 30 : 0);
      data[idx+3] = 255;
    }
  }
  const tex           = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.minFilter       = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate     = true;
  return tex;
}

function loadAllTextures() {
  return new Promise((resolve) => {
    const loader  = new THREE.TextureLoader();
    const result  = new Array(IMAGES.length);
    let numLoaded = 0;
    IMAGES.forEach((path, i) => {
      loader.load(
        path,
        (tex) => {
          tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
          tex.generateMipmaps = false;
          tex.wrapS = THREE.ClampToEdgeWrapping; tex.wrapT = THREE.ClampToEdgeWrapping;
          result[i] = tex;
          if (++numLoaded === IMAGES.length) resolve(result);
        },
        undefined,
        (err) => {
          console.warn('[transition] Could not load', path, err);
          result[i] = makeFallbackTexture(i);
          if (++numLoaded === IMAGES.length) resolve(result);
        }
      );
    });
  });
}

// ─── Transition pair setup ────────────────────────────────────────────────────

function applyTransitionPair(aIdx, bIdx) {
  matWarp.uniforms.u_texA.value  = textures[aIdx];
  matWarp.uniforms.u_texB.value  = textures[bIdx];
  matWarp.uniforms.u_edgeA.value = edgeRTs[aIdx].texture;
  matWarp.uniforms.u_seed.value.set(Math.random() * 100.0, Math.random() * 100.0);
}

// ─── Window resize ────────────────────────────────────────────────────────────

window.addEventListener('resize', () => {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h);

  const newRes = new THREE.Vector2(w, h);
  matGlow.uniforms.u_resolution.value.copy(newRes);
  matGlow.uniforms.u_aspect.value = w / h;
  matHBlur.uniforms.u_resolution.value.copy(newRes);
  matDiffuse.uniforms.u_resolution.value.copy(newRes);

  warpRT.dispose();
  ghostRTs[0].dispose(); ghostRTs[1].dispose();
  glowRT.dispose(); hblurRT.dispose(); diffRT.dispose();

  warpRT   = makeRT(w, h);
  ghostRTs = [makeRT(w, h), makeRT(w, h)];
  ghostWrite = 0;
  glowRT   = makeRT(w, h);
  hblurRT  = makeRT(w, h);
  diffRT   = makeRT(w, h);
});

// ─── Animation loop ───────────────────────────────────────────────────────────

function animate() {
  requestAnimationFrame(animate);
  if (!animationReady) return;

  const now = performance.now();
  const dt  = Math.min((now - lastFrameTime) * 0.001, 0.05);
  lastFrameTime = now;
  globalTime   += dt;

  // Transition state machine
  if (isTransitioning) {
    progress += dt / TRANSITION_DURATION;
    if (progress >= 1.0) {
      progress        = 1.0;
      currentIdx      = nextIdx;
      nextIdx         = (nextIdx + 1) % textures.length;
      isTransitioning = false;
      holdTimer       = 0.0;
      applyTransitionPair(currentIdx, nextIdx);
    }
  } else {
    holdTimer += dt;
    if (holdTimer >= HOLD_DURATION) {
      holdTimer = 0.0; progress = 0.0; isTransitioning = true;
    }
  }

  const p = isTransitioning ? progress : 0.12;

  // Pass 1: flow field
  matFlow.uniforms.u_time.value = globalTime;
  renderPass(matFlow, flowRT);

  // Pass 2: patch warp
  matWarp.uniforms.u_flow.value     = flowRT.texture;
  matWarp.uniforms.u_progress.value = p;
  renderPass(matWarp, warpRT);

  // Pass 3: ghost persistence
  matGhost.uniforms.u_decay.value   = isTransitioning ? GHOST_DECAY_ACTIVE : GHOST_DECAY_HOLD;
  matGhost.uniforms.u_current.value = warpRT.texture;
  matGhost.uniforms.u_prev.value    = ghostRTs[1 - ghostWrite].texture;
  renderPass(matGhost, ghostRTs[ghostWrite]);

  const ghostTex = ghostRTs[ghostWrite].texture;
  ghostWrite = 1 - ghostWrite;

  // Pass 4: glow map (source = ghost output)
  matGlow.uniforms.u_src.value = ghostTex;
  renderPass(matGlow, glowRT);

  // Pass 5a: horizontal Gaussian
  matHBlur.uniforms.u_src.value = ghostTex;
  renderPass(matHBlur, hblurRT);

  // Pass 5b: diffusion + vignette + additive glow
  matDiffuse.uniforms.u_src.value   = ghostTex;
  matDiffuse.uniforms.u_hblur.value = hblurRT.texture;
  matDiffuse.uniforms.u_glow.value  = glowRT.texture;
  renderPass(matDiffuse, diffRT);

  // Pass 6: tonal grade → screen
  matGrade.uniforms.u_src.value  = diffRT.texture;
  matGrade.uniforms.u_time.value = globalTime;
  renderPass(matGrade, null);
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  const loaded = await loadAllTextures();
  loaded.forEach(t => textures.push(t));
  textures.forEach(tex => edgeRTs.push(computeEdgeMap(tex)));
  applyTransitionPair(currentIdx, nextIdx);

  // Prime ghost buffers
  matFlow.uniforms.u_time.value = 0.0;
  renderPass(matFlow, flowRT);
  matWarp.uniforms.u_flow.value     = flowRT.texture;
  matWarp.uniforms.u_progress.value = 0.0;
  renderPass(matWarp, warpRT);
  matGhost.uniforms.u_current.value = warpRT.texture;
  matGhost.uniforms.u_prev.value    = warpRT.texture;
  matGhost.uniforms.u_decay.value   = 0.0;
  renderPass(matGhost, ghostRTs[0]);
  renderPass(matGhost, ghostRTs[1]);

  lastFrameTime  = performance.now();
  animationReady = true;
  animate();
}

init();