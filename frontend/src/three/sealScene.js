// The Arra mark in glass: two refractive arches meeting at a keystone with a liquid core.
// Scroll progress p in [0, 1] runs three beats:
//   0.00-0.33  a promise, unsealed: arches apart, core dark
//   0.33-0.66  locked in USDC: arches close, core lights vermilion
//   0.66-1.00  paid at the whistle: core turns warm white, glow peaks
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function archCurve(cx) {
  // the logo's arch: two legs and a half-circle crown, radius 1, centred at cx
  const pts = [];
  pts.push(new THREE.Vector3(cx - 1, -1.6, 0));
  for (let i = 0; i <= 24; i++) {
    const a = Math.PI - (i / 24) * Math.PI;
    pts.push(new THREE.Vector3(cx + Math.cos(a), Math.sin(a), 0));
  }
  pts.push(new THREE.Vector3(cx + 1, -1.6, 0));
  return new THREE.CatmullRomCurve3(pts, false, "centripetal");
}

export function createSealScene(canvas, { reducedMotion = false } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  const dpr = Math.min(window.devicePixelRatio || 1, window.innerWidth < 700 ? 1.5 : 2);
  renderer.setPixelRatio(dpr);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  camera.position.set(0, 0.2, 9);

  const group = new THREE.Group();
  scene.add(group);

  const glass = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    metalness: 0,
    roughness: 0.03,
    transmission: 1,
    thickness: 0.6,
    ior: 1.45,
    dispersion: 0.4,
    clearcoat: 1,
    clearcoatRoughness: 0.03,
    attenuationColor: new THREE.Color(0xf6e7d4),
    attenuationDistance: 4,
    envMapIntensity: 0.9,
  });

  // A backdrop for the glass to refract: a dark field with a faint vermilion bloom and fine
  // ruled lines (a ledger page), drawn procedurally. Without it, transmission has nothing to bend.
  const tex = (() => {
    const c = document.createElement("canvas");
    c.width = 1024; c.height = 1024;
    const g = c.getContext("2d");
    g.fillStyle = "#0d0e11"; g.fillRect(0, 0, 1024, 1024);
    const rg = g.createRadialGradient(560, 420, 20, 560, 420, 520);
    rg.addColorStop(0, "rgba(226,72,43,0.55)"); rg.addColorStop(0.45, "rgba(226,72,43,0.12)"); rg.addColorStop(1, "rgba(226,72,43,0)");
    g.fillStyle = rg; g.fillRect(0, 0, 1024, 1024);
    g.strokeStyle = "rgba(236,235,230,0.035)"; g.lineWidth = 2;
    for (let y = 32; y < 1024; y += 48) { g.beginPath(); g.moveTo(0, y); g.lineTo(1024, y); g.stroke(); }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(26, 26), new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.9 }));
  backdrop.position.set(0, 0, -5);
  scene.add(backdrop);
  const tube = (cx) => new THREE.Mesh(new THREE.TubeGeometry(archCurve(cx), 160, 0.22, 48, false), glass);
  const left = tube(-0.5);
  const right = tube(0.5);
  group.add(left, right);

  // keystone: a liquid core inside a glass block
  const coreMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, emissive: new THREE.Color(0x000000), roughness: 0.15, metalness: 0.9 });
  const core = new THREE.Mesh(new THREE.SphereGeometry(0.17, 48, 48), coreMat);
  const key = new THREE.Mesh(new THREE.SphereGeometry(0.34, 64, 64), glass);
  const keystone = new THREE.Group();
  keystone.add(core, key);
  keystone.position.set(0, 1.5, 0);
  group.add(keystone);

  // a soft floor of light that the glass refracts
  const lightA = new THREE.PointLight(0xe2482b, 0, 6);
  lightA.position.set(0, 1.55, 0.6);
  scene.add(lightA);
  const rim = new THREE.DirectionalLight(0xffffff, 1.2);
  rim.position.set(3, 4, 2);
  scene.add(rim);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.35, 0.6, 0.9);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  const dark = new THREE.Color(0x141414);
  const seal = new THREE.Color(0xe2482b);
  const paid = new THREE.Color(0xfff1d6);
  let progress = 0;
  let pointer = { x: 0, y: 0 };
  let raf = 0;
  let running = true;

  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    bloom.setSize(w, h);
    camera.aspect = w / h;
    const narrow = w < 900;
    camera.position.z = narrow ? 11.5 : 9;
    // desktop: the object sits right of the copy; phone: above it
    group.userData.baseX = narrow ? 0 : 1.9;
    group.userData.baseY = narrow ? 0.9 : -0.2;
    backdrop.position.x = group.userData.baseX;
    camera.updateProjectionMatrix();
  }

  function frame(t) {
    const p = progress;
    const lock = smooth(0.25, 0.55, p);
    const pay = smooth(0.62, 0.9, p);
    // arches slide together as the promise locks
    const gap = (1 - lock) * 0.9;
    left.position.x = -gap;
    right.position.x = gap;
    keystone.position.y = 1.5 + (1 - lock) * 1.1;
    keystone.rotation.y = t * 0.0006 + p * Math.PI;
    // core: dark -> vermilion -> warm white
    const c = dark.clone().lerp(seal, lock).lerp(paid, pay);
    coreMat.color.copy(c);
    coreMat.emissive.copy(c).multiplyScalar(0.1 + lock * 1.5 + pay * 0.6);
    lightA.intensity = lock * 5 + pay * 3;
    backdrop.material.color.setScalar(0.35 + lock * 0.55 - pay * 0.25);
    lightA.color.copy(c);
    bloom.strength = 0.2 + lock * 0.3 + pay * 0.15;
    // slow turn plus a little pointer parallax
    const drift = reducedMotion ? 0 : Math.sin(t * 0.0004) * 0.12;
    group.rotation.y += ((-0.35 + p * 0.7 + pointer.x * 0.25 + drift) - group.rotation.y) * 0.06;
    group.rotation.x += ((pointer.y * 0.12 - 0.05) - group.rotation.x) * 0.06;
    group.position.x = group.userData.baseX ?? 1.9;
    group.position.y = (group.userData.baseY ?? -0.2) + (reducedMotion ? 0 : Math.sin(t * 0.0008) * 0.05);
    composer.render();
    if (running && !reducedMotion) raf = requestAnimationFrame(frame);
  }

  const onPointer = (e) => {
    pointer = { x: (e.clientX / window.innerWidth) * 2 - 1, y: (e.clientY / window.innerHeight) * 2 - 1 };
  };
  window.addEventListener("pointermove", onPointer, { passive: true });
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();
  raf = requestAnimationFrame(frame);

  return {
    setProgress(p) {
      progress = p;
      if (reducedMotion) requestAnimationFrame(frame);
    },
    pause() { running = false; cancelAnimationFrame(raf); },
    resume() { if (!running && !reducedMotion) { running = true; raf = requestAnimationFrame(frame); } },
    dispose() {
      running = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("pointermove", onPointer);
      renderer.dispose();
      pmrem.dispose();
    },
  };
}
