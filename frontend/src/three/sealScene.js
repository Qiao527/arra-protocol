// The Arra mark as a silver sculpture: two brushed-metal arches meeting at a glass keystone
// with a liquid core. Scroll progress p in [0, 1] runs three beats:
//   0.00-0.33  a promise, unsealed: arches apart and turned away, core clear
//   0.33-0.66  locked in USDC: arches close square to camera, core turns to black ink
//   0.66-1.00  paid at the whistle: the core turns bright white
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function archCurve(cx) {
  const pts = [new THREE.Vector3(cx - 1, -2.2, 0)];
  for (let i = 0; i <= 32; i++) {
    const a = Math.PI - (i / 32) * Math.PI;
    pts.push(new THREE.Vector3(cx + Math.cos(a), Math.sin(a), 0));
  }
  pts.push(new THREE.Vector3(cx + 1, -2.2, 0));
  return new THREE.CatmullRomCurve3(pts, false, "centripetal");
}

export function createSealScene(canvas, { reducedMotion = false } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, window.innerWidth < 700 ? 1.5 : 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.02).texture;

  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  camera.position.set(0, 0, 10);

  const group = new THREE.Group();
  scene.add(group);

  // brushed silver, soft like a studio sculpture photographed on grey
  const silver = new THREE.MeshPhysicalMaterial({
    color: 0xd5d8d7, metalness: 1, roughness: 0.28, clearcoat: 0.6, clearcoatRoughness: 0.2, envMapIntensity: 1.05,
  });
  const tube = (cx) => new THREE.Mesh(new THREE.TubeGeometry(archCurve(cx), 220, 0.26, 64, false), silver);
  const left = tube(-0.5);
  const right = tube(0.5);
  group.add(left, right);

  const glass = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, metalness: 0, roughness: 0.02, transmission: 1, thickness: 0.5, ior: 1.45, dispersion: 0.3,
    clearcoat: 1, clearcoatRoughness: 0.02,
  });
  const coreMat = new THREE.MeshPhysicalMaterial({ color: 0xbfc3c2, metalness: 0.2, roughness: 0.08, clearcoat: 1, emissive: new THREE.Color(0x000000) });
  const keystone = new THREE.Group();
  keystone.add(new THREE.Mesh(new THREE.SphereGeometry(0.19, 64, 64), coreMat), new THREE.Mesh(new THREE.SphereGeometry(0.38, 64, 64), glass));
  group.add(keystone);

  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(-3, 5, 4);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xdde4ff, 0.5);
  fill.position.set(4, -2, 3);
  scene.add(fill);

  const clear = new THREE.Color(0xbfc3c2);
  const ink = new THREE.Color(0x0e0f0f);
  const white = new THREE.Color(0xffffff);
  let progress = 0;
  let pointer = { x: 0, y: 0 };
  let raf = 0;
  let running = true;
  let narrow = false;

  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    narrow = w < 900;
    camera.position.z = narrow ? 13 : 10;
    camera.updateProjectionMatrix();
  }

  function frame(t) {
    const p = progress;
    const lock = smooth(0.22, 0.52, p);
    const pay = smooth(0.62, 0.9, p);
    const gap = (1 - lock) * 0.7;
    left.position.x = -gap;
    right.position.x = gap;
    left.rotation.y = (1 - lock) * 0.5;
    right.rotation.y = -(1 - lock) * 0.5;
    keystone.position.set(0, 1.55 + (1 - lock) * 0.45, 0);
    const c = clear.clone().lerp(ink, lock).lerp(white, pay);
    coreMat.color.copy(c);
    coreMat.emissive.copy(white).multiplyScalar(pay * 0.9);
    const drift = reducedMotion ? 0 : Math.sin(t * 0.00035) * 0.1;
    group.rotation.y += ((-0.55 + p * 0.55 + pointer.x * 0.18 + drift) - group.rotation.y) * 0.05;
    group.rotation.x += ((pointer.y * 0.08 + 0.05) - group.rotation.x) * 0.05;
    group.position.y = (narrow ? 0.8 : -0.15) + (reducedMotion ? 0 : Math.sin(t * 0.0007) * 0.06);
    group.scale.setScalar(1 + pay * 0.06);
    renderer.render(scene, camera);
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
