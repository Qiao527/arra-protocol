// The game-day coin toss, in silver. Every football game starts with one; it is money, and it is odds.
// Scroll progress p in [0, 1] runs three beats:
//   0.00-0.33  a promise, unsealed: the coin is in the air, flipping
//   0.33-0.66  locked in USDC: it settles face-on to camera
//   0.66-1.00  paid at the whistle: a band of light sweeps across the face
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Struck-coin face as a bump map: raised rim, beaded ring, concentric field lines, ARRA and a value line. */
function faceTexture() {
  const S = 1024;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d");
  g.fillStyle = "#808080";
  g.fillRect(0, 0, S, S);
  const cx = S / 2;
  g.lineWidth = 46; g.strokeStyle = "#ffffff";
  g.beginPath(); g.arc(cx, cx, S / 2 - 26, 0, Math.PI * 2); g.stroke();
  g.fillStyle = "#e6e6e6";
  for (let i = 0; i < 96; i++) {
    const a = (i / 96) * Math.PI * 2;
    g.beginPath(); g.arc(cx + Math.cos(a) * 430, cx + Math.sin(a) * 430, 6, 0, Math.PI * 2); g.fill();
  }
  g.lineWidth = 2; g.strokeStyle = "#868686";
  for (let r = 60; r < 400; r += 18) { g.beginPath(); g.arc(cx, cx, r, 0, Math.PI * 2); g.stroke(); }
  g.fillStyle = "#f2f2f2";
  g.textAlign = "center"; g.textBaseline = "middle";
  g.font = "400 230px 'Inter Tight', Helvetica, Arial, sans-serif";
  g.fillText("ARRA", cx, cx - 20);
  g.font = "500 54px 'JetBrains Mono', ui-monospace, monospace";
  g.fillText("1 USDC   ARC", cx, cx + 150);
  g.lineWidth = 6; g.strokeStyle = "#f2f2f2";
  g.beginPath(); g.moveTo(cx - 170, cx + 95); g.lineTo(cx + 170, cx + 95); g.stroke();
  // soften so the bump reads as struck metal, not noise
  const soft = document.createElement("canvas");
  soft.width = soft.height = S;
  const sg = soft.getContext("2d");
  sg.filter = "blur(2px)";
  sg.drawImage(c, 0, 0);
  const t = new THREE.CanvasTexture(soft);
  t.anisotropy = 8;
  t.center.set(0.5, 0.5);
  t.rotation = Math.PI / 2; // cylinder caps map u/v rotated; turn the legend upright
  return t;
}

/** Reeded edge as a bump map: fine vertical ridges wrapped around the rim. */
function edgeTexture() {
  const c = document.createElement("canvas");
  c.width = 64; c.height = 8;
  const g = c.getContext("2d");
  const grad = g.createLinearGradient(0, 0, 64, 0);
  grad.addColorStop(0, "#202020"); grad.addColorStop(0.5, "#f0f0f0"); grad.addColorStop(1, "#202020");
  g.fillStyle = grad; g.fillRect(0, 0, 64, 8);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.repeat.set(160, 1);
  return t;
}

/** A coin: a smooth cylinder (the reeding is a bump map on the edge). Groups: 0 edge, 1 top, 2 bottom. */
function coinGeometry(R = 1.6, H = 0.17) {
  return new THREE.CylinderGeometry(R, R, H, 256, 1, false);
}

export function createSealScene(canvas, { reducedMotion = false } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, window.innerWidth < 700 ? 1.5 : 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.02).texture;

  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  camera.position.set(0, 0, 10);

  const bump = faceTexture();
  const reed = edgeTexture();
  const edge = new THREE.MeshPhysicalMaterial({ color: 0xdfe2e1, metalness: 1, roughness: 0.3, bumpMap: reed, bumpScale: 1.5, envMapIntensity: 1.1 });
  const face = new THREE.MeshPhysicalMaterial({
    color: 0xe4e6e5, metalness: 1, roughness: 0.3, clearcoat: 0.4, clearcoatRoughness: 0.25,
    bumpMap: bump, bumpScale: 1.6, envMapIntensity: 1.15,
  });
  const coin = new THREE.Mesh(coinGeometry(), [edge, face, face]);
  coin.rotation.x = Math.PI / 2; // a face toward the camera when the group is at rest
  const group = new THREE.Group();
  group.add(coin);
  scene.add(group);

  const key = new THREE.DirectionalLight(0xffffff, 1.4);
  key.position.set(-3, 4, 5);
  scene.add(key);
  const sweep = new THREE.SpotLight(0xffffff, 0, 30, 0.12, 0.6);
  sweep.position.set(-6, 0, 6);
  sweep.target = group;
  scene.add(sweep);

  let progress = 0;
  let pointer = { x: 0, y: 0 };
  let raf = 0;
  let running = true;
  let narrow = false;
  let spin = 0;
  let shown = 0;
  let last = 0;

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
    const dt = Math.min(64, t - (last || t));
    last = t;
    shown += (progress - shown) * (reducedMotion ? 1 : 0.05); // eased scrub: the coin trails the scroll, never jumps
    const p = shown;
    const lock = smooth(0.2, 0.5, p);
    const pay = smooth(0.62, 0.92, p);
    // a slow, weighty turn: edge-on and tilted while unsealed, squaring to the camera as it
    // locks. Idle drift is a few degrees over many seconds, never a spin.
    spin += dt * (reducedMotion ? 0 : 0.00012);
    const idle = reducedMotion ? 0 : Math.sin(spin) * 0.08;
    const tiltX = 0.95 * (1 - lock) + 0.12 + pointer.y * 0.05;
    const yaw = -1.1 * (1 - lock) - 0.28 * lock + idle + pointer.x * 0.08;
    group.rotation.x += (tiltX - group.rotation.x) * 0.04;
    group.rotation.y += (yaw - group.rotation.y) * 0.04;
    group.rotation.z = 0.12 * (1 - lock);
    group.position.y = (narrow ? 1.3 : 0.85) + (reducedMotion ? 0 : Math.sin(spin * 1.7) * 0.04);
    // paid: a band of light sweeps across the face, then holds soft
    sweep.intensity = pay > 0 && pay < 1 ? 160 * Math.sin(pay * Math.PI) : pay >= 1 ? 25 : 0;
    sweep.position.x = -6 + pay * 12;
    group.scale.setScalar(1 + pay * 0.05);
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
    resume() { if (!running && !reducedMotion) { running = true; last = 0; raf = requestAnimationFrame(frame); } },
    dispose() {
      running = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("pointermove", onPointer);
      bump.dispose();
      reed.dispose();
      renderer.dispose();
      pmrem.dispose();
    },
  };
}
