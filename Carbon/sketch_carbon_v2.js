let scene, camera, renderer;
let bgScene, bgCamera, bgMesh, cyanotypeMesh, veilMesh;
let ringGroup, ringLabelEls = [];
let orbitControls;

// ── Particle system globals ───────────────────────────────────────────
const PT_COUNT = 50000;
const SPHERE_R = 2.8;
const L_COUNT  = Math.floor(PT_COUNT * 0.65); // left = agroforest, right = monoculture
let ptPositions, ptVelocities, ptNoiseTimes, ptSizes, ptOutward;
let pointsMesh;
let glowMesh;
let leftDensity = 0.0, rightDensity = 0.0;
let leftDensityTarget = 0.0, rightDensityTarget = 0.0;
let rightFadeDecrement = 0, rightFadeFramesLeft = 0, rightSpawnFrame = 0;
let rightResetTimer = 0;
let rightPhase = 1; // 1 = inward (normal), 0 = outward (clearcut explosion)
let cyanoTime = 0.0;

// ── Data globals ──────────────────────────────────────────────────────
let dataset = [];
let dataYear = 0;
let yearTimer = 0;
const YEAR_DURATION = 1.0; // seconds per year — 100s total runtime

// Smoothed display values (lerped each frame)
let displayMonoCumul  = 0;
let displayAgroCumul  = 0;
let displayMonoAnnual = 0;
let displayAgroAnnual = 0;

// Clearcut state
let isClearcut       = false;
let clearcutFlash    = 0.0;  // 1.0 → 0.0 over ~4s, drives DOM flash + glow color
let prevRowWasClearcut = false; // edge-detect: fires trigger exactly once per event

// Ledger / totals state
let lastHistoryYear = -1;
const HA = 205209;

// ── Inline 3D simplex noise (public domain, Stefan Gustavson) ────────
const _simplex = (() => {
    const G3 = 1/6, F3 = 1/3;
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) { const j = Math.floor(Math.random()*(i+1)); [p[i],p[j]]=[p[j],p[i]]; }
    const perm = new Uint8Array(512), permMod12 = new Uint8Array(512);
    for (let i = 0; i < 512; i++) { perm[i] = p[i&255]; permMod12[i] = perm[i]%12; }
    const grad3 = [[1,1,0],[-1,1,0],[1,-1,0],[-1,-1,0],[1,0,1],[-1,0,1],[1,0,-1],[-1,0,-1],[0,1,1],[0,-1,1],[0,1,-1],[0,-1,-1]];
    function dot(g,x,y,z){return g[0]*x+g[1]*y+g[2]*z;}
    return function(xin,yin,zin){
        let n0,n1,n2,n3;
        const s=(xin+yin+zin)*F3,i=Math.floor(xin+s),j=Math.floor(yin+s),k=Math.floor(zin+s);
        const t=(i+j+k)*G3,X0=i-t,Y0=j-t,Z0=k-t,x0=xin-X0,y0=yin-Y0,z0=zin-Z0;
        let i1,j1,k1,i2,j2,k2;
        if(x0>=y0){if(y0>=z0){i1=1;j1=0;k1=0;i2=1;j2=1;k2=0}else if(x0>=z0){i1=1;j1=0;k1=0;i2=1;j2=0;k2=1}else{i1=0;j1=0;k1=1;i2=1;j2=0;k2=1}}else{if(y0<z0){i1=0;j1=0;k1=1;i2=0;j2=1;k2=1}else if(x0<z0){i1=0;j1=1;k1=0;i2=0;j2=1;k2=1}else{i1=0;j1=1;k1=0;i2=1;j2=1;k2=0}}
        const x1=x0-i1+G3,y1=y0-j1+G3,z1=z0-k1+G3,x2=x0-i2+2*G3,y2=y0-j2+2*G3,z2=z0-k2+2*G3,x3=x0-1+3*G3,y3=y0-1+3*G3,z3=z0-1+3*G3;
        const ii=i&255,jj=j&255,kk=k&255;
        let t0=0.6-x0*x0-y0*y0-z0*z0; n0=t0<0?0:(t0*=t0,t0*t0*dot(grad3[permMod12[ii+perm[jj+perm[kk]]]],x0,y0,z0));
        let t1=0.6-x1*x1-y1*y1-z1*z1; n1=t1<0?0:(t1*=t1,t1*t1*dot(grad3[permMod12[ii+i1+perm[jj+j1+perm[kk+k1]]]],x1,y1,z1));
        let t2=0.6-x2*x2-y2*y2-z2*z2; n2=t2<0?0:(t2*=t2,t2*t2*dot(grad3[permMod12[ii+i2+perm[jj+j2+perm[kk+k2]]]],x2,y2,z2));
        let t3=0.6-x3*x3-y3*y3-z3*z3; n3=t3<0?0:(t3*=t3,t3*t3*dot(grad3[permMod12[ii+1+perm[jj+1+perm[kk+1]]]],x3,y3,z3));
        return 32*(n0+n1+n2+n3);
    };
})();

