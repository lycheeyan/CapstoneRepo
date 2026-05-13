// ═══════════════════════════════════════════════════════════════
    //  VERTEX SHADER  —  shared by every pass
    // ═══════════════════════════════════════════════════════════════
    const VERT = /* glsl */`
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position, 1.0);
      }
    `;

    // ═══════════════════════════════════════════════════════════════
    //  PASS 1  —  FEEDBACK DECAY + SHADOW-STROBE EDGE BOOST
    //  Reads:  uTexture (live video), uPrev (fboB — last streak frame)
    //  Writes: fboA
    // ═══════════════════════════════════════════════════════════════
    const FRAG1 = /* glsl */`
      uniform sampler2D uTexture;   // live video frame
      uniform sampler2D uPrev;      // fboB: previous streak-feedback frame
      uniform float     uDecay;     // 0.88
      uniform vec2      uScreenRes;
      uniform vec2      uVideoRes;
      varying vec2 vUv;

      float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

      void main() {
        // ── Cover-fit UV: scale video to fill screen, crop edges ──
        vec2 videoUV = vUv;
        float sa = uScreenRes.x / uScreenRes.y;   // screen aspect
        float va = uVideoRes.x  / uVideoRes.y;    // video aspect

        if (sa > va) {
          // Screen is wider than video — crop top/bottom
          float yscale = va / sa;
          videoUV.y = (vUv.y - 0.5) * yscale + 0.5;
        } else {
          // Screen is taller than video — crop left/right
          float xscale = sa / va;
          videoUV.x = (vUv.x - 0.5) * xscale + 0.5;
        }

        vec4 current = texture2D(uTexture, videoUV);
        vec4 prev    = texture2D(uPrev,    vUv);

        // ── Shadow-strobe: detect trunk-edge transitions ──
        // Where contrast is high (dark trunk sweeping past bright sky),
        // locally boost decay so those edges trail longer than flat zones.
        float edge = abs(luma(current.rgb) - luma(prev.rgb));
        float decayLocal = uDecay;
        if (edge > 0.15) {
          decayLocal = min(uDecay + edge * 0.08, 0.97);
        }

        // ── Feedback blend: video supplies motion, prev supplies trail ──
        // uDecay is kept at 0.88 (not 0.92+) because the video itself
        // already carries rich lateral motion — shorter trails prevent mud.
        vec4 col = current * 0.12 + prev * decayLocal;
        gl_FragColor = clamp(col, 0.0, 1.0);
      }
    `;

    // ═══════════════════════════════════════════════════════════════
    //  PASS 2  —  LATERAL STREAK AMPLIFICATION
    //  Gaussian horizontal kernel, i = -8..8, sigma = 2.5
    //  Reads:  fboA   Writes: fboB  (this IS the persistent feedback buffer)
    // ═══════════════════════════════════════════════════════════════
    const FRAG2 = /* glsl */`
      uniform sampler2D uFeedback;
      uniform float     uTime;      // elapsed seconds — drives blur ramp
      uniform float     uPhase;     // random start offset — decouples blur from video loop
      uniform float     uBoxW;
      uniform float     uBoxH;
      varying vec2 vUv;

      void main() {
        // Box mask: fully clear inside, fully blurred outside
        float boxWf = uBoxW;
        float boxHf = uBoxH;
        vec2 fromCenterF = abs(vUv - vec2(0.5));
        float boxClear  = step(fromCenterF.x, boxWf) * step(fromCenterF.y, boxHf);

        // Subtle background strips — rare, slow fade-in/out
        float bandF   = vUv.x * 10.0;
        float band    = floor(bandF);
        float bandN   = band + 1.0;
        float bBlend  = smoothstep(0.25, 0.75, fract(bandF));
        float sr      = fract(sin(band  * 127.1 + uPhase) * 43758.5453);
        float srN     = fract(sin(bandN * 127.1 + uPhase) * 43758.5453);
        float per     = 25.0 + sr  * 25.0;
        float perN    = 25.0 + srN * 25.0;
        float cyc     = mod(uTime + sr  * per,  per);
        float cycN    = mod(uTime + srN * perN, perN);
        float fd      = per  * 0.14;
        float fdN     = perN * 0.14;
        float sp      = smoothstep(0.0, fd, cyc) * (1.0 - smoothstep(per  * 0.35 - fd,  per  * 0.35 + fd,  cyc));
        float spN     = smoothstep(0.0, fdN, cycN) * (1.0 - smoothstep(perN * 0.35 - fdN, perN * 0.35 + fdN, cycN));
        float stripClear = mix(sp, spN, bBlend) * 1.0;

        float clearPulse = max(stripClear, boxClear * 0.6);  // box gets 60% less blur than background

        // ── Subtle drifting haze: slow sine-wave fog, ramps in over 20s ──
        float haze = 0.5 + 0.5 *
            sin(vUv.x * 1.8 + uTime * 0.05 + vUv.y * 0.9) *
            sin(vUv.y * 1.4 + uTime * 0.03 - vUv.x * 0.7);
        haze = clamp(haze, 0.0, 1.0);
        float hazeRamp = smoothstep(10.0, 60.0, uTime);

        // Global blur breath — three incommensurate sine waves sum to an aperiodic swell.
        // Range: 0.55–1.45× base blur, cycles loosely every 25–90 s.
        float blurBreath = 1.0
            + sin(uTime * 0.042 + 0.0) * 0.22
            + sin(uTime * 0.017 + 1.9) * 0.15
            + sin(uTime * 0.071 + 4.3) * 0.08;
        blurBreath = clamp(blurBreath, 0.3, 1.8);

        float blurStep = 0.0018 * haze * hazeRamp * blurBreath * (1.0 - clearPulse);

        // Gentle lateral drift
        vec2 drift = vec2(
            sin(uTime * 0.025 + vUv.y * 1.5) * 0.0008,
            cos(uTime * 0.018 + vUv.x * 1.2) * 0.0005
        );

        vec4  colH        = vec4(0.0);
        vec4  colV        = vec4(0.0);
        float totalWeight = 0.0;

        for (int i = -8; i <= 8; i++) {
          float fi = float(i);
          float w  = exp(-(fi * fi) / 12.5);
          colH += texture2D(uFeedback, vUv + vec2(fi * blurStep, 0.0) + drift) * w;
          colV += texture2D(uFeedback, vUv + vec2(0.0, fi * blurStep) + drift) * w;
          totalWeight += w;
        }

        gl_FragColor = clamp((colH + colV) / (2.0 * totalWeight), 0.0, 1.0);
      }
    `;

    // ═══════════════════════════════════════════════════════════════
    //  PASS 3  —  CONTRAST + SHADOW ENHANCEMENT
    //  Deepens dark bands so trunk streaks read as strong vertical geometry.
    //  Reads:  fboB   Writes: fboA
    // ═══════════════════════════════════════════════════════════════
   const FRAG3 = /* glsl */`
      uniform sampler2D uInput;
      uniform float     uTime;
      uniform float     uPhase;
      varying vec2 vUv;

      void main() {
        vec4 col = texture2D(uInput, vUv);

        // ── Replicate clearPulse from Pass 2 ──
        float bandF2      = vUv.x * 16.0;
        float band2       = floor(bandF2);
        float bandNext2   = band2 + 1.0;
        float bandBlend2  = smoothstep(0.25, 0.75, fract(bandF2));
        float stripRand3  = fract(sin(band2     * 127.1 + uPhase)       * 43758.5453);
        float stripRand4  = fract(sin(band2     * 311.7 + uPhase * 1.3) * 19823.1547);
        float stripRandN3 = fract(sin(bandNext2 * 127.1 + uPhase)       * 43758.5453);
        float stripRandN4 = fract(sin(bandNext2 * 311.7 + uPhase * 1.3) * 19823.1547);

        float period3  = 45.0 + stripRand3  * 30.0;
        float period3N = 45.0 + stripRandN3 * 30.0;
        float onFrac3  = 0.35 + stripRand3  * 0.20;
        float onFrac3N = 0.35 + stripRandN3 * 0.20;
        float cycleT3  = mod(uTime + stripRand3  * period3,  period3);
        float cycleTN3 = mod(uTime + stripRandN3 * period3N, period3N);
        float fade3  = period3  * 0.08;
        float fade3N = period3N * 0.08;
        float cp3  = 1.0 - smoothstep(period3  * onFrac3  - fade3,  period3  * onFrac3  + fade3,  cycleT3);
        float cpN3 = 1.0 - smoothstep(period3N * onFrac3N - fade3N, period3N * onFrac3N + fade3N, cycleTN3);
        float clearPulse = mix(cp3, cpN3, bandBlend2);

        float edgeNoise3 = sin(vUv.x * 3.8 + uTime * 0.03 + uPhase * 0.22) * 0.45
                         + sin(vUv.y * 2.9 - uTime * 0.04 + uPhase * 0.31) * 0.35
                         + sin(vUv.x * 1.2 + vUv.y * 2.1 + uTime * 0.02)   * 0.20;
        edgeNoise3 = edgeNoise3 * 0.5 + 0.5;
        clearPulse *= smoothstep(0.30, 0.55, edgeNoise3);

        // ── Multi-scale halation: three radii approximate wide photographic bloom ──
        float bs1 = 0.007, bs2 = 0.022, bs3 = 0.055;
        vec4 s1 = (texture2D(uInput,vUv+vec2(-bs1,0.0))+texture2D(uInput,vUv+vec2(bs1,0.0))
                  +texture2D(uInput,vUv+vec2(0.0,-bs1))+texture2D(uInput,vUv+vec2(0.0,bs1)))*0.25;
        vec4 s2 = (texture2D(uInput,vUv+vec2(-bs2,0.0))+texture2D(uInput,vUv+vec2(bs2,0.0))
                  +texture2D(uInput,vUv+vec2(0.0,-bs2))+texture2D(uInput,vUv+vec2(0.0,bs2)))*0.25;
        vec4 s3 = (texture2D(uInput,vUv+vec2(-bs3,0.0))+texture2D(uInput,vUv+vec2(bs3,0.0))
                  +texture2D(uInput,vUv+vec2(0.0,-bs3))+texture2D(uInput,vUv+vec2(0.0,bs3)))*0.25;

        // Pyramid: tight glow + mid halo + wide bleed
        vec4 soft = col * 0.35 + s1 * 0.30 + s2 * 0.22 + s3 * 0.13;
        soft.rgb *= vec3(0.5, 1.08, 1.50);

        float softLuma = dot(soft.rgb, vec3(0.299, 0.587, 0.114));
        float halation = smoothstep(0.45, 0.90, softLuma);  // only truly bright areas bleed

        // Bloom: subtle screen blend, not neon
        float bloomStr = 0.5;
        vec3 bloomed = 1.0 - (1.0 - col.rgb) * (1.0 - soft.rgb * halation * bloomStr);

        // ── Shadow lift: reduced so darks can stay deep ──
        float luma     = dot(bloomed, vec3(0.299, 0.587, 0.114));
        float sMask    = 1.0 - smoothstep(0.0, 0.45, luma);
        float liftStr  = 0.28;
        vec3 liftFloor = vec3(0.12, 0.18, 0.22);  // teal shadow floor
        vec3 lifted    = mix(bloomed, max(bloomed, liftFloor), sMask * liftStr);

       // Bloom + lift only when blurred — clear zones pass through unchanged
        col.rgb = mix(lifted, col.rgb, clearPulse);

        gl_FragColor = clamp(col, 0.0, 1.0);
      }
    `;
    // ═══════════════════════════════════════════════════════════════
    //  PASS 4  —  COLOR GRADE + FILM GRAIN + VIGNETTE
    //  Final composite rendered directly to screen.
    //  Reads:  fboA   Writes: screen (null render target)
    // ═══════════════════════════════════════════════════════════════
    const FRAG4 = /* glsl */`
      uniform sampler2D uInput;
      uniform sampler2D uTexture;   // raw video — used for clear zones
      uniform float     uTime;
      uniform float     uPhase;
      uniform vec2      uScreenRes;
      uniform vec2      uVideoRes;
      uniform float     uBoxW;
      uniform float     uBoxH;
      uniform float     uBox2W;   // forest plantation box half-width
      uniform float     uBox2H;   // forest plantation box half-height
      varying vec2 vUv;

      float rand(vec2 co) {
        return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
      }

      void main() {
        vec4 col = texture2D(uInput, vUv);

        // ── Cover-fit UV for raw video ──
        vec2 videoUV = vUv;
        float sa = uScreenRes.x / uScreenRes.y;
        float va = uVideoRes.x  / uVideoRes.y;
        if (sa > va) {
          float yscale = va / sa;
          videoUV.y = (vUv.y - 0.5) * yscale + 0.5;
        } else {
          float xscale = sa / va;
          videoUV.x = (vUv.x - 0.5) * xscale + 0.5;
        }
        vec4 rawVideo = texture2D(uTexture, videoUV);

        // Box mask: hard sharp boundary
        float boxW = uBoxW;
        float boxH = uBoxH;
        vec2 fromCenter = abs(vUv - vec2(0.5));
        float lumenMask = step(fromCenter.x, boxW) * step(fromCenter.y, boxH);

        // Subtle background strips — match FRAG2 strip logic
        float bandF4  = vUv.x * 10.0;
        float band4   = floor(bandF4);
        float bandN4  = band4 + 1.0;
        float bBlend4 = smoothstep(0.25, 0.75, fract(bandF4));
        float sr4     = fract(sin(band4  * 127.1 + uPhase) * 43758.5453);
        float srN4    = fract(sin(bandN4 * 127.1 + uPhase) * 43758.5453);
        float per4    = 25.0 + sr4  * 25.0;
        float perN4   = 25.0 + srN4 * 25.0;
        float cyc4    = mod(uTime + sr4  * per4,  per4);
        float cycN4   = mod(uTime + srN4 * perN4, perN4);
        float fd4     = per4  * 0.14;
        float fdN4    = perN4 * 0.14;
        float sp4     = smoothstep(0.0, fd4, cyc4) * (1.0 - smoothstep(per4  * 0.35 - fd4,  per4  * 0.35 + fd4,  cyc4));
        float spN4    = smoothstep(0.0, fdN4, cycN4) * (1.0 - smoothstep(perN4 * 0.35 - fdN4, perN4 * 0.35 + fdN4, cycN4));
        float stripClear4 = mix(sp4, spN4, bBlend4) * 1.0;

        float clearPulse = max(lumenMask, stripClear4);
        float bgMask = 1.0 - lumenMask;   // 1 outside box, 0 inside

        // ── Blend raw video into box interior so it reads cleaner ──
        col.rgb = mix(col.rgb, rawVideo.rgb, lumenMask * 0.45);

        // ── Grade the FBO (blurred) col ──

        // Teal-green shift — cut red in midtones, lift blue slightly
        float lumaMid = dot(col.rgb, vec3(0.299, 0.587, 0.114));
        float midMask = smoothstep(0.20, 0.65, lumaMid);
        col.rgb = mix(col.rgb, col.rgb * vec3(0.93, 1.00, 1.03), midMask * 0.30);

        // Global tint
        col.rgb *= vec3(0.97, 1.00, 1.01);

        // ── Contrast crush everywhere ──
        float cLuma = dot(col.rgb, vec3(0.299, 0.587, 0.114));
        vec3 crushed = col.rgb * pow(clamp(cLuma, 0.0, 1.0), 0.12);
        col.rgb = crushed;

        // ── Film grain ──
        float noise = rand(vUv + vec2(mod(uTime, 97.3) * 0.011, mod(uTime, 71.9) * 0.013));
        col.rgb += (noise - 0.5) * 0.03;

        // Dapple
        float dapple = 1.0
            + 0.04 * sin(uTime * 0.31 + vUv.x * 5.2 + vUv.y * 2.7)
            + 0.03 * sin(uTime * 0.57 + vUv.x * 8.1 - vUv.y * 4.3)
            + 0.02 * sin(uTime * 0.83 - vUv.x * 3.6 + vUv.y * 6.9);
        col.rgb *= 1.0 * dapple;

        // ── Dark blue-teal overlay everywhere ──
        col.rgb *= vec3(0.78, 0.85, 0.92);

        // ── Lumen print remap on background (outside box) ──
        float colLuma = dot(col.rgb, vec3(0.299, 0.587, 0.114));

        // Spatial noise — breaks up banded threshold crossings into organic contours
        float luNoise = sin(vUv.x * 23.7 + vUv.y * 17.3 + uTime * 0.07) * 0.5
                      + sin(vUv.x * 41.1 - vUv.y * 31.9 + uTime * 0.04) * 0.3
                      + sin(vUv.x * 11.3 + vUv.y * 53.7 - uTime * 0.05) * 0.2;
        luNoise = luNoise * 0.5 + 0.5;
        colLuma = clamp(colLuma + (luNoise - 0.5) * 0.10, 0.0, 1.0);

        vec3 l0 = vec3(0.62, 0.56, 0.46);   // warm dark brown — shadow / background
        vec3 l1 = vec3(0.72, 0.84, 0.66);   // pale green-yellow — dark subject zones
        vec3 l2 = vec3(0.36, 0.62, 0.50);   // muted teal-green — midtone subject
        vec3 l3 = vec3(0.12, 0.48, 0.64);   // deep teal-blue — bright subject areas
        vec3 l4 = vec3(0.02, 0.10, 0.40);   // deep navy — overexposed highlights

        vec3 lumenCol = mix(l0, l1, smoothstep(0.00, 0.28, colLuma));
        lumenCol      = mix(lumenCol, l2, smoothstep(0.20, 0.52, colLuma));
        lumenCol      = mix(lumenCol, l3, smoothstep(0.44, 0.74, colLuma));
        lumenCol      = mix(lumenCol, l4, smoothstep(0.68, 0.96, colLuma));

        // Sawtooth: builds over LUMEN_PERIOD seconds then hard-cuts back to 0
        const float LUMEN_PERIOD = 67.5;  // 27 ticks × 2.5s per tick
        float lumenCycle = mod(uTime, LUMEN_PERIOD);
        // Hold at zero (dark) for BLACK_HOLD seconds after reset, then ramp 0→1 over the remainder
        const float DARK_FADE_IN  = 1.0;
        const float DARK_HOLD_DUR = 2.0;
        const float DARK_FADE_OUT = 4.0;
        const float DARK_TOTAL    = DARK_FADE_IN + DARK_HOLD_DUR + DARK_FADE_OUT;
        float lumenRamp = lumenCycle < DARK_TOTAL
            ? 0.0
            : (lumenCycle - DARK_TOTAL) / (LUMEN_PERIOD - DARK_TOTAL);

        // Aperiodic breath
        float lumenBreath = 0.67
            + sin(uTime * 0.052 + 0.0) * 0.18
            + sin(uTime * 0.031 + 2.3) * 0.10
            + sin(uTime * 0.079 + 4.7) * 0.05;
        lumenBreath = clamp(lumenBreath, 0.10, 0.40);  // change this to control how dark it gets!!

        // Apply lumen remap to background only
        col.rgb = mix(col.rgb, lumenCol, bgMask * lumenRamp * lumenBreath);

        // ── Cycle reset: transition fires AFTER tick 27 (at start of new cycle) ──
        float darkPhase = 0.0;
        if (lumenCycle > 0.001 && lumenCycle < DARK_TOTAL) {
          if (lumenCycle < DARK_FADE_IN) {
            darkPhase = smoothstep(0.0, DARK_FADE_IN, lumenCycle);
          } else if (lumenCycle < DARK_FADE_IN + DARK_HOLD_DUR) {
            darkPhase = 1.0;
          } else {
            darkPhase = 1.0 - smoothstep(DARK_FADE_IN + DARK_HOLD_DUR, DARK_TOTAL, lumenCycle);
          }
        }
        float tealPhase = darkPhase;  // used by border logic below

        // ── Box border with glitch flicker — hidden during teal ──
        // Convert a consistent pixel thickness to UV space per-axis
        const float BORDER_PX = 1.0;   // border thickness in screen pixels — tune this
        vec2 borderUV = vec2(BORDER_PX) / uScreenRes;
        float innerX = step(fromCenter.x, boxW - borderUV.x) * step(fromCenter.y, boxH - borderUV.y);
        float outerX = step(fromCenter.x, boxW + borderUV.x) * step(fromCenter.y, boxH + borderUV.y);
        float borderMask = clamp(outerX - innerX, 0.0, 1.0) * (1.0 - tealPhase);

        // Glitch: occasional horizontal displacement bands
        float glitchBand = floor(vUv.y * 60.0 + uTime * 4.3);
        float glitchRng  = fract(sin(glitchBand * 91.3 + uTime * 7.1) * 43758.5);
        float glitchOn   = step(0.92, glitchRng);   // fires ~8% of bands per frame
        float glitchShift = (fract(sin(glitchBand * 37.1) * 9182.3) - 0.5) * 0.004 * glitchOn;

        // Flicker: slow aperiodic brightness pulse
        float flicker = 0.75
            + sin(uTime * 1.3) * 0.12
            + sin(uTime * 2.1 + 1.3) * 0.08
            + sin(uTime * 3.4 + 2.9) * 0.05;
        flicker = clamp(flicker, 0.0, 1.0);

        vec3 borderCol = vec3(0.82, 0.90, 0.88) * flicker;   // light teal-white
        col.rgb = mix(col.rgb, borderCol, borderMask * flicker);

        // ── Dark green multiply overlay: covers reset fade-out + black hold ──
        // flashPhase covers last 4.5s before reset; blackHoldPhase covers first 3s after.
        // Together they bracket the full transition window.
        darkPhase = clamp(darkPhase, 0.0, 1.0);
        // Multiply blend: col * darkGreen → crushes to near-black with green tint, video still visible
        vec3 darkGreen = vec3(0.02, 0.06, 0.03);
        // Suppress transition on the very first cycle (uTime < LUMEN_PERIOD)
        float afterFirstCycle = step(LUMEN_PERIOD, uTime);
        col.rgb = mix(col.rgb, col.rgb * darkGreen, darkPhase * afterFirstCycle);

        gl_FragColor = vec4(clamp(col.rgb, 0.0, 1.0), 1.0);
      }
    `;

    // ═══════════════════════════════════════════════════════════════
    //  RENDERER
    // ═══════════════════════════════════════════════════════════════
    const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
    renderer.setPixelRatio(1);   // installation default — no HiDPI upscale
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(renderer.domElement);

    const W = window.innerWidth;
    const H = window.innerHeight;

    // ── Render targets (ping-pong feedback) ──
    // HalfFloatType avoids banding in gradient feedback accumulation.
    // depthBuffer/stencilBuffer disabled — we only render full-screen quads.
    const rtOpts = {
      minFilter:     THREE.LinearFilter,
      magFilter:     THREE.LinearFilter,
      format:        THREE.RGBAFormat,
      type:          THREE.HalfFloatType,
      depthBuffer:   false,
      stencilBuffer: false
    };
    let fboA = new THREE.WebGLRenderTarget(W, H, rtOpts);
    let fboB = new THREE.WebGLRenderTarget(W, H, rtOpts);

    // ── Full-screen quad ──
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const scene  = new THREE.Scene();
    const quad   = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
    scene.add(quad);

    // ═══════════════════════════════════════════════════════════════
    //  VIDEO TEXTURE
    // ═══════════════════════════════════════════════════════════════
    const video    = document.getElementById('vid');
    const videoTex = new THREE.VideoTexture(video);
    videoTex.minFilter = THREE.LinearFilter;
    videoTex.magFilter = THREE.LinearFilter;

    // Update video resolution uniform once the file's dimensions are known.
    video.addEventListener('loadedmetadata', () => {
      matP1.uniforms.uVideoRes.value.set(video.videoWidth, video.videoHeight);
      matP4.uniforms.uVideoRes.value.set(video.videoWidth, video.videoHeight); 
      video.playbackRate = 0.5;
      video.loop = true;
    });

    // Autoplay: muted + playsinline handles most browsers automatically.
    // Click/touch fallback covers restrictive mobile policies.
    const tryPlay = () => video.play().catch(() => {});
    tryPlay();
    document.addEventListener('click',      tryPlay, { once: true });
    document.addEventListener('touchstart', tryPlay, { once: true });

    // ═══════════════════════════════════════════════════════════════
    //  SHADER MATERIALS
    // ═══════════════════════════════════════════════════════════════
    const matP1 = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG1,
      uniforms: {
        uTexture:   { value: videoTex },
        uPrev:      { value: fboB.texture },   // updated each frame
        uDecay:     { value: 0.88 },
        uScreenRes: { value: new THREE.Vector2(W, H) },
        uVideoRes:  { value: new THREE.Vector2(1920, 1080) }  // overridden on loadedmetadata
      },
      depthTest: false, depthWrite: false
    });

    // ── Rubber plantation data: Perak total plantations (000 ha), 2007–2024 ──
    // Source: Total Rubber Plantations tab, row 4 (Total Plantations), columns T–AK
    const rubberData = [
      { year: 2007, ha: 1019.75 },
      { year: 2008, ha: 1018.77 },
      { year: 2009, ha:  789.02 },
      { year: 2010, ha:  772.70 },
      { year: 2011, ha:  776.88 },
      { year: 2012, ha:  771.61 },
      { year: 2013, ha:  773.39 },
      { year: 2014, ha:  778.60 },
      { year: 2015, ha:  777.15 },
      { year: 2016, ha:  770.53 },
      { year: 2017, ha:  766.68 },
      { year: 2018, ha:  766.90 },
      { year: 2019, ha:  776.74 },
      { year: 2020, ha:  774.12 },
      { year: 2021, ha:  773.10 },
      { year: 2022, ha:  772.10 },
      { year: 2023, ha:  771.10 },
      { year: 2024, ha:  770.10 },
    ];

    const RD_MIN  = 766.68;   // 2017 low
    const RD_MAX  = 1019.75;  // 2007 high
    const RD_RANGE = RD_MAX - RD_MIN;

    // Estate and smallholding breakdown (000 ha), 2007–2024
    // Source: Total Rubber Plantations sheet, rows 2 & 3
    const estateData = [
      { year: 2007, ha:  53.25 }, { year: 2008, ha:  61.00 }, { year: 2009, ha:  61.00 },
      { year: 2010, ha:  64.10 }, { year: 2011, ha:  64.114 }, { year: 2012, ha:  65.847 },
      { year: 2013, ha:  65.103 }, { year: 2014, ha:  67.775 }, { year: 2015, ha:  64.442 },
      { year: 2016, ha:  65.096 }, { year: 2017, ha:  62.792 }, { year: 2018, ha:  63.009 },
      { year: 2019, ha:  72.847 }, { year: 2020, ha:  72.226 }, { year: 2021, ha:  72.200 },
      { year: 2022, ha:  72.226 }, { year: 2023, ha:  72.226 }, { year: 2024, ha:  72.226 },
    ];
    const smallholdingData = [
      { year: 2007, ha: 966.50 }, { year: 2008, ha: 957.77 }, { year: 2009, ha: 728.02 },
      { year: 2010, ha: 708.60 }, { year: 2011, ha: 712.769 }, { year: 2012, ha: 705.767 },
      { year: 2013, ha: 708.286 }, { year: 2014, ha: 710.823 }, { year: 2015, ha: 712.705 },
      { year: 2016, ha: 705.432 }, { year: 2017, ha: 703.890 }, { year: 2018, ha: 703.890 },
      { year: 2019, ha: 703.890 }, { year: 2020, ha: 701.890 }, { year: 2021, ha: 700.900 },
      { year: 2022, ha: 699.990 }, { year: 2023, ha: 698.900 }, { year: 2024, ha: 697.900 },
    ];

    // ── Forest Plantation data (ha/year, total across all states) ──
    const forestData = [
      { year: 2007, ha: 18146 },
      { year: 2008, ha: 20981 },
      { year: 2009, ha: 12023 },
      { year: 2010, ha: 14297 },
      { year: 2011, ha:  6575 },
      { year: 2012, ha: 13486 },
      { year: 2013, ha:  6947 },
      { year: 2014, ha: 12112 },
      { year: 2015, ha: 23346 },
      { year: 2016, ha: 28831 },
      { year: 2017, ha: 19938 },
      { year: 2018, ha: 31783 },
      { year: 2019, ha: 21399 },
    ];
    const FP_MIN   =  6575;   // 2011 low
    const FP_MAX   = 31783;   // 2018 high
    const FP_RANGE = FP_MAX - FP_MIN;
    // ── Shared absolute scale with sqrt perceptual mapping ──
    // All three box types share one ha axis so rubber > forest > state is always visible.
    // sqrt mapping keeps smaller datasets legible while preserving relative ordering.
    const GLOBAL_HA_MAX = 1019.75 * 1000;  // 1,019,750 ha — rubber 2007 peak
    const ABS_W_MAX = 0.22;
    const BOX2_W_MAX = ABS_W_MAX * Math.sqrt(FP_MAX / GLOBAL_HA_MAX);  // no-data fallback

    // ── Per-state forest plantation data (ha/year, Total Forest Plantations sheet) ──
    const stateFPData = {
      'Kelantan':          [10426,14406,10376,11349, 1566, 5824,    0, 3872,10002, 8002, 5430,13274,12336],
      'Pahang':            [  854, 1405,  445, 1519, 1585, 5183, 5421, 4418, 9338,15594,10806,10428, 8752],
      'Johor':             [ 4249, 3928,  386, 1429,  128, 2479,  557, 3053, 2497,  307,  415,  390,    0],
      'Kedah':             [    0,    0,    0,    0, 2950,    0,  889,  121,  526, 3328, 1503, 2330,  311],
      'Perak':             [  701,    0,  816,    0,  346,    0,   80,    0,  800, 1600, 1200, 5361,    0],
      'Negeri Sembilan':   [  953,  349,    0,    0,    0,    0,    0,  648,  183,    0,  584,    0,    0],
      'Selangor':          [  963,  893,    0,    0,    0,    0,    0,    0,    0,    0,    0,    0,    0],
    };
    const STATE_YEARS   = [2007,2008,2009,2010,2011,2012,2013,2014,2015,2016,2017,2018,2019];
    const STATE_NAMES   = ['Kelantan','Pahang','Johor','Kedah','Perak','Negeri Sembilan','Selangor'];
    const STATE_IDS     = ['kelantan','pahang','johor','kedah','perak','negeri-sembilan','selangor'];
    const STATE_HA_MAX  = 15594 * 0.6;   // Pahang 2016 peak, scaled 60%

    function getForestBoxDims(year) {
      const entry = forestData.find(d => d.year === year);
      if (!entry) return null;
      const w = ABS_W_MAX * Math.sqrt(entry.ha / GLOBAL_HA_MAX);
      const aspect = window.innerWidth / window.innerHeight;
      return { w, h: w * aspect, year: entry.year, ha: entry.ha };
    }

    // Fixed positions per state: side = 'right'|'left', yFrac = 0..1 fraction of SCREEN height for box centre
    // Right: 3 states — spaced at ~20%, 50%, 80% of screen
    // Left:  4 states — spaced at ~10%, 35%, 62%, 88% of screen
    // All state boxes share SHARED_W_MAX so sizes are comparable to rubber + forest boxes
    const STATE_PERIMETER = [
      { side: 'right', yFrac: 0.08 },  // Kelantan
      { side: 'left',  yFrac: 0.55 },  // Pahang
      { side: 'right', yFrac: 0.38 },  // Johor
      { side: 'right', yFrac: 0.72 },  // Kedah
      { side: 'left',  yFrac: 0.22 },  // Perak
      { side: 'left',  yFrac: 0.78 },  // Negeri Sembilan
      { side: 'right', yFrac: 0.90 },  // Selangor
    ];
    // state boxes: sqrt absolute scale, same axis as rubber + forest

    function updateStateBoxes(year, rbWpx, fpWpx, fpHpx) {
      const yearIdx = STATE_YEARS.indexOf(year);
      const W = window.innerWidth, H = window.innerHeight;
      const cx = W * 0.5, cy = H * 0.5;
      const gap = 200;  // px gap between rubber box edge and state box

      STATE_NAMES.forEach((name, i) => {
        const boxEl   = document.getElementById('state-box-' + STATE_IDS[i]);
        const labelEl = document.getElementById('state-lbl-' + STATE_IDS[i]);
        if (!boxEl) return;

        const ha = yearIdx >= 0 ? stateFPData[name][yearIdx] * 0.6 : 0;

        if (!ha) {
          boxEl.style.display = 'none';
          if (labelEl) labelEl.style.display = 'none';
          return;
        }

        const norm = Math.sqrt(ha / GLOBAL_HA_MAX);
        const side = norm * ABS_W_MAX * W;

        const { side: edge, yFrac } = STATE_PERIMETER[i];
        const boxCy = H * yFrac;  // vertical centre of this state box in screen pixels
        let bx;
        if (edge === 'right') {
          bx = cx + rbWpx + gap;
        } else {
          bx = cx - rbWpx - gap - side;
        }
        const by = boxCy - side * 0.5;

        boxEl.style.display = '';
        boxEl.style.left    = bx + 'px';
        boxEl.style.top     = by + 'px';
        boxEl.style.width   = side + 'px';
        boxEl.style.height  = side + 'px';

        if (labelEl) {
          labelEl.style.display   = '';
          labelEl.textContent     = name + ' · ' + ha.toLocaleString() + ' ha';
          labelEl.style.left      = bx + 'px';
          labelEl.style.top       = (by - 2) + 'px';   // 2px gap above box top
          labelEl.style.transform = 'translateY(-100%)'; // bottom edge sits above corner
        }
      });
    }

    // Box dimension range (half-extents):
    //   At max plantation (2007): box is largest  — BOX_W 0.38
    //   At min plantation (2017): box is smallest — BOX_W 0.18
    //   H is derived from W to make a perfect square on screen
    const BOX_W_MAX = ABS_W_MAX;  // rubber top of scale

    // Each year holds for SECS_PER_YEAR seconds, with smooth interpolation between years
    const SECS_PER_YEAR = 2.5;
    const CYCLE_DURATION = rubberData.length * SECS_PER_YEAR;

    function getBoxDims(t) {
      const idx  = Math.floor((t % CYCLE_DURATION) / SECS_PER_YEAR) % rubberData.length;
      const ha   = rubberData[idx].ha;
      const w    = ABS_W_MAX * Math.sqrt((ha * 1000) / GLOBAL_HA_MAX);
      const aspect = window.innerWidth / window.innerHeight;
      return {
        w,
        h: w * aspect,   // same physical size on screen → perfect square
        year: rubberData[idx].year,
        ha: Math.round(ha * 10) / 10
      };
    }

    const matP2 = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG2,
      uniforms: {
        uFeedback: { value: fboA.texture },    // updated each frame
        uTime:     { value: 0.0 },             // drives blur ramp
        uPhase:    { value: Math.random() * 25.0 },  // random start within one cycle
        uBoxW:     { value: getBoxDims(0).w },
        uBoxH:     { value: getBoxDims(0).h }
      },
      depthTest: false, depthWrite: false
    });

    const matP3 = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG3,
      uniforms: {
        uInput:  { value: fboB.texture },
        uTime:   { value: 0.0 },
        uPhase:  { value: matP2.uniforms.uPhase.value }  // same seed as Pass 2
      },
      depthTest: false, depthWrite: false
    });

    const matP4 = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG4,
      uniforms: {
        uInput:     { value: fboA.texture },       // updated each frame
        uTexture:   { value: videoTex },
        uTime:      { value: 0.0 },
        uPhase:     { value: matP2.uniforms.uPhase.value },
        uScreenRes: { value: new THREE.Vector2(W, H) },
        uVideoRes:  { value: new THREE.Vector2(1, 1) },  // set after video loads
        uBoxW:      { value: getBoxDims(0).w },
        uBoxH:      { value: getBoxDims(0).h },
        uBox2W:     { value: getForestBoxDims(2007)?.w ?? 0 },
        uBox2H:     { value: getForestBoxDims(2007)?.h ?? 0 }
      },
      depthTest: false, depthWrite: false
    });

    // ═══════════════════════════════════════════════════════════════
    //  RENDER-PASS HELPER
    // ═══════════════════════════════════════════════════════════════
    function renderPass(mat, target) {
      quad.material = mat;
      renderer.setRenderTarget(target);   // null = screen
      renderer.render(scene, camera);
    }

    // ═══════════════════════════════════════════════════════════════
    //  ANIMATION LOOP
    //
    //  Per-frame pipeline:
    //    Pass 1  video + fboB(prev streak)  ──→  fboA   (feedback decay)
    //    Pass 2  fboA                        ──→  fboB   (lateral streak — persistent buffer)
    //    Pass 3  fboB                        ──→  fboA   (contrast/shadow, temp)
    //    Pass 4  fboA                        ──→  screen (color grade + grain + vignette)
    //
    //  fboB is the living feedback accumulator fed back into Pass 1 next frame.
    //  Colour grade (Pass 4) is NOT fed back, preventing chroma drift.
    //
    //  LOOP NOTE: On video loop reset the feedback buffer will briefly
    //  flash as the last frame trails into the first. This is intentional —
    //  it reads as a natural pulse in an installation context.
    // ═══════════════════════════════════════════════════════════════
    const clock = new THREE.Clock();

    function animate() {
      requestAnimationFrame(animate);

      const rawT = clock.getElapsedTime();
      const t    = rawT;

      // ── Dark overlay phase — mirrors GLSL darkPhase ──
      const LUMEN_PERIOD_JS2 = 67.5;
      const DARK_FADE_IN_JS  = 1.0;
      const DARK_HOLD_DUR_JS = 2.0;
      const DARK_FADE_OUT_JS = 4.0;
      const DARK_TOTAL_JS    = DARK_FADE_IN_JS + DARK_HOLD_DUR_JS + DARK_FADE_OUT_JS;
      const lc = t % LUMEN_PERIOD_JS2;
      const ss = (a, b, x) => { const k = Math.max(0, Math.min(1,(x-a)/(b-a))); return k*k*(3-2*k); };
      // Transition fires AFTER tick 27 — entire window is at start of new cycle
      let darkPhaseRaw = 0;
      if (lc > 0.001 && lc < DARK_TOTAL_JS) {
        if (lc < DARK_FADE_IN_JS) {
          darkPhaseRaw = ss(0, DARK_FADE_IN_JS, lc);
        } else if (lc < DARK_FADE_IN_JS + DARK_HOLD_DUR_JS) {
          darkPhaseRaw = 1;
        } else {
          darkPhaseRaw = 1 - ss(DARK_FADE_IN_JS + DARK_HOLD_DUR_JS, DARK_TOTAL_JS, lc);
        }
      }
      const darkPhaseJS = t < LUMEN_PERIOD_JS2 ? 0 : darkPhaseRaw;
      const overlayHidden = darkPhaseJS > 0.05;

      // ── Hide / show all overlays based on dark phase ──
      const overlayEls = [
        'box-year', 'rubber-estate-label', 'rubber-smallholding-label',
        'fp-label', 'fp-box',
        ...STATE_IDS.map(id => 'state-box-' + id),
        ...STATE_IDS.map(id => 'state-lbl-' + id),
      ];
      overlayEls.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.visibility = overlayHidden ? 'hidden' : '';
      });

      // ── Plantation audio: follows same show/hide logic as overlays ──
      const audioActive = !overlayHidden;
      if (audioActive !== audioWasActive) {
        if (audioActive && audioUnlocked) {
          plantationAudio.currentTime = 0;
          plantationAudio.play().catch(() => {});
        } else if (!audioActive) {
          plantationAudio.pause();
        }
        audioWasActive = audioActive;
      }

      // Required every frame: tells Three.js the video has new pixel data.
      videoTex.needsUpdate = true;

      // ── Pass 1: Feedback decay ──
      matP1.uniforms.uPrev.value = fboB.texture;
      renderPass(matP1, fboA);

      // ── Pass 2: Lateral streak → persistent fboB ──
      matP2.uniforms.uFeedback.value = fboA.texture;
      matP2.uniforms.uTime.value     = t;
      renderPass(matP2, fboB);

      // ── Pass 3: Bloom/lift in clear zones, deepen in blurred zones ──
      matP3.uniforms.uInput.value = fboB.texture;
      matP3.uniforms.uTime.value  = t;
      renderPass(matP3, fboA);

      // ── Update box dimensions from rubber plantation data ──
      const dims = getBoxDims(t);
      matP2.uniforms.uBoxW.value = dims.w;
      matP2.uniforms.uBoxH.value = dims.h;
      matP4.uniforms.uBoxW.value = dims.w;
      matP4.uniforms.uBoxH.value = dims.h;

      // ── Update second box dimensions from forest plantation data ──
      const dims2 = getForestBoxDims(dims.year);
      const aspect2 = window.innerWidth / window.innerHeight;
      const noDataW = BOX2_W_MAX;
      const noDataH = noDataW * aspect2;
      matP4.uniforms.uBox2W.value = dims2 ? dims2.w : noDataW;
      matP4.uniforms.uBox2H.value = dims2 ? dims2.h : noDataH;

      // ── Pass 4: Color grade + grain → screen ──
      matP4.uniforms.uInput.value = fboA.texture;
      matP4.uniforms.uTime.value  = t;
      renderPass(matP4, null);

      // ── Update per-state forest plantation boxes ──
      const fpWpx = (dims2 ? dims2.w : BOX2_W_MAX) * window.innerWidth;
      const fpHpx = (dims2 ? dims2.h : BOX2_W_MAX * (window.innerHeight / window.innerWidth)) * window.innerHeight;
      const rbWpx = dims.w * window.innerWidth;   // rubber box half-width in px
      updateStateBoxes(dims.year, rbWpx, fpWpx, fpHpx);

      // ── Update footer year ──
      const footerYear = document.getElementById('footer-year');
      if (footerYear) footerYear.textContent = dims.year;

      // ── Update cultivation cycle tick (1–27, resets with lumen period) ──
      const LUMEN_PERIOD = 67.5;
      const tick = Math.floor((t % LUMEN_PERIOD) / SECS_PER_YEAR) + 1;
      const footerTick = document.getElementById('footer-tick');
      if (footerTick) footerTick.textContent = 'Year ' + tick;

      // ── Update forest plantation footer ──
      const footerForest = document.getElementById('footer-forest');
      if (footerForest) footerForest.textContent = dims2 ? Math.round(dims2.ha).toLocaleString() + ' ha' : 'No Data';

      const footerRubber = document.getElementById('footer-rubber');
      if (footerRubber) footerRubber.textContent = Math.round(dims.ha * 1000).toLocaleString() + ' ha';

      // ── Update year label (rubber box, upper-left) ──
      const label = document.getElementById('box-year');
      if (label) {
        const leftPx  = (0.5 - dims.w) * window.innerWidth;
        const topPx   = (0.5 - dims.h) * window.innerHeight;
        label.style.left = leftPx + 'px';
        label.style.top  = topPx  + 'px';
        label.innerHTML = '<span style="color:rgba(255,255,255,0.55)">Rubber Plantation</span><br>' + Math.round(dims.ha * 1000).toLocaleString() + ' ha';
      }

      // ── Estate & smallholding breakdown labels ──
      const estateEntry       = estateData.find(d => d.year === dims.year);
      const smallholdingEntry = smallholdingData.find(d => d.year === dims.year);
      const estateLabel       = document.getElementById('rubber-estate-label');
      const smallholdingLabel = document.getElementById('rubber-smallholding-label');
      if (label && estateEntry && estateLabel) {
        estateLabel.style.left = label.style.left;
        estateLabel.style.top  = (parseFloat(label.style.top) + 56) + 'px';
        estateLabel.textContent = 'Estate · ' + Math.round(estateEntry.ha * 1000).toLocaleString() + ' ha';
      }
      if (label && smallholdingEntry && smallholdingLabel) {
        smallholdingLabel.style.left = label.style.left;
        smallholdingLabel.style.top  = (parseFloat(label.style.top) + 76) + 'px';
        smallholdingLabel.textContent = 'Smallholding · ' + Math.round(smallholdingEntry.ha * 1000).toLocaleString() + ' ha';
      }

      // ── Update second label (forest plantation box) ──
      // Forest plantation: centered outline box + label
      const fpLabel = document.getElementById('fp-label');
      const fpBox   = document.getElementById('fp-box');

      if (!dims2) {
        if (fpBox)   fpBox.style.display   = 'none';
        if (fpLabel) fpLabel.style.display = 'none';
      } else {
        const W2px = dims2.w * window.innerWidth;
        const H2px = dims2.h * window.innerHeight;
        const cx   = window.innerWidth  * 0.5;
        const cy   = window.innerHeight * 0.5 + 60;  // shifted down 80px

        // ── Glitch flicker + flash-hide — mirrors FRAG4 border logic ──
        const flickerJS   = Math.min(1, Math.max(0,
          0.75 + Math.sin(t * 1.3) * 0.12 + Math.sin(t * 2.1 + 1.3) * 0.08 + Math.sin(t * 3.4 + 2.9) * 0.05
        ));
        const borderAlpha = (1.0 - darkPhaseJS) * flickerJS;

        if (fpBox) {
          fpBox.style.display = '';
          fpBox.style.left    = (cx - W2px) + 'px';
          fpBox.style.top     = (cy - H2px) + 'px';
          fpBox.style.width   = (W2px * 2) + 'px';
          fpBox.style.height  = (H2px * 2) + 'px';
          fpBox.style.opacity = borderAlpha.toFixed(3);
        }
        if (fpLabel) {
          fpLabel.style.display   = '';
          fpLabel.style.left      = (cx - W2px) + 'px';
          fpLabel.style.top       = (cy - H2px - 2) + 'px';
          fpLabel.style.transform = 'translateY(-100%)';
          fpLabel.innerHTML       = '<span style="color:rgba(255,255,255,0.55)">Forest Plantation</span><br>' + Math.round(dims2.ha).toLocaleString() + ' ha';
        }
      }
    }

    // ── Plantation audio: play during ticks 1–27, pause on dark transition ──
    const plantationAudio = document.getElementById('plantation-audio');
    let audioWasActive = null;
    let audioUnlocked  = false;

    const unlockAudio = () => {
      audioUnlocked = true;
      // If audio should already be playing (overlays visible), start it now.
      if (audioWasActive) {
        plantationAudio.currentTime = 0;
        plantationAudio.play().catch(() => {});
      }
    };
    document.addEventListener('click',      unlockAudio, { once: true });
    document.addEventListener('touchstart', unlockAudio, { once: true });
    document.addEventListener('keydown',    unlockAudio, { once: true });

    animate();

    // ═══════════════════════════════════════════════════════════════
    //  RESIZE
    // ═══════════════════════════════════════════════════════════════
    window.addEventListener('resize', () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      renderer.setSize(w, h);
      fboA.setSize(w, h);
      fboB.setSize(w, h);
      matP1.uniforms.uScreenRes.value.set(w, h);
      matP4.uniforms.uScreenRes.value.set(w, h);
    });