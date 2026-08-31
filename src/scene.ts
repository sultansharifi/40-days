import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { BokehPass } from "three/examples/jsm/postprocessing/BokehPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

export type UpdateFn = (dt: number, elapsed: number) => void;

const REDUCE_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Owns the renderer, camera, lighting/environment, ground and the
 * cinematic-vs-orbit camera behaviour. car.ts / face.ts / timeline.ts hang
 * their own objects off `scene.carAnchor` / `scene.faceAnchor` and register
 * per-frame work through `addUpdate`.
 */
export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly composer: EffectComposer;
  readonly clock = new THREE.Clock();

  readonly carAnchor = new THREE.Group();
  readonly faceAnchor = new THREE.Group();

  private updateFns: UpdateFn[] = [];
  private bloomPass!: UnrealBloomPass;
  private bokehPass!: BokehPass;
  private userInteracting = false;
  private lastInteraction = 0;
  private cinematicEnabled = true;
  private running = false;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.camera = new THREE.PerspectiveCamera(32, window.innerWidth / window.innerHeight, 0.05, 100);
    this.camera.position.set(0.4, 2.1, 9.2);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 16;
    this.controls.maxPolarAngle = Math.PI * 0.53;
    this.controls.target.set(0, 1.05, 0);
    this.controls.addEventListener("start", () => {
      this.userInteracting = true;
    });
    this.controls.addEventListener("end", () => {
      this.userInteracting = false;
      this.lastInteraction = this.clock.getElapsedTime();
    });

    this.scene.add(this.carAnchor, this.faceAnchor);
    this.carAnchor.position.set(2.55, 0, 0);
    this.faceAnchor.position.set(-2.55, 0, 0);

    this.buildGround();
    this.buildLights();
    this.buildDivider();

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.buildBloom();
    this.buildDof();
    this.composer.addPass(new OutputPass());

    window.addEventListener("resize", () => this.resize());
    this.resize();
  }

  async loadEnvironment(hdriUrl: string) {
    const rgbe = new RGBELoader();
    const hdr = await rgbe.loadAsync(hdriUrl);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    pmrem.compileEquirectangularShader();
    const envMap = pmrem.fromEquirectangular(hdr).texture;
    hdr.dispose();
    pmrem.dispose();

    this.scene.environment = envMap;
    this.scene.background = envMap;
    this.scene.backgroundBlurriness = 0.72;
    this.scene.backgroundIntensity = 0.55;
    this.scene.environmentIntensity = 1.0;
    this.scene.fog = new THREE.FogExp2(0x05070c, 0.028);
  }

  private buildGround() {
    const geo = new THREE.CircleGeometry(11, 96);
    const mat = new THREE.MeshPhysicalMaterial({
      color: 0x090b10,
      roughness: 0.32,
      metalness: 0.15,
      clearcoat: 0.55,
      clearcoatRoughness: 0.28,
      envMapIntensity: 1.15,
    });
    const ground = new THREE.Mesh(geo, mat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    ground.position.y = 0;
    this.scene.add(ground);
  }

  private buildLights() {
    const key = new THREE.DirectionalLight(0xfff2e0, 2.4);
    key.position.set(4.5, 6.2, 3.4);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 20;
    key.shadow.camera.left = -7;
    key.shadow.camera.right = 7;
    key.shadow.camera.top = 7;
    key.shadow.camera.bottom = -7;
    key.shadow.radius = 3;
    key.shadow.bias = -0.0003;
    this.scene.add(key);

    const rim = new THREE.DirectionalLight(0x9fc8ff, 0.9);
    rim.position.set(-5, 3.5, -4.5);
    this.scene.add(rim);

    const fill = new THREE.HemisphereLight(0x9fb9ff, 0x1a140f, 0.35);
    this.scene.add(fill);
  }

  private buildDivider() {
    const geo = new THREE.PlaneGeometry(0.014, 4.2);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xbfe7ff,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
    });
    const divider = new THREE.Mesh(geo, mat);
    divider.position.set(0, 2.1, 0);
    this.scene.add(divider);

    const glow = new THREE.PointLight(0xbfe7ff, 3.5, 6, 2);
    glow.position.set(0, 1.4, 0.4);
    this.scene.add(glow);
  }

  private buildBloom() {
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.42, 0.5, 0.86);
    this.composer.addPass(this.bloomPass);
  }

  private buildDof() {
    this.bokehPass = new BokehPass(this.scene, this.camera, {
      focus: 9.0,
      aperture: 0.00028,
      maxblur: 0.006,
    });
    this.composer.addPass(this.bokehPass);
  }

  addUpdate(fn: UpdateFn) {
    this.updateFns.push(fn);
  }

  setCinematicEnabled(enabled: boolean) {
    this.cinematicEnabled = enabled;
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.bloomPass?.setSize(w, h);
    const pr = Math.min(window.devicePixelRatio, 2);
    this.renderer.setPixelRatio(pr);
  }

  private cinematicCamera(elapsed: number) {
    if (!this.cinematicEnabled || REDUCE_MOTION) return;
    const idleFor = elapsed - this.lastInteraction;
    if (this.userInteracting || idleFor < 1.2) return;
    const t = elapsed * 0.055;
    const dolly = Math.sin(t) * 0.55;
    const height = 2.0 + Math.sin(t * 0.6) * 0.18;
    const radius = 9.2 + Math.cos(t * 0.4) * 0.5;
    this.camera.position.x = Math.sin(t * 0.35) * 1.4 + dolly * 0.3;
    this.camera.position.y = height;
    this.camera.position.z = radius;
    this.controls.target.y = 1.05 + Math.sin(t * 0.5) * 0.05;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const tick = () => {
      if (!this.running) return;
      requestAnimationFrame(tick);
      const dt = Math.min(this.clock.getDelta(), 0.05);
      const elapsed = this.clock.getElapsedTime();
      this.cinematicCamera(elapsed);
      this.controls.update();
      for (const fn of this.updateFns) fn(dt, elapsed);
      this.composer.render();
    };
    requestAnimationFrame(tick);
  }
}

export { REDUCE_MOTION };