// ── Ring config (kept for optional use) ──────────────────────────────
const RING_VALUES     = [0, 2, 7, 27, 100];
const ALL_RING_VALUES = [0, 2, 7, 27, 100, 300];

// ─────────────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────────────
function init() {
    scene  = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(2, 1.5, 6);
    camera.lookAt(0, 0, 0);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.autoClear = false;
    document.body.appendChild(renderer.domElement);

    orbitControls = new THREE.OrbitControls(camera, renderer.domElement);
    orbitControls.enabled = false;

    bgScene  = new THREE.Scene();
    bgCamera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    bgCamera.position.set(0, 0, 5);

    const bgTexture  = new THREE.TextureLoader().load('data/background_1.png');
    const bgGeometry = new THREE.PlaneGeometry(1, 1);
    const bgMaterial = new THREE.MeshBasicMaterial({ map: bgTexture });
    bgMesh = new THREE.Mesh(bgGeometry, bgMaterial);
    bgMesh.position.z = -2;
    bgScene.add(bgMesh);

    createCyanotypeOverlay();
    updateBgSize();
    createParticleSystem();
    createGlowSprite();

    loadDataset(); // ← replaces old loadCSV()
    animate();
}

// ─────────────────────────────────────────────────────────────────────
// DATA LOADING
// ─────────────────────────────────────────────────────────────────────
function loadDataset() {
    fetch('data/final_carbon_dataset.json')
        .then(r => r.json())
        .then(json => {
            dataset = json.data;
            console.log(`Carbon dataset loaded: ${dataset.length} rows`);
            // Seed display values at year 0 so there's no lerp jump on first frame
            displayMonoCumul  = dataset[0].mono_cumulative_tco2e_ha;
            displayAgroCumul  = dataset[0].agro_cumulative_tco2e_ha;
            displayMonoAnnual = dataset[0].mono_net_annual_tco2e_ha_yr;
            displayAgroAnnual = dataset[0].agro_net_annual_tco2e_ha_yr;
        })
        .catch(err => console.error('Failed to load carbon_dataset.json:', err));
}

// ─────────────────────────────────────────────────────────────────────
// CLEARCUT TRIGGER — only right hemisphere, data-driven
// ─────────────────────────────────────────────────────────────────────
function triggerClearcutReset() {
    // Reset right-hemisphere particle system into outward explosion phase
    rightResetTimer     = 0;
    rightFadeDecrement  = rightDensity / 350;
    rightFadeFramesLeft = 350;
    rightSpawnFrame     = 1;
    rightPhase          = 0;   // outward expansion from center (carbon release)
    clearcutFlash       = 1.0; // flash decays in animate(), drives DOM + glow tint
}

// ─────────────────────────────────────────────────────────────────────
// RESET
// ─────────────────────────────────────────────────────────────────────
function resetSimulation() {
    dataYear            = 0;
    yearTimer           = 0;
    lastHistoryYear     = -1;
    isClearcut          = false;
    clearcutFlash       = 0.0;
    prevRowWasClearcut  = false;
    rightPhase          = 1;
    rightResetTimer     = 0;
    rightFadeDecrement  = 0;
    rightFadeFramesLeft = 0;
    rightSpawnFrame     = 0;
    leftDensity         = 0.0;  rightDensity        = 0.0;
    leftDensityTarget   = 0.0;  rightDensityTarget  = 0.0;

    if (dataset.length > 0) {
        displayMonoCumul  = dataset[0].mono_cumulative_tco2e_ha;
        displayAgroCumul  = dataset[0].agro_cumulative_tco2e_ha;
        displayMonoAnnual = dataset[0].mono_net_annual_tco2e_ha_yr;
        displayAgroAnnual = dataset[0].agro_net_annual_tco2e_ha_yr;
    }

    const agroHistory = document.getElementById('agro-history');
    const monoHistory = document.getElementById('mono-history');
    if (agroHistory) agroHistory.innerHTML = '';
    if (monoHistory) monoHistory.innerHTML = '';

    for (let i = 0; i < PT_COUNT; i++) {
        const isLeft = i < L_COUNT;
        const r     = SPHERE_R * Math.pow(Math.random(), 3.0);
        const theta = Math.random() * Math.PI * 2;
        const phi   = Math.acos(2 * Math.random() - 1);
        let x       = r * Math.sin(phi) * Math.cos(theta);
        const y     = r * Math.sin(phi) * Math.sin(theta);
        const z     = r * Math.cos(phi);
        if (isLeft  && x > 0) x = -x;
        if (!isLeft && x < 0) x = -x;
        ptPositions[i*3]   = x;
        ptPositions[i*3+1] = y;
        ptPositions[i*3+2] = z;
        ptVelocities[i*3] = ptVelocities[i*3+1] = ptVelocities[i*3+2] = 0;
        ptNoiseTimes[i] = Math.random() * 100;
        ptOutward[i]    = 0;
    }
    if (pointsMesh) {
        pointsMesh.geometry.attributes.position.needsUpdate = true;
        pointsMesh.geometry.attributes.aOutward.needsUpdate  = true;
    }
}

