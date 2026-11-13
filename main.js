/*
 * Cube Assembly Portrait
 * ----------------------
 * Thousands of glossy red cubes rest in a heap, then fly together into a
 * 3D relief of a photo. Built on three.js r128 (global build, no bundler).
 *
 * File map (search for the banner comments):
 *   constants & state      tunable numbers and the playback state
 *   renderer / scene       WebGL renderer, camera, orbit controls, bloom + FXAA
 *   cube material          the vertex shader moves every cube; the fragment shader paints it
 *   floor and backdrop     wet floor with red spill, hazy sky sphere
 *   energy arcs            short red lightning segments, rebuilt ~16 times a second
 *   portrait source        sample face + loading the user's photo
 *   build cubes            photo (+ optional depth map) -> which cubes join the figure, their colour,
 *                          height, start and target positions
 *   CPU mirror             the same flight path in JS, used only to place arcs
 *   sizing / controls      resize, buttons, sliders, drag and drop
 *   frame loop             advances the timeline and renders
 *
 * See README.md for the full walkthrough.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var canvas = $('stage');

  function fail(msg) {
    var d = document.createElement('div');
    d.className = 'fail';
    d.textContent = msg;
    document.body.appendChild(d);
  }
  if (!window.THREE) { fail('The 3D library did not load. Check your connection and reload the page.'); return; }

  /* ---------- constants & state ---------- */
  var FACE_H = 10;            // portrait height in world units
  var ASPECT = 1.25;          // rows / cols  (4:5 portrait)
  var BASE_DURATION = 8;      // seconds for a full assembly at speed 1
  var PILE_R = 13;             // radius of the heap of cubes on the floor
  var STAGGER = 1.6;          // how spread out individual cube launches are
  var isSmall = Math.min(window.innerWidth, window.innerHeight) < 620;
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var state = {
    cols: isSmall ? 84 : 120,
    progress: reduceMotion ? 1 : 0,
    dir: 0,                   // 1 assembling, -1 scattering, 0 paused
    holdUntil: reduceMotion ? Infinity : 1.2,   // auto-start after this many seconds
    speed: 1, glow: 1, depth: 2.2, cutout: true
  };

  /* ---------- renderer / scene ---------- */
  var renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: false, powerPreference: 'high-performance' });
  } catch (e) {
    fail('This browser could not start WebGL, which the cubes need. Try a recent version of Chrome, Firefox, Safari or Edge.');
    return;
  }
  var DPR = Math.min(window.devicePixelRatio || 1, isSmall ? 1.5 : 2);
  renderer.setPixelRatio(DPR);
  renderer.setClearColor(0x211b17, 1);

  var scene = new THREE.Scene();
  var camera = new THREE.PerspectiveCamera(38, 1, 0.1, 400);
  camera.position.set(0, 1.6, 30);
  var group = new THREE.Group();
  scene.add(group);

  var controls = null, userCam = false, fitDist = 30;
  if (THREE.OrbitControls) {
    controls = new THREE.OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = false;
    controls.minDistance = 8;
    controls.maxDistance = 70;
    controls.maxPolarAngle = Math.PI / 2 + 0.1;   // stay above the floor
    controls.minAzimuthAngle = -1.75; controls.maxAzimuthAngle = 1.75;   // the figure is a relief: keep off its flat back
    controls.target.set(0, -0.4, 0);
    controls.addEventListener('start', function () { userCam = true; });
  }

  var composer = null, bloom = null, fxaa = null;
  if (THREE.EffectComposer && THREE.RenderPass && THREE.UnrealBloomPass) {
    composer = new THREE.EffectComposer(renderer);
    composer.addPass(new THREE.RenderPass(scene, camera));
    bloom = new THREE.UnrealBloomPass(new THREE.Vector2(256, 256), 1.0, 0.55, 0.3);
    composer.addPass(bloom);
    if (THREE.FXAAShader && THREE.ShaderPass) { fxaa = new THREE.ShaderPass(THREE.FXAAShader); composer.addPass(fxaa); }
  }

  /* ---------- cube material: all motion runs on the GPU ---------- */
  var uniforms = {
    uProgress: { value: 0 }, uTime: { value: 0 }, uCube: { value: 0.1 },
    uDepth: { value: state.depth }, uStagger: { value: STAGGER },
    uGlow: { value: 1 }, uSettle: { value: 0 }
  };

  var material = new THREE.ShaderMaterial({
    uniforms: uniforms,
    extensions: { derivatives: true },
    vertexShader: [
      'attribute vec3 aStart;',      // resting place on the floor
      'attribute vec3 aTarget;',     // xy = grid position, z = brightness - 0.5
      'attribute vec4 aColor;',      // rgb = photo colour, a = how deep in the pile
      'attribute vec4 aSeed;',       // x = launch delay, yzw = random
      'uniform float uProgress, uTime, uCube, uDepth, uStagger;',
      'varying vec3 vColor, vLocal, vViewW;',
      'varying mat3 vRot;',
      'varying float vT, vSeed, vTint, vWy, vDeep;',
      'float ease(float t){ return t*t*t*(t*(6.0*t-15.0)+10.0); }',
      'mat3 rot(vec3 a, float ang){',
      '  float s = sin(ang), c = cos(ang), o = 1.0 - c;',
      '  return mat3(o*a.x*a.x+c,     o*a.x*a.y+a.z*s, o*a.z*a.x-a.y*s,',
      '              o*a.x*a.y-a.z*s, o*a.y*a.y+c,     o*a.y*a.z+a.x*s,',
      '              o*a.z*a.x+a.y*s, o*a.y*a.z-a.x*s, o*a.z*a.z+c);',
      '}',
      'void main(){',
      '  float t = clamp(uProgress*(1.0+uStagger) - aSeed.x*uStagger, 0.0, 1.0);',
      '  float e = ease(t);',                          // slide across the floor
      '  float ey = ease(smoothstep(0.22, 1.0, t));',  // then climb
      '  float free = 1.0 - e;',
      '  float lock = smoothstep(0.9, 1.0, t);',
      // lie still at a random angle on the floor, tumble in the air, square up on arrival
      '  vec3 rAxis = normalize(vec3(aSeed.y, aSeed.z, aSeed.w) - 0.5 + 1e-4);',
      '  vec3 restAxis = normalize(mix(vec3(0.0, 1.0, 0.0), rAxis, aColor.a));',
      '  mat3 R = rot(restAxis, (1.0 - ey) * 6.2831 * aSeed.w) * rot(rAxis, 6.2831 * (1.0 + floor(aSeed.y*2.0)) * ey);',
      // once locked, extend each cube backwards into a column so the relief is solid
      '  vec3 lp = position;',
      '  float jz = (aSeed.w - 0.5) * uCube * 0.7;',   // each cube sits a little proud or shy of its neighbours
      '  if (lp.z < 0.0) lp.z -= lock * ((aTarget.z + 0.5) * uDepth + jz + 0.35*uCube) / uCube;',
      '  vDeep = 0.5 - lp.z;',                          // how far down the column, in cube widths
      '  float s = uCube * mix(2.3 + 0.9*aSeed.z, 1.0, ey);',
      '  vec3 p = R * (lp * s);',
      '  vec3 tgt = vec3(aTarget.xy, aTarget.z * uDepth + jz);',
      '  vec3 c;',
      '  c.xz = mix(aStart.xz, tgt.xz, e);',
      '  c.y = mix(aStart.y, tgt.y, ey);',
      '  float sw = free * (1.4 + aSeed.y*1.4);',
      '  float cs = cos(sw), sn = sin(sw);',
      '  c.xz = vec2(cs*c.x + sn*c.z, -sn*c.x + cs*c.z);',
      '  c += sin(3.14159*ey) * 0.35 * vec3(sin(uTime*0.7 + aSeed.x*40.0), cos(uTime*0.6 + aSeed.y*40.0), sin(uTime*0.5 + aSeed.z*40.0));',
      '  vec4 wp = modelMatrix * vec4(c + p, 1.0);',
      '  gl_Position = projectionMatrix * viewMatrix * wp;',
      '  vColor = aColor.rgb; vLocal = position; vT = t; vSeed = aSeed.w; vTint = aSeed.z;',
      '  vRot = mat3(modelMatrix) * R;',
      '  vViewW = cameraPosition - wp.xyz;',
      '  vWy = wp.y;',
      '}'
    ].join('\n'),
    fragmentShader: [
      'uniform float uTime, uGlow, uSettle;',
      'varying vec3 vColor, vLocal, vViewW;',
      'varying mat3 vRot;',
      'varying float vT, vSeed, vTint, vWy, vDeep;',
      'float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }',
      // circuit-board traces: straight runs, corners and pads on a 4x4 grid per face
      'float traces(vec2 uv, float seed){',
      '  vec2 g = uv * 4.0; vec2 id = floor(g); vec2 f = fract(g) - 0.5;',
      '  float h = hash(id + seed * 31.7);',
      '  float w = 0.09;',
      '  float lh = 1.0 - smoothstep(w*0.5, w, abs(f.y));',
      '  float lv = 1.0 - smoothstep(w*0.5, w, abs(f.x));',
      '  float d = 0.0;',
      '  if (h < 0.28) d = lh;',
      '  else if (h < 0.52) d = lv;',
      '  else if (h < 0.68) d = max(lh * step(f.x, w), lv * step(f.y, w));',
      '  else if (h < 0.78) { float b = max(abs(f.x), abs(f.y)); d = (1.0 - smoothstep(0.2, 0.26, b)) * smoothstep(0.1, 0.16, b); }',
      '  return d;',
      '}',
      // a small studio to reflect: pale overcast sky, one hot key light, warm horizon, red floor glow
      'vec3 env(vec3 r){',
      '  vec3 sky = vec3(0.60, 0.55, 0.60) * smoothstep(-0.05, 0.55, r.y);',
      '  float key = pow(max(dot(r, normalize(vec3(0.25, 0.75, -0.6))), 0.0), 24.0);',
      '  vec3 hor = vec3(0.16, 0.12, 0.10) * (1.0 - smoothstep(0.0, 0.5, abs(r.y)));',
      '  vec3 under = vec3(0.55, 0.04, 0.02) * smoothstep(0.0, -0.7, r.y) * uGlow * (1.0 - 0.8*uSettle);',
      '  return sky + key * vec3(1.4, 1.3, 1.35) + hor + under;',
      '}',
      'void main(){',
      '  vec3 a = abs(vLocal);',
      // bevelled corners: bend the normal toward the neighbouring face near each edge
      '  float px = fwidth(vLocal.x) + fwidth(vLocal.y) + fwidth(vLocal.z);',
      '  float far = smoothstep(0.03, 0.15, px);',
      '  vec3 nl = normalize(sign(vLocal) * pow(a * 2.0, vec3(mix(12.0, 60.0, far))));',
      '  vec3 n = normalize(vRot * nl);',
      '  vec3 v = normalize(vViewW);',
      '  float ndv = max(dot(n, v), 0.0);',
      '  float F = 0.06 + 0.94 * pow(1.0 - ndv, 5.0);',
      '  vec3 refl = env(reflect(-v, n));',
      '  vec2 uv; float fid;',
      '  if (a.x > a.y && a.x > a.z) { uv = vLocal.yz; fid = 1.0 + step(0.0, vLocal.x); }',
      '  else if (a.y > a.z) { uv = vLocal.xz; fid = 3.0 + step(0.0, vLocal.y); }',
      '  else { uv = vLocal.xy; fid = 5.0 + step(0.0, vLocal.z); }',
      '  uv += 0.5;',
      '  float tr = mix(traces(uv, vSeed * 7.0 + fid), 0.22, far);',
      '  float flow = 0.65 + 0.35 * sin(uTime*3.0 + (uv.x + uv.y)*5.0 + vSeed*40.0);',
      '  float breathe = 0.75 + 0.25 * sin(uTime*1.3 + vSeed*60.0);',
      '  float charge = (0.55 + 0.9 * smoothstep(0.0, 0.3, vT)) * (1.0 - 0.5*uSettle);',   // cubes left on the floor calm down at the end
      '  float mid = a.x + a.y + a.z - max(a.x, max(a.y, a.z)) - min(a.x, min(a.y, a.z));',
      '  float edge = smoothstep(0.40, 0.49, mid);',
      // red glass body, lit from inside
      '  vec3 glass = mix(vec3(0.02, 0.004, 0.006), vec3(0.42, 0.02, 0.02), 0.2 + 0.8*vTint);',
      '  glass *= (0.35 + 0.65*ndv) * breathe * (0.4 + 0.6*uGlow);',
      '  vec3 red = vec3(1.0, 0.16, 0.06);',
      '  vec3 hot = vec3(1.0, 0.72, 0.55);',
      '  vec3 emis = mix(red, hot, tr*0.6) * tr * flow * charge * uGlow * 1.1;',
      '  vec3 energized = glass + emis + red * edge * 0.25 * uGlow * charge + refl * (F + 0.05);',
      // the portrait: true photo colour with only a trace of gloss
      '  float amb = mix(0.55, 0.85, far);',
      '  float shade = amb + (1.0 - amb) * max(dot(n, normalize(vec3(0.12, 0.2, 1.0))), 0.0);',
      '  vec3 photo = vColor * shade + refl * F * 0.10;',
      // the photo wraps a little way down each column so the face survives a turn of the head;
      // deeper down (the outline of the figure) the columns are dark glass with a few live traces
      '  float front = step(5.5, fid);',
      '  float deep = smoothstep(1.2, 3.5, vDeep) * (1.0 - front);',
      '  vec3 sideCol = vColor * 0.16 + glass * 0.45 + red * tr * 0.22 * uGlow + refl * F * 0.35;',
      '  photo = mix(photo * mix(0.82, 1.0, front), sideCol, deep);',
      // until the whole face has settled, locked cubes stay dim and ember-tinted
      '  photo *= mix(vec3(0.46, 0.20, 0.17), vec3(1.0), uSettle);',
      // afterglow: every few seconds a band of red energy climbs the finished figure
      '  float band = exp(-pow((vWy - (mod(uTime * 2.6, 34.0) - 9.0)) / 0.55, 2.0));',
      '  photo += red * band * uSettle * uGlow * (0.10 + 0.9*max(tr, edge));',
      '  float lock = smoothstep(0.9, 1.0, vT);',
      '  float flash = smoothstep(0.78, 0.92, vT) * (1.0 - smoothstep(0.92, 1.0, vT));',
      '  vec3 col = mix(energized, photo, lock) + red * flash * uGlow * (0.3 + 0.7*max(tr, edge));',
      '  float fog = smoothstep(30.0, 95.0, length(vViewW));',
      '  col = mix(col, vec3(0.13, 0.105, 0.09), fog);',
      '  gl_FragColor = vec4(col, 1.0);',
      '}'
    ].join('\n')
  });

  /* ---------- floor and backdrop ---------- */
  var FLOOR_Y = -FACE_H / 2 - 0.05;   // the bust rises straight out of the heap
  var floorUniforms = { uEnergy: { value: 1 } };
  var floorMesh = new THREE.Mesh(new THREE.CircleGeometry(140, 48), new THREE.ShaderMaterial({
    uniforms: floorUniforms,
    vertexShader: [
      'varying vec3 vW;',
      'void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }'
    ].join('\n'),
    fragmentShader: [
      'uniform float uEnergy;',
      'varying vec3 vW;',
      'float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }',
      'void main(){',
      '  float d = length(vW.xz);',
      '  vec3 v = normalize(cameraPosition - vW);',
      '  float F = pow(1.0 - max(v.y, 0.0), 4.0);',
      '  float grit = mix(hash(floor(vW.xz * 28.0)), 0.5, smoothstep(6.0, 22.0, length(cameraPosition - vW)));',
      '  vec3 col = vec3(0.016, 0.016, 0.019) + vec3(0.03) * grit;',
      '  col += vec3(0.5, 0.045, 0.02) * uEnergy * exp(-d*d / 110.0) * (0.55 + 0.45*grit);',  // red spill under the pile
      '  col += vec3(0.30, 0.27, 0.29) * F * (0.35 + 0.65*step(0.9, grit));',                 // wet sheen
      '  col = mix(col, vec3(0.13, 0.105, 0.09), smoothstep(12.0, 70.0, d));',
      '  gl_FragColor = vec4(col, 1.0);',
      '}'
    ].join('\n')
  }));
  floorMesh.rotation.x = -Math.PI / 2;
  floorMesh.position.y = FLOOR_Y;
  group.add(floorMesh);

  var backdrop = new THREE.Mesh(new THREE.SphereGeometry(180, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    vertexShader: 'varying vec3 vD; void main(){ vD = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: [
      'varying vec3 vD;',
      'void main(){',
      '  vec3 d = normalize(vD);',
      '  vec3 col = mix(vec3(0.13, 0.105, 0.09), vec3(0.018, 0.018, 0.022), smoothstep(0.0, 0.5, abs(d.y)));',
      '  col += vec3(0.20, 0.18, 0.19) * pow(max(dot(d, normalize(vec3(0.25, 0.42, -1.0))), 0.0), 10.0);',
      '  gl_FragColor = vec4(col, 1.0);',
      '}'
    ].join('\n')
  }));
  backdrop.renderOrder = -1;
  scene.add(backdrop);

  /* ---------- energy arcs ---------- */
  var ARCS = 26, ARC_SEG = 8;
  var arcPos = new Float32Array(ARCS * ARC_SEG * 2 * 3);
  var arcGeo = new THREE.BufferGeometry();
  arcGeo.setAttribute('position', new THREE.BufferAttribute(arcPos, 3));
  var arcMat = new THREE.LineBasicMaterial({
    color: 0xff3a1c, transparent: true, opacity: 0.9,
    blending: THREE.AdditiveBlending, depthWrite: false
  });
  var arcs = new THREE.LineSegments(arcGeo, arcMat);
  arcs.frustumCulled = false;
  group.add(arcs);

  /* ---------- portrait source ---------- */
  var source = document.createElement('canvas');   // current photo, capped in size
  var sampler = document.createElement('canvas');  // downsampled to the cube grid
  var sctx = sampler.getContext('2d', { willReadFrequently: true });

  function drawSampleFace() {
    source.width = 480; source.height = 600;
    var g = source.getContext('2d');
    var gr = g.createRadialGradient(240, 250, 40, 240, 300, 430);
    gr.addColorStop(0, '#42606d'); gr.addColorStop(1, '#0b1115');
    g.fillStyle = gr; g.fillRect(0, 0, 480, 600);
    // shoulders
    g.fillStyle = '#1e2733';
    g.beginPath(); g.ellipse(240, 650, 255, 180, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#2b3746';
    g.beginPath(); g.ellipse(240, 640, 120, 150, 0, Math.PI, Math.PI * 2); g.fill();
    // neck
    g.fillStyle = '#b07a5c'; g.fillRect(194, 400, 92, 120);
    g.fillStyle = 'rgba(55, 28, 18, 0.5)';
    g.beginPath(); g.ellipse(240, 438, 62, 30, 0, 0, Math.PI * 2); g.fill();
    // head
    gr = g.createRadialGradient(212, 250, 20, 240, 290, 195);
    gr.addColorStop(0, '#f3caa6'); gr.addColorStop(0.6, '#cf9772'); gr.addColorStop(1, '#8b5b41');
    g.fillStyle = gr;
    g.beginPath(); g.ellipse(240, 290, 124, 160, 0, 0, Math.PI * 2); g.fill();
    // hair
    g.fillStyle = '#16100e';
    g.beginPath();
    g.moveTo(112, 285);
    g.bezierCurveTo(96, 150, 170, 100, 245, 104);
    g.bezierCurveTo(330, 100, 384, 160, 368, 285);
    g.bezierCurveTo(356, 215, 322, 192, 262, 196);
    g.bezierCurveTo(196, 186, 136, 206, 112, 285);
    g.fill();
    // brows
    g.strokeStyle = '#2a1a14'; g.lineWidth = 9; g.lineCap = 'round';
    g.beginPath(); g.moveTo(170, 262); g.quadraticCurveTo(195, 250, 220, 260); g.stroke();
    g.beginPath(); g.moveTo(262, 260); g.quadraticCurveTo(288, 250, 312, 262); g.stroke();
    // eyes
    [[196, 286], [286, 286]].forEach(function (p) {
      g.fillStyle = '#f4efe9'; g.beginPath(); g.ellipse(p[0], p[1], 22, 11, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#3a2a22'; g.beginPath(); g.arc(p[0], p[1], 10, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#0c0807'; g.beginPath(); g.arc(p[0], p[1], 5, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#ffffff'; g.beginPath(); g.arc(p[0] - 3, p[1] - 3, 2.2, 0, Math.PI * 2); g.fill();
    });
    // nose
    g.fillStyle = 'rgba(120, 70, 48, 0.55)';
    g.beginPath(); g.moveTo(248, 292); g.quadraticCurveTo(270, 345, 258, 356); g.quadraticCurveTo(240, 364, 222, 354);
    g.quadraticCurveTo(240, 350, 248, 292); g.fill();
    g.fillStyle = 'rgba(255, 232, 210, 0.55)';
    g.beginPath(); g.ellipse(236, 322, 7, 30, 0, 0, Math.PI * 2); g.fill();
    // mouth
    g.fillStyle = '#9c4a44';
    g.beginPath(); g.moveTo(202, 394); g.quadraticCurveTo(240, 384, 278, 394); g.quadraticCurveTo(240, 420, 202, 394); g.fill();
    g.strokeStyle = 'rgba(70, 24, 22, 0.8)'; g.lineWidth = 2.5;
    g.beginPath(); g.moveTo(202, 394); g.quadraticCurveTo(240, 400, 278, 394); g.stroke();
    // cheek light
    g.fillStyle = 'rgba(255, 240, 225, 0.22)';
    g.beginPath(); g.ellipse(184, 330, 26, 34, 0, 0, Math.PI * 2); g.fill();
  }

  function setSource(drawable, w, h) {
    var k = Math.min(1, 1024 / Math.max(w, h));
    source.width = Math.max(1, Math.round(w * k));
    source.height = Math.max(1, Math.round(h * k));
    source.getContext('2d').drawImage(drawable, 0, 0, source.width, source.height);
  }

  /* ---------- build cubes from the photo ---------- */
  var mesh = null, starts, targets, seeds, count = 0, cubeSize = 0.1;

  var depthSrc = null;                                  // optional depth map (white = near, alpha = person)
  var sampler2 = document.createElement('canvas');
  var sctx2 = sampler2.getContext('2d', { willReadFrequently: true });

  // centre-crop to the grid's 4:5 shape, biased toward the top, one pixel per cube
  function coverCrop(cv, ctx, src, cols, rows) {
    cv.width = cols; cv.height = rows;
    var sw = src.width, sh = src.height, cw, ch;
    if (sw / sh > cols / rows) { ch = sh; cw = sh * cols / rows; } else { cw = sw; ch = sw * rows / cols; }
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, (sw - cw) / 2, (sh - ch) * 0.35, cw, ch, 0, 0, cols, rows);
    return ctx.getImageData(0, 0, cols, rows).data;
  }

  function blur3(a, cols, rows) {
    var out = new Float32Array(a.length), x, y, dx, dy;
    for (y = 0; y < rows; y++) for (x = 0; x < cols; x++) {
      var sum = 0, wsum = 0;
      for (dy = -1; dy <= 1; dy++) for (dx = -1; dx <= 1; dx++) {
        var xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= cols || yy >= rows) continue;
        var w = (dx === 0 && dy === 0) ? 2 : 1;
        sum += a[yy * cols + xx] * w; wsum += w;
      }
      out[y * cols + x] = sum / wsum;
    }
    return out;
  }

  // background removal without a depth map: flood in from the frame over anything close to the backdrop colour
  function floodMask(px, cols, rows, mask) {
    var n = cols * rows, bg = [0, 0, 0], i, x, y;
    [0, 1, cols - 2, cols - 1, cols, 2 * cols - 1].forEach(function (k) {
      bg[0] += px[k * 4] / 6; bg[1] += px[k * 4 + 1] / 6; bg[2] += px[k * 4 + 2] / 6;
    });
    var seen = new Uint8Array(n), stack = [], filled = 0;
    function push(k) {
      if (seen[k]) return;
      var d = Math.max(Math.abs(px[k * 4] - bg[0]), Math.abs(px[k * 4 + 1] - bg[1]), Math.abs(px[k * 4 + 2] - bg[2]));
      if (d < 30) { seen[k] = 1; stack.push(k); }
    }
    for (x = 0; x < cols; x++) push(x);
    var lim = Math.floor(rows * 0.7);
    for (y = 0; y < lim; y++) { push(y * cols); push(y * cols + cols - 1); }
    while (stack.length) {
      i = stack.pop(); filled++; x = i % cols; y = (i - x) / cols;
      if (x > 0) push(i - 1); if (x < cols - 1) push(i + 1);
      if (y > 0) push(i - cols); if (y < rows - 1) push(i + cols);
    }
    if (filled < n * 0.06 || filled > n * 0.9) return false;   // no plain backdrop found
    for (i = 0; i < n; i++) mask[i] = seen[i] ? 0 : 1;
    return true;
  }

  // depth without a depth map: puff the silhouette up into a rounded bust, plus a little photo detail
  function inflate(mask, luma, cols, rows) {
    var n = cols * rows, d = new Float32Array(n), i, x, y, v;
    for (i = 0; i < n; i++) d[i] = mask[i] ? 1e6 : 0;
    for (y = 0; y < rows; y++) for (x = 0; x < cols; x++) {
      i = y * cols + x; v = d[i]; if (!v) continue;
      if (x > 0) v = Math.min(v, d[i - 1] + 1);
      if (y > 0) {
        v = Math.min(v, d[i - cols] + 1);
        if (x > 0) v = Math.min(v, d[i - cols - 1] + 1.414);
        if (x < cols - 1) v = Math.min(v, d[i - cols + 1] + 1.414);
      }
      d[i] = v;
    }
    for (y = rows - 1; y >= 0; y--) for (x = cols - 1; x >= 0; x--) {
      i = y * cols + x; v = d[i]; if (!v) continue;
      if (x < cols - 1) v = Math.min(v, d[i + 1] + 1);
      if (y < rows - 1) {
        v = Math.min(v, d[i + cols] + 1);
        if (x > 0) v = Math.min(v, d[i + cols - 1] + 1.414);
        if (x < cols - 1) v = Math.min(v, d[i + cols + 1] + 1.414);
      }
      d[i] = v;
    }
    var R = cols * 0.17, out = new Float32Array(n);
    for (i = 0; i < n; i++) {
      var u = Math.min(1, d[i] / R);
      out[i] = mask[i] ? 0.85 * Math.sqrt(u * (2 - u)) + 0.15 * luma[i] : 0;
    }
    return blur3(blur3(out, cols, rows), cols, rows);
  }

  // decide which cubes belong to the figure and how far forward each one sits (0..1)
  function analyse(px, cols, rows) {
    var n = cols * rows, i, lo = 1, hi = 0;
    var luma = new Float32Array(n), mask = new Uint8Array(n), height = null, haveMask = false;
    for (i = 0; i < n; i++) {
      luma[i] = (0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]) / 255;
      if (luma[i] < lo) lo = luma[i]; if (luma[i] > hi) hi = luma[i];
    }
    var span = Math.max(hi - lo, 0.05);
    for (i = 0; i < n; i++) luma[i] = (luma[i] - lo) / span;

    if (depthSrc) {
      var dp = coverCrop(sampler2, sctx2, depthSrc, cols, rows), opaque = true;
      height = new Float32Array(n);
      for (i = 0; i < n; i++) { height[i] = dp[i * 4] / 255; if (dp[i * 4 + 3] < 250) opaque = false; }
      if (!opaque) { for (i = 0; i < n; i++) mask[i] = dp[i * 4 + 3] > 127 ? 1 : 0; haveMask = true; }
    }
    if (!haveMask && state.cutout) haveMask = floodMask(px, cols, rows, mask);
    if (!haveMask) for (i = 0; i < n; i++) mask[i] = 1;
    if (!height) height = haveMask ? inflate(mask, luma, cols, rows) : blur3(luma, cols, rows);
    return { height: height, mask: mask };
  }

  function build() {
    var cols = state.cols, rows = Math.round(cols * ASPECT);
    count = cols * rows;
    cubeSize = FACE_H / rows;

    var px = coverCrop(sampler, sctx, source, cols, rows);
    var shape = analyse(px, cols, rows), height = shape.height, mask = shape.mask;

    starts = new Float32Array(count * 3);
    targets = new Float32Array(count * 3);
    seeds = new Float32Array(count * 4);
    var colors = new Float32Array(count * 4);
    var halfW = (cols - 1) / 2, halfH = (rows - 1) / 2, i, x, y, inFigure = 0;

    for (y = 0; y < rows; y++) {
      for (x = 0; x < cols; x++) {
        i = y * cols + x;
        var tx = (x - halfW) * cubeSize, ty = (halfH - y) * cubeSize;
        targets[i * 3] = tx; targets[i * 3 + 1] = ty; targets[i * 3 + 2] = height[i] - 0.5;

        seeds[i * 4 + 1] = Math.random(); seeds[i * 4 + 2] = Math.random(); seeds[i * 4 + 3] = Math.random();

        // resting place: a low heap on the floor, densest and tallest in the middle
        var th = Math.random() * Math.PI * 2;
        var r = PILE_R * Math.pow(Math.random(), 0.72);
        var half = cubeSize * (2.3 + 0.9 * seeds[i * 4 + 2]) * 0.5;
        var mound = Math.pow(Math.max(0, 1 - r / PILE_R), 2) * 2.2;
        var lift = Math.random() * mound;
        starts[i * 3] = r * Math.cos(th);
        starts[i * 3 + 1] = FLOOR_Y + half + lift;
        starts[i * 3 + 2] = r * Math.sin(th);

        colors[i * 4] = px[i * 4] / 255; colors[i * 4 + 1] = px[i * 4 + 1] / 255; colors[i * 4 + 2] = px[i * 4 + 2] / 255;
        colors[i * 4 + 3] = Math.min(1, lift / (cubeSize * 3));

        if (mask[i]) {
          // launch order: centre of the figure first, edges last, with some randomness
          var d = Math.min(1, Math.sqrt(tx * tx + ty * ty) / (FACE_H * 0.64));
          seeds[i * 4] = Math.min(1, 0.6 * d + 0.4 * Math.random());
          inFigure++;
        } else {
          seeds[i * 4] = 2;      // background cube: a delay it can never reach, so it stays on the floor
        }
      }
    }

    if (mesh) { group.remove(mesh); mesh.geometry.dispose(); }
    var geo = new THREE.BoxGeometry(1, 1, 1);
    geo.setAttribute('aStart', new THREE.InstancedBufferAttribute(starts, 3));
    geo.setAttribute('aTarget', new THREE.InstancedBufferAttribute(targets, 3));
    geo.setAttribute('aColor', new THREE.InstancedBufferAttribute(colors, 4));
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    mesh = new THREE.InstancedMesh(geo, material, count);
    mesh.frustumCulled = false;
    group.add(mesh);

    uniforms.uCube.value = cubeSize;
    $('count').textContent = count.toLocaleString();
  }

  /* ---------- CPU mirror of the flight path (for the arcs) ---------- */
  var tmp = { x: 0, y: 0, z: 0, tx: 0, ty: 0, tz: 0, t: 0 };
  function flight(i) {
    var p = state.progress;
    var t = Math.max(0, Math.min(1, p * (1 + STAGGER) - seeds[i * 4] * STAGGER));
    var e = t * t * t * (t * (6 * t - 15) + 10), free = 1 - e;
    var ty0 = Math.max(0, Math.min(1, (t - 0.22) / 0.78)); ty0 = ty0 * ty0 * (3 - 2 * ty0);
    var ey = ty0 * ty0 * ty0 * (ty0 * (6 * ty0 - 15) + 10);
    var tx = targets[i * 3], ty = targets[i * 3 + 1], tz = targets[i * 3 + 2] * state.depth;
    var x = starts[i * 3] + (tx - starts[i * 3]) * e;
    var y = starts[i * 3 + 1] + (ty - starts[i * 3 + 1]) * ey;
    var z = starts[i * 3 + 2] + (tz - starts[i * 3 + 2]) * e;
    var sw = free * (1.4 + seeds[i * 4 + 1] * 1.4), cs = Math.cos(sw), sn = Math.sin(sw);
    tmp.x = cs * x + sn * z; tmp.y = y; tmp.z = -sn * x + cs * z;
    tmp.tx = tx; tmp.ty = ty; tmp.tz = tz; tmp.t = t;
  }

  function updateArcs(active) {
    var o = 0, k, s;
    for (k = 0; k < ARCS; k++) {
      var ok = false;
      if (k < active && count) {
        for (var tries = 0; tries < 8 && !ok; tries++) {
          flight((Math.random() * count) | 0);
          if (tmp.t > 0.04 && tmp.t < 0.97) ok = true;
        }
      }
      var ax = tmp.x, ay = tmp.y, az = tmp.z;
      var dx = tmp.tx - ax, dy = tmp.ty - ay, dz = tmp.tz - az;
      var dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (!ok || dist < 0.3) {
        for (s = 0; s < ARC_SEG * 6; s++) arcPos[o++] = 0;
        continue;
      }
      var len = Math.min(dist, 0.5 + Math.random() * 2.2), f = len / dist;
      var bx = ax + dx * f, by = ay + dy * f, bz = az + dz * f;
      var px = ax, py = ay, pz = az, jit = len * 0.14;
      for (s = 1; s <= ARC_SEG; s++) {
        var u = s / ARC_SEG, env = Math.sin(Math.PI * u) * jit;
        var nx = ax + (bx - ax) * u + (Math.random() - 0.5) * 2 * env;
        var ny = ay + (by - ay) * u + (Math.random() - 0.5) * 2 * env;
        var nz = az + (bz - az) * u + (Math.random() - 0.5) * 2 * env;
        arcPos[o++] = px; arcPos[o++] = py; arcPos[o++] = pz;
        arcPos[o++] = nx; arcPos[o++] = ny; arcPos[o++] = nz;
        px = nx; py = ny; pz = nz;
      }
    }
    arcGeo.attributes.position.needsUpdate = true;
  }

  /* ---------- sizing ---------- */
  function resize() {
    var w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    if (composer) { composer.setPixelRatio(DPR); composer.setSize(w, h); }
    if (fxaa) fxaa.material.uniforms.resolution.value.set(1 / (w * DPR), 1 / (h * DPR));
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    var tanH = Math.tan(camera.fov * Math.PI / 360);
    var faceW = FACE_H / ASPECT;
    var dist = Math.max(FACE_H * 0.66 / tanH, faceW * 0.6 / (tanH * camera.aspect));
    fitDist = dist;
    if (userCam) camera.position.setLength(dist);
  }
  window.addEventListener('resize', resize);

  /* ---------- controls ---------- */
  var playBtn = $('play'), scrub = $('scrub'), pct = $('pct');

  function toggle() {
    state.holdUntil = Infinity;
    if (state.dir !== 0) state.dir = 0;
    else state.dir = state.progress >= 0.999 ? -1 : 1;
  }
  playBtn.addEventListener('click', toggle);
  window.addEventListener('keydown', function (e) {
    if (e.code === 'Space' && !/^(INPUT|BUTTON)$/.test(e.target.tagName)) { e.preventDefault(); toggle(); }
  });
  scrub.addEventListener('input', function () {
    state.holdUntil = Infinity; state.dir = 0; state.progress = scrub.value / 1000;
  });

  var tune = $('tune'), tuneBtn = $('tuneBtn');
  tuneBtn.addEventListener('click', function () {
    tune.hidden = !tune.hidden;
    tuneBtn.setAttribute('aria-expanded', String(!tune.hidden));
  });

  function bindSlider(id, out, fmt, onInput, onChange) {
    var el = $(id), o = $(out);
    var show = function () { o.textContent = fmt(parseFloat(el.value)); };
    el.addEventListener('input', function () { show(); if (onInput) onInput(parseFloat(el.value)); });
    if (onChange) el.addEventListener('change', function () { onChange(parseFloat(el.value)); });
    show();
  }
  $('density').value = state.cols;
  bindSlider('density', 'vDensity', function (v) { return (v * Math.round(v * ASPECT)).toLocaleString(); }, null,
    function (v) { state.cols = v; build(); });
  bindSlider('depth', 'vDepth', function (v) { return v.toFixed(2); }, function (v) { state.depth = v; });
  function setDepth(v) { state.depth = v; $('depth').value = v; $('vDepth').textContent = v.toFixed(2); }
  $('cutout').addEventListener('change', function (e) { state.cutout = e.target.checked; build(); });
  bindSlider('speed', 'vSpeed', function (v) { return v.toFixed(1) + '×'; }, function (v) { state.speed = v; });
  bindSlider('glow', 'vGlow', function (v) { return Math.round(v * 100) + '%'; }, function (v) { state.glow = v; });

  /* ---------- photo loading ---------- */
  var clock = new THREE.Clock();
  function restartWith(drawable, w, h) {
    setSource(drawable, w, h);
    depthSrc = null; setDepth(2.2);
    build();
    state.progress = 0; state.dir = 0;
    state.holdUntil = clock.elapsedTime + 0.9;
    userCam = false;
    $('hint').classList.add('gone');
  }
  function loadFile(file, done) {
    if (!file || !/^image\//.test(file.type)) return;
    done = done || restartWith;
    var viaImg = function () {
      var fr = new FileReader();
      fr.onload = function () {
        var img = new Image();
        img.onload = function () { done(img, img.naturalWidth, img.naturalHeight); };
        img.src = fr.result;
      };
      fr.readAsDataURL(file);
    };
    if (window.createImageBitmap) {
      createImageBitmap(file).then(function (bmp) { done(bmp, bmp.width, bmp.height); }).catch(viaImg);
    } else viaImg();
  }
  $('file').addEventListener('change', function (e) { loadFile(e.target.files[0]); e.target.value = ''; });
  function setDepthSource(drawable, w, h) {
    depthSrc = document.createElement('canvas');
    depthSrc.width = w; depthSrc.height = h;
    depthSrc.getContext('2d').drawImage(drawable, 0, 0, w, h);
  }
  $('depthFile').addEventListener('change', function (e) {
    loadFile(e.target.files[0], function (d, w, h) { setDepthSource(d, w, h); build(); });
    e.target.value = '';
  });

  var drop = $('drop'), dragDepth = 0;
  window.addEventListener('dragenter', function (e) { e.preventDefault(); dragDepth++; drop.hidden = false; });
  window.addEventListener('dragleave', function () { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) drop.hidden = true; });
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) {
    e.preventDefault(); dragDepth = 0; drop.hidden = true;
    if (e.dataTransfer && e.dataTransfer.files.length) loadFile(e.dataTransfer.files[0]);
  });

  /* ---------- frame loop ---------- */
  function smooth(a, b, x) { var t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  var swayAmp = 0.14;
  var lastLabel = '', lastPct = -1, arcTimer = 0, fpsAcc = 0, fpsN = 0, fpsEl = $('fps');

  function frame() {
    requestAnimationFrame(frame);
    var dt = Math.min(clock.getDelta(), 0.05), time = clock.elapsedTime;

    if (state.dir === 0 && time > state.holdUntil) { state.holdUntil = Infinity; state.dir = 1; }
    if (state.dir !== 0) {
      var rate = state.speed / BASE_DURATION * (state.dir < 0 ? 2.2 : 1);
      state.progress += state.dir * dt * rate;
      if (state.progress >= 1) { state.progress = 1; state.dir = 0; }
      if (state.progress <= 0) { state.progress = 0; state.dir = 0; }
    }
    var p = state.progress, settle = smooth(0.8, 1, p);

    uniforms.uProgress.value = p;
    uniforms.uTime.value = time;
    uniforms.uDepth.value = state.depth;
    uniforms.uGlow.value = state.glow;
    uniforms.uSettle.value = settle;
    floorUniforms.uEnergy.value = state.glow * (1 - 0.85 * settle);

    // bloom is heavy and low-threshold for the red energy, then backs off for the photo
    if (bloom) {
      bloom.strength = lerp(0.35 + 0.75 * state.glow, 0.14, settle);
      bloom.threshold = lerp(0.3, 0.86, settle);
    }

    arcTimer += dt;
    if (arcTimer > 0.06) {
      arcTimer = 0;
      var energy = (0.3 + 0.7 * Math.sin(Math.PI * p)) * (1 - settle) * Math.min(1, state.glow * 2);
      updateArcs(Math.round(ARCS * energy));
    }

    if (!reduceMotion) {
      // gentle sway while assembling, a wider slow turn once the figure stands; stops when you take the camera
      var wantSway = userCam ? 0 : lerp(0.14, 0.6, settle);
      swayAmp += (wantSway - swayAmp) * Math.min(1, dt * 1.5);
      group.rotation.y = Math.sin(time * 0.32) * swayAmp;
    }
    // until you take the camera, it starts low beside the heap and pulls back to frame the face
    if (!userCam) {
      var k = smooth(0.04, 0.72, p);
      camera.position.set(lerp(3.4, 0, k), lerp(FLOOR_Y + 1.5, 0.2 + fitDist * 0.053, k), lerp(10.5, fitDist * 0.9986, k));
      if (controls) controls.target.set(0, lerp(FLOOR_Y + 1.3, 0.2, k), 0); else camera.lookAt(0, lerp(FLOOR_Y + 1.3, 0.2, k), 0);
    }
    if (controls) controls.update();

    if (composer) composer.render(); else renderer.render(scene, camera);

    // UI readouts
    var label = state.dir !== 0 ? 'Pause' : (p >= 0.999 ? 'Scatter' : 'Assemble');
    if (label !== lastLabel) { playBtn.textContent = label; lastLabel = label; }
    var pi = Math.round(p * 1000);
    if (pi !== lastPct) {
      lastPct = pi;
      if (document.activeElement !== scrub || state.dir !== 0) scrub.value = pi;
      pct.textContent = Math.round(p * 100) + '%';
    }
    fpsAcc += dt; fpsN++;
    if (fpsAcc > 0.5) { fpsEl.textContent = Math.round(fpsN / fpsAcc); fpsAcc = 0; fpsN = 0; }
  }

  /* ---------- go ---------- */
  function start() { build(); resize(); frame(); }
  function loadImg(src) {
    return new Promise(function (res, rej) { var im = new Image(); im.onload = function () { res(im); }; im.onerror = rej; im.src = src; });
  }
  var DP = window.DEFAULT_PORTRAIT;
  if (DP && DP.photo) {
    Promise.all([loadImg(DP.photo), DP.depth ? loadImg(DP.depth) : null]).then(function (r) {
      setSource(r[0], r[0].naturalWidth, r[0].naturalHeight);
      if (r[1]) { setDepthSource(r[1], r[1].naturalWidth, r[1].naturalHeight); setDepth(DP.relief || 2.2); }
      start();
    }).catch(function () { drawSampleFace(); start(); });
  } else {
    drawSampleFace();
    $('hint').textContent = 'This is a sample face. Add your own portrait, then drag to orbit.';
    start();
  }
})();