// ─────────────────────────────────────────────────────────────────────
// OVERLAY UPDATE
// ─────────────────────────────────────────────────────────────────────
function updateOverlay(row) {
    const yearEl      = document.getElementById('display-year');
    const agroColEl   = document.getElementById('agro-cumul');
    const monoColEl   = document.getElementById('mono-cumul');
    const agroAnnEl   = document.getElementById('agro-annual');
    const monoAnnEl   = document.getElementById('mono-annual');
    const clearcutEl  = document.getElementById('clearcut-indicator');
    const n2oEl       = document.getElementById('mono-n2o');
    const ch4El       = document.getElementById('mono-ch4');
    const co2El       = document.getElementById('mono-co2');

    if (yearEl) yearEl.innerText = 2026 + row.year;

    // Cumulative values — sign convention: negative = net sequestration (good)
    // We display agro as absolute removal (flip sign), mono as net balance
    if (agroColEl) agroColEl.innerText = Math.abs(Math.round(displayAgroCumul)).toLocaleString() + ' tCO₂e/ha removed';
    if (monoColEl) {
        const val = Math.round(displayMonoCumul);
        monoColEl.innerText = (val >= 0 ? '+' : '') + val.toLocaleString() + ' tCO₂e/ha';
        monoColEl.style.color = val > 0 ? '#0b0b68' : '#dce6ee';
    }

    // Annual rate — color: green = sequestering (negative), red = emitting (positive)
    if (agroAnnEl) {
        const v = displayAgroAnnual.toFixed(1);
        agroAnnEl.innerText = (displayAgroAnnual > 0 ? '+' : '') + v + ' tCO₂e/ha/yr';
        agroAnnEl.style.color = displayAgroAnnual < 0 ? '#dce6ee' : '#0b0b68';
    }
    if (monoAnnEl) {
        const v = displayMonoAnnual.toFixed(1);
        monoAnnEl.innerText = (displayMonoAnnual > 0 ? '+' : '') + v + ' tCO₂e/ha/yr';
        monoAnnEl.style.color = displayMonoAnnual < 0 ? '#dce6ee' : '#0b0b68';
    }

    // Clearcut flash indicator
    if (clearcutEl) {
        clearcutEl.style.opacity = clearcutFlash.toFixed(3);
        clearcutEl.style.display = clearcutFlash > 0.01 ? 'block' : 'none';
    }

    // Gas breakdown — only visible during and shortly after clearcut
    const showGas = clearcutFlash > 0.05;
    if (n2oEl) {
        n2oEl.style.opacity = clearcutFlash.toFixed(3);
        if (showGas) n2oEl.innerText = 'N₂O  +' + row.mono_n2o_flux_tco2e_ha_yr.toFixed(2) + ' tCO₂e/ha/yr';
    }
    if (ch4El) {
        ch4El.style.opacity = clearcutFlash.toFixed(3);
        if (showGas) {
            const cv = row.mono_ch4_flux_tco2e_ha_yr;
            ch4El.innerText = 'CH₄  ' + (cv > 0 ? '+' : '') + cv.toFixed(3) + ' tCO₂e/ha/yr';
        }
    }
    if (co2El) {
        co2El.style.opacity = clearcutFlash.toFixed(3);
        if (showGas) co2El.innerText = 'CO₂  +' + row.mono_co2_flux_tco2e_ha_yr.toFixed(1) + ' tCO₂e/ha/yr';
    }

    // Bottom totals (cumulative × 205,209 ha)
    const agroTotalEl = document.getElementById('agro-total');
    const monoTotalEl = document.getElementById('mono-total');
    if (agroTotalEl) {
        const v = Math.round(displayAgroCumul * HA);
        agroTotalEl.innerText = (v <= 0 ? '−' : '+') + Math.abs(v).toLocaleString() + ' tCO₂e';
        agroTotalEl.style.color = v <= 0 ? '#dce6ee' : '#0b0b68';
    }
    if (monoTotalEl) {
        const v = Math.round(displayMonoCumul * HA);
        monoTotalEl.innerText = (v >= 0 ? '+' : '−') + Math.abs(v).toLocaleString() + ' tCO₂e';
        monoTotalEl.style.color = v > 0 ? '#0b0b68' : '#dce6ee';
    }

    // Scrolling ledger — append one row per year transition
    if (row.year !== lastHistoryYear) {
        lastHistoryYear = row.year;
        appendHistoryRow(row);
    }
}

// ─────────────────────────────────────────────────────────────────────
// SCROLLING LEDGER
// ─────────────────────────────────────────────────────────────────────
function appendHistoryRow(row) {
    const agroTrack = document.getElementById('agro-history');
    const monoTrack = document.getElementById('mono-history');
    if (!agroTrack || !monoTrack) return;

    const agroVal = row.agro_net_annual_tco2e_ha_yr;
    const monoVal = row.mono_net_annual_tco2e_ha_yr;
    const fmt = (v) => String(Math.abs(Math.round(v * HA))).padStart(10, '0') + ' tCO₂e/yr';

    const agroEl = document.createElement('div');
    agroEl.className     = 'history-row';
    agroEl.style.color   = agroVal <= 0 ? '#b4b7ba' : '#b4b7ba';
    agroEl.style.opacity = '0.82';
    agroEl.innerText     = fmt(agroVal);

    const monoEl = document.createElement('div');
    monoEl.className        = 'history-row';
    monoEl.style.color      = monoVal <= 0 ? '#b4b7ba' : '#b4b7ba';
    monoEl.style.opacity    = '0.82';
    monoEl.style.fontWeight = 'normal';
    monoEl.innerText        = fmt(monoVal);

    agroTrack.appendChild(agroEl);
    monoTrack.appendChild(monoEl);
}

// ─────────────────────────────────────────────────────────────────────
// ANIMATION LOOP
// ─────────────────────────────────────────────────────────────────────
function animate() {
    requestAnimationFrame(animate);

    // ── Particle tick ──
    if (pointsMesh) tickParticles();

    // ── Glow uniforms ──
    if (glowMesh) {
        glowMesh.material.uniforms.uTime.value   += 0.016;
        glowMesh.material.uniforms.uDensity.value = leftDensity;
        if (glowMesh._right) {
            glowMesh._right.material.uniforms.uTime.value    += 0.016;
            glowMesh._right.material.uniforms.uDensity.value  = rightDensity;
            // During clearcut flash, tint right glow warm (amber) by passing flash value
            glowMesh._right.material.uniforms.uFlash.value    = clearcutFlash;
        }
    }

    // ── Cyanotype breathe cycle ──
    if (cyanotypeMesh) {
        cyanoTime += 0.016;
        const cyanoVal = 0.5 - 0.5 * Math.cos(cyanoTime * (Math.PI * 2 / 60.0));
        cyanotypeMesh.material.uniforms.uTime.value  += 0.016;
        cyanotypeMesh.material.uniforms.uBlur.value   = cyanoVal;
        cyanotypeMesh.material.uniforms.uCyano.value  = cyanoVal;
    }

    if (orbitControls) orbitControls.update();

    // ── Data-driven year progression ──
    if (dataset.length > 0) {
        yearTimer += 0.016;
        if (yearTimer >= YEAR_DURATION) {
            if (dataYear < 100) {
                dataYear++;
                yearTimer = 0;
            } else {
                resetSimulation();
            }
        }

        const row     = dataset[dataYear];
        const lerpSpeed = 0.04;

        displayMonoCumul  += (row.mono_cumulative_tco2e_ha      - displayMonoCumul)  * lerpSpeed;
        displayAgroCumul  += (row.agro_cumulative_tco2e_ha      - displayAgroCumul)  * lerpSpeed;
        displayMonoAnnual += (row.mono_net_annual_tco2e_ha_yr   - displayMonoAnnual) * lerpSpeed;
        displayAgroAnnual += (row.agro_net_annual_tco2e_ha_yr   - displayAgroAnnual) * lerpSpeed;

        // Edge-detect clearcut year — fires triggerClearcutReset() exactly once
        // per transition into a clearcut year (years 27, 54, 81)
        if (row.is_clearcut_year && !prevRowWasClearcut) {
            triggerClearcutReset();
            isClearcut = true;
        } else if (!row.is_clearcut_year) {
            isClearcut = false;
        }
        prevRowWasClearcut = row.is_clearcut_year;

        // Decay flash (~4s to fade: 1/250 frames at 60fps)
        clearcutFlash = Math.max(0, clearcutFlash - 0.004);

        updateOverlay(row);
    }

    // ── Render ──
    renderer.clear();
    renderer.render(bgScene, bgCamera);
    renderer.clearDepth();
    renderer.render(scene, camera);
}

// ─────────────────────────────────────────────────────────────────────
// GLOW SPRITES
// ─────────────────────────────────────────────────────────────────────
function createGlowSprite() {
    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    const cx = size / 2, cy = size / 2, r = size / 2;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    grad.addColorStop(0.00, 'rgba( 25,  35,  65, 1.0)');
    grad.addColorStop(0.35, 'rgba( 50,  75, 130, 1.0)');
    grad.addColorStop(0.65, 'rgba( 90, 120, 165, 1.0)');
    grad.addColorStop(1.00, 'rgba(130, 155, 190, 1.0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(canvas);
    const geo = new THREE.PlaneGeometry(SPHERE_R * 2, SPHERE_R * 2);

    function makeGlowMat(side, pulseSpeed, densityScale, hasFlash) {
        return new THREE.ShaderMaterial({
            uniforms: {
                uTex:          { value: tex },
                uTime:         { value: 0 },
                uSide:         { value: side },
                uPulseSpeed:   { value: pulseSpeed },
                uDensity:      { value: 0.0 },
                uDensityScale: { value: densityScale },
                uFlash:        { value: 0.0 }  // only used on right hemisphere
            },
            vertexShader: `
                varying vec2 vUv;
                varying float vWorldX;
                void main() {
                    vUv     = uv;
                    vWorldX = position.x;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }`,
            fragmentShader: `
                uniform sampler2D uTex;
                uniform float uTime;
                uniform float uSide;
                uniform float uPulseSpeed;
                uniform float uDensity;
                uniform float uDensityScale;
                uniform float uFlash;
                varying vec2 vUv;
                varying float vWorldX;
                void main() {
                    vec3 color  = texture2D(uTex, vUv).rgb;
                    float pulse = 0.85 + 0.15 * sin(uTime * uPulseSpeed);
                    float tDist = length(vUv - vec2(0.5)) * 2.0;
                    float circleMask = 1.0 - smoothstep(0.92, 1.0, tDist);
                    float baseA = smoothstep(0.75, 1.0, tDist) * 0.22;
                    float coreA = (1.0 - smoothstep(0.0, 0.85, tDist)) * uDensity * uDensityScale;
                    float edge  = uSide < 0.0
                        ? 1.0 - smoothstep(-0.02, 0.02, vWorldX)
                        :       smoothstep(-0.02, 0.02, vWorldX);

                    // Clearcut flash: tint right hemisphere warm amber during emission event
                    vec3 flashCol = mix(color, vec3(0.25, 0.25, 0.28), uFlash * 0.6);
                    color = mix(color, flashCol, uFlash);

                    gl_FragColor = vec4(color, (baseA + coreA) * pulse * edge * circleMask);
                }`,
            transparent: true,
            depthWrite:  false,
            blending:    THREE.NormalBlending,
            side:        THREE.DoubleSide
        });
    }

    // Left = agroforest — faster pulse, no flash
    glowMesh = new THREE.Mesh(geo, makeGlowMat(-1.0, 0.35, 1.25, false));
    glowMesh.position.set(0, 0, 0.05);
    glowMesh.lookAt(camera.position);
    scene.add(glowMesh);
    glowMesh.renderOrder = -1;

    // Right = monoculture — slower pulse, has flash uniform
    const glowMeshR = new THREE.Mesh(geo, makeGlowMat(1.0, 0.22, 1.0, true));
    glowMeshR.position.set(0, 0, 0.05);
    glowMeshR.lookAt(camera.position);
    scene.add(glowMeshR);
    glowMesh._right = glowMeshR;
}

// ─────────────────────────────────────────────────────────────────────
// PARTICLE SYSTEM
// ─────────────────────────────────────────────────────────────────────
function _spawnParticle(i) {
    const isLeft = i < L_COUNT;
    const r = (!isLeft && rightPhase === 0)
        ? SPHERE_R * (0.05 + 0.05 * Math.random())   // burst from center during clearcut
        : SPHERE_R * (0.92 + 0.08 * Math.random());  // outer shell normally
    const theta = Math.random() * Math.PI * 2;
    const phi   = Math.acos(2 * Math.random() - 1);
    let x       = r * Math.sin(phi) * Math.cos(theta);
    const y     = r * Math.sin(phi) * Math.sin(theta);
    const z     = r * Math.cos(phi);
    if (isLeft  && x > 0) x = -x;
    if (!isLeft && x < 0) x = -x;
    ptPositions[i*3]   = x;
    ptPositions[i*3+1] = y;
    ptPositions[i*3+2] = z;
    if (!isLeft && rightPhase === 0) {
        const spd  = 0.007 + Math.random() * 0.006;
        const dist = Math.sqrt(x*x + y*y + z*z) || 0.001;
        ptVelocities[i*3]   = (x / dist) * spd;
        ptVelocities[i*3+1] = (y / dist) * spd;
        ptVelocities[i*3+2] = (z / dist) * spd;
    } else {
        ptVelocities[i*3] = ptVelocities[i*3+1] = ptVelocities[i*3+2] = 0;
    }
}

function createParticleSystem() {
    ptPositions  = new Float32Array(PT_COUNT * 3);
    ptVelocities = new Float32Array(PT_COUNT * 3);
    ptNoiseTimes = new Float32Array(PT_COUNT);
    ptSizes      = new Float32Array(PT_COUNT);
    ptOutward    = new Float32Array(PT_COUNT);

    for (let i = 0; i < PT_COUNT; i++) {
        const isLeft = i < L_COUNT;
        const r     = SPHERE_R * Math.pow(Math.random(), 3.0);
        const theta = Math.random() * Math.PI * 2;
        const phi   = Math.acos(2 * Math.random() - 1);
        let x       = r * Math.sin(phi) * Math.cos(theta);
        const y     = r * Math.sin(phi) * Math.sin(theta);
        const z     = r * Math.cos(phi);
        if (isLeft  && x > 0) x = -x;
        if (!isLeft && x < 0) x = -x;
        ptPositions[i*3]   = x;
        ptPositions[i*3+1] = y;
        ptPositions[i*3+2] = z;
        ptNoiseTimes[i] = Math.random() * 100;
        ptSizes[i]      = 0.02 + Math.random() * 0.01;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(ptPositions, 3));
    geo.setAttribute('aSize',    new THREE.BufferAttribute(ptSizes, 1));
    geo.setAttribute('aOutward', new THREE.BufferAttribute(ptOutward, 1));

    const mat = new THREE.ShaderMaterial({
        uniforms: {
            uViewH:   { value: window.innerHeight },
            uSphereR: { value: SPHERE_R }
        },
        vertexShader: `
            uniform float uViewH;
            uniform float uSphereR;
            attribute float aSize;
            attribute float aOutward;
            varying float vDist;
            varying float vOutward;
            void main() {
                vDist    = clamp(length(position) / uSphereR, 0.0, 1.0);
                vOutward = aOutward;
                vec4 mvPos   = modelViewMatrix * vec4(position, 1.0);
                gl_PointSize = aSize * (uViewH * 0.5 / -mvPos.z);
                gl_Position  = projectionMatrix * mvPos;
            }`,
        fragmentShader: `
            varying float vDist;
            varying float vOutward;
            void main() {
                float d = length(gl_PointCoord - vec2(0.5));
                if (d > 0.5) discard;

                // Cold blue — agroforest / resting monoculture
                vec3 cCore  = vec3(0.03, 0.04, 0.06);
                vec3 cMid   = vec3(0.18, 0.22, 0.34);
                vec3 cOuter = vec3(0.82, 0.88, 1.0);

                // Warm amber/gold — clearcut emission burst (right hemisphere only)
                vec3 wCore  = vec3(0.04, 0.04, 0.05);
                vec3 wMid   = vec3(0.20, 0.20, 0.22);
                vec3 wOuter = vec3(0.50, 0.50, 0.52);

                vec3 col = vDist < 0.5
                    ? mix(cCore, cMid,   vDist * 2.0)
                    : mix(cMid,  cOuter, (vDist - 0.5) * 2.0);
                vec3 warm = vDist < 0.5
                    ? mix(wCore, wMid,   vDist * 2.0)
                    : mix(wMid,  wOuter, (vDist - 0.5) * 2.0);
                col = mix(col, warm, vOutward);

                float alpha = mix(0.08, 0.80, vDist);
                gl_FragColor = vec4(col, alpha);
            }`,
        transparent: true,
        depthWrite:  false,
        blending:    THREE.AdditiveBlending,
    });

    pointsMesh = new THREE.Points(geo, mat);
    scene.add(pointsMesh);
}

function tickParticles() {
    for (let i = 0; i < PT_COUNT; i++) {
        const isLeft = i < L_COUNT;
        const ix = i*3, iy = i*3+1, iz = i*3+2;
        const px = ptPositions[ix], py = ptPositions[iy], pz = ptPositions[iz];
        const dist = Math.sqrt(px*px + py*py + pz*pz) || 0.0001;

        if (dist < 0.1) {
            _spawnParticle(i);
            ptNoiseTimes[i] = Math.random() * 100;
            continue;
        }

        const attrStr    = isLeft ? 0.0005
            : (rightPhase === 0 && dist < SPHERE_R * 0.95 ? -0.00015 : 0.0002);
        const noiseScale = isLeft ? 0.2   : 0.25;
        const noiseStr   = isLeft ? 0.0002 : 0.0002;
        const timeScale  = isLeft ? 0.001  : 0.002;
        const damping    = isLeft ? 0.99   : 0.985;
        const t = ptNoiseTimes[i];

        ptVelocities[ix] += -(px / dist) * attrStr;
        ptVelocities[iy] += -(py / dist) * attrStr;
        ptVelocities[iz] += -(pz / dist) * attrStr;

        ptVelocities[ix] += _simplex(py * noiseScale, pz * noiseScale, t)       * noiseStr;
        ptVelocities[iy] += _simplex(px * noiseScale, pz * noiseScale, t + 50)  * noiseStr;
        ptVelocities[iz] += _simplex(px * noiseScale, py * noiseScale, t + 100) * noiseStr;

        ptVelocities[ix] *= damping;
        ptVelocities[iy] *= damping;
        ptVelocities[iz] *= damping;

        ptPositions[ix] += ptVelocities[ix];
        ptPositions[iy] += ptVelocities[iy];
        ptPositions[iz] += ptVelocities[iz];

        ptNoiseTimes[i] += timeScale;

        if (!isLeft) {
            const radialVel = ptVelocities[ix] * (px / dist)
                            + ptVelocities[iy] * (py / dist)
                            + ptVelocities[iz] * (pz / dist);
            const target = radialVel > 0.0008 ? 1.0 : 0.0;
            ptOutward[i] += (target - ptOutward[i]) * 0.08;
        } else {
            ptOutward[i] = 0.0;
        }
    }

    // Density calculation
    let leftDistSum = 0, rightDistSum = 0;
    for (let i = 0; i < PT_COUNT; i++) {
        const ix = i * 3;
        const d = Math.sqrt(
            ptPositions[ix]   * ptPositions[ix] +
            ptPositions[ix+1] * ptPositions[ix+1] +
            ptPositions[ix+2] * ptPositions[ix+2]
        );
        if (i < L_COUNT) leftDistSum  += d;
        else             rightDistSum += d;
    }
    leftDensityTarget  = 1.0 - Math.min(leftDistSum  / L_COUNT              / SPHERE_R, 1.0);
    rightDensityTarget = 1.0 - Math.min(rightDistSum / (PT_COUNT - L_COUNT) / SPHERE_R, 1.0);

    leftDensity += (leftDensityTarget - leftDensity) * 0.05;
    if (rightFadeFramesLeft > 0) {
        rightDensity = Math.max(0, rightDensity - rightFadeDecrement);
        rightFadeFramesLeft--;
    } else {
        rightDensity += (rightDensityTarget - rightDensity) * 0.05;
    }

    // Right-hemisphere phase management — NO autonomous reset here.
    // Only triggerClearcutReset() (called from animate() on data events) starts a reset.
    rightResetTimer++;
    // End outward phase after ~6 seconds (350 frames), return to inward pull
    if (rightPhase === 0 && rightResetTimer >= 350) {
        rightPhase = 1;
    }
    // Staggered particle respawn during outward phase
    if (rightSpawnFrame > 0) {
        const R_COUNT    = PT_COUNT - L_COUNT;
        const batchStart = L_COUNT + Math.floor((rightSpawnFrame - 1) / 300 * R_COUNT);
        const batchEnd   = L_COUNT + Math.floor(rightSpawnFrame       / 300 * R_COUNT);
        for (let i = batchStart; i < batchEnd; i++) {
            _spawnParticle(i);
            ptNoiseTimes[i] = Math.random() * 100;
        }
        rightSpawnFrame++;
        if (rightSpawnFrame > 270) rightSpawnFrame = 0;
    }

    pointsMesh.geometry.attributes.position.needsUpdate = true;
    pointsMesh.geometry.attributes.aOutward.needsUpdate  = true;
}

// ─────────────────────────────────────────────────────────────────────
// CONCENTRIC RINGS (optional — call createRings() in init() to enable)
// ─────────────────────────────────────────────────────────────────────
function createRings() {
    ringGroup = new THREE.Group();
    ringGroup.renderOrder = 2;
    ringGroup.position.z  = 0;
    ringLabelEls = [];

    const logVals = ALL_RING_VALUES.map(v => Math.sqrt(v));
    const maxLog  = Math.sqrt(ALL_RING_VALUES[ALL_RING_VALUES.length - 1]);

    ALL_RING_VALUES.forEach((val, i) => {
        const r = logVals[i] / maxLog;
        if (r === 0) return;
        const pts = [];
        for (let j = 0; j <= 128; j++) {
            const a = (j / 128) * Math.PI * 2;
            pts.push(new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, 0));
        }
        const geo = new THREE.BufferGeometry().setFromPoints(pts);
        const mat = new THREE.LineBasicMaterial({ color: 0x333333, transparent: true, opacity: 0.12 });
        ringGroup.add(new THREE.Line(geo, mat));
    });

    // Vertical divider line
    const linePts = [new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 1, 0)];
    const lineGeo = new THREE.BufferGeometry().setFromPoints(linePts);
    const lineMat = new THREE.LineDashedMaterial({ color: 0x333333, transparent: true, opacity: 0.65, dashSize: 0.01, gapSize: 0.01 });
    const line = new THREE.Line(lineGeo, lineMat);
    line.computeLineDistances();
    ringGroup.add(line);

    scene.add(ringGroup);

    RING_VALUES.forEach(val => {
        const el = document.createElement('div');
        Object.assign(el.style, { position: 'absolute', color: 'white', fontFamily: 'sans-serif', fontSize: '13px', pointerEvents: 'none', opacity: '0.8', transform: 'translateX(-50%)' });
        el.innerText = String(val);
        document.body.appendChild(el);
        ringLabelEls.push(el);
    });

    updateRingSize();
}

function updateRingSize() {
    if (!ringGroup) return;
    const maxRadius = SPHERE_R;
    ringGroup.scale.set(maxRadius, maxRadius, 1);
    const maxSqrt   = Math.sqrt(ALL_RING_VALUES[ALL_RING_VALUES.length - 1]);
    const outerRadii = RING_VALUES.map((val, i) => {
        const ringVal = ALL_RING_VALUES[i + 1];
        return (Math.sqrt(ringVal) / maxSqrt) * maxRadius;
    });
    RING_VALUES.forEach((val, i) => {
        const r        = outerRadii[i];
        const worldPos = new THREE.Vector3(0, -r, ringGroup.position.z);
        worldPos.project(camera);
        const sx = (worldPos.x  * 0.5 + 0.5) * window.innerWidth;
        const sy = (-worldPos.y * 0.5 + 0.5) * window.innerHeight;
        ringLabelEls[i].style.left = sx + 'px';
        ringLabelEls[i].style.top  = (sy + 6) + 'px';
    });
}

// ─────────────────────────────────────────────────────────────────────
// CYANOTYPE OVERLAY
// ─────────────────────────────────────────────────────────────────────
function createCyanotypeOverlay() {
    const tex = new THREE.TextureLoader().load('data/background_1.png');
    const mat = new THREE.ShaderMaterial({
        uniforms: {
            uTex:   { value: tex },
            uTime:  { value: 0.0 },
            uBlur:  { value: 0.0 },
            uCyano: { value: 0.0 }
        },
        vertexShader: `
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }`,
        fragmentShader: `
            uniform sampler2D uTex;
            uniform float uTime;
            uniform float uBlur;
            uniform float uCyano;
            varying vec2 vUv;
            float rand(vec2 co) { return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453); }
            void main() {
                float blurScale = 0.3 + uBlur * 4.2;
                float r1 = 0.008 * blurScale;
                float r2 = 0.018 * blurScale;
                float r3 = 0.030 * blurScale;
                vec4 texSample =
                    texture2D(uTex, vUv)                           * 0.25
                  + texture2D(uTex, vUv + vec2( r1,  0.0))        * 0.10
                  + texture2D(uTex, vUv + vec2(-r1,  0.0))        * 0.10
                  + texture2D(uTex, vUv + vec2( 0.0,  r1))        * 0.10
                  + texture2D(uTex, vUv + vec2( 0.0, -r1))        * 0.10
                  + texture2D(uTex, vUv + vec2( r2,  r2) * 0.707) * 0.06
                  + texture2D(uTex, vUv + vec2(-r2,  r2) * 0.707) * 0.06
                  + texture2D(uTex, vUv + vec2( r2, -r2) * 0.707) * 0.06
                  + texture2D(uTex, vUv + vec2(-r2, -r2) * 0.707) * 0.06
                  + texture2D(uTex, vUv + vec2( r3,  0.0))        * 0.025
                  + texture2D(uTex, vUv + vec2(-r3,  0.0))        * 0.025
                  + texture2D(uTex, vUv + vec2( 0.0,  r3))        * 0.025
                  + texture2D(uTex, vUv + vec2( 0.0, -r3))        * 0.025;
                float lum = dot(texSample.rgb, vec3(0.299, 0.587, 0.114));
                vec3 shadow  = vec3(0.04, 0.08, 0.22);
                vec3 midtone = vec3(0.22, 0.35, 0.62);
                vec3 hilite  = vec3(0.86, 0.90, 1.00);
                vec3 cyano = lum < 0.4
                    ? mix(shadow,  midtone, lum * 2.0)
                    : mix(midtone, hilite,  (lum - 0.5) * 2.0);
                float cyanoStr = 0.15 + uCyano * 0.85;
                vec3 col = mix(texSample.rgb, cyano, cyanoStr);
                float grain = rand(vUv + fract(uTime * 0.01)) * 2.0 - 1.0;
                col += grain * (0.02 + uCyano * 0.06);
                float brightMask = smoothstep(0.55, 1.0, lum);
                vec3 screen = 1.0 - (1.0 - col) * (1.0 - hilite * brightMask);
                col = mix(col, screen, brightMask * 0.9);
                float vignette = smoothstep(0.35, 0.85, length(vUv - vec2(0.5)) * 1.5);
                col = mix(col, shadow, vignette * (0.3 + uCyano * 0.55));
                float greenSurplus = clamp((texSample.g - max(texSample.r, texSample.b)) * 6.0, 0.0, 1.0);
                col = mix(col, texSample.rgb * vec3(0.55, 0.95, 0.55), greenSurplus * (1.0 - uCyano) * 0.59);
                gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
            }`,
        transparent: false,
        depthWrite:  false,
        side: THREE.DoubleSide
    });
    cyanotypeMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    cyanotypeMesh.position.z = -1.99;
    bgScene.add(cyanotypeMesh);

    const veilMat = new THREE.MeshBasicMaterial({ color: 0xe8eef5, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide });
    veilMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), veilMat);
    veilMesh.position.z = -1.98;
    bgScene.add(veilMesh);
}

// ─────────────────────────────────────────────────────────────────────
// RESIZE
// ─────────────────────────────────────────────────────────────────────
function updateBgSize() {
    const dist          = bgCamera.position.z - bgMesh.position.z;
    const fovRad        = THREE.MathUtils.degToRad(bgCamera.fov);
    const frustumHeight = 2 * Math.tan(fovRad / 2) * dist;
    const frustumWidth  = frustumHeight * (window.innerWidth / window.innerHeight);
    const imageAspect   = 16 / 9;
    let w, h;
    if (frustumWidth / frustumHeight > imageAspect) { w = frustumWidth;  h = frustumWidth / imageAspect; }
    else                                             { h = frustumHeight; w = frustumHeight * imageAspect; }
    bgMesh.scale.set(w, h, 1);
    if (cyanotypeMesh) cyanotypeMesh.scale.copy(bgMesh.scale);
    if (veilMesh)      veilMesh.scale.copy(bgMesh.scale);
    updateRingSize();
}

window.addEventListener('resize', () => {
    camera.aspect   = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    bgCamera.aspect = window.innerWidth / window.innerHeight;
    bgCamera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    if (pointsMesh) pointsMesh.material.uniforms.uViewH.value = window.innerHeight;
    updateBgSize();
});

init();