import * as THREE from "three";
import * as CANNON from "cannon-es";
import gsap from "gsap";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { assetUrl, clamp01, easeOutBack, easeOutCubic, makeLabelSprite, mulberry32, segment, setLabelOpacity, smoothstep } from "./utils";

export type CarPartKey = "chassis" | "body" | "cabin" | "frontWheels" | "rearWheels";

export const CAR_PART_ORDER: CarPartKey[] = ["chassis", "body", "cabin", "frontWheels", "rearWheels"];

export const CAR_PART_LABELS: Record<CarPartKey, string> = {
  chassis: "شاسی",
  body: "بدنه",
  cabin: "کابین (شیشه)",
  frontWheels: "تایر جلو",
  rearWheels: "تایر عقب",
};

const CHASSIS_NAMES = new Set(["metal", "plastic_gray", "interior_dark", "carpet", "grills", "carbon_fibre_trim", "carbon fibre", "wipers", "brakes"]);
const BODY_NAMES = new Set(["body", "blue", "yellow_trim", "trim", "lights_red", "lights", "leds", "chrome"]);
const CABIN_NAMES = new Set(["glass", "leather", "interior_light"]);

const EXPLODE_DIR: Record<CarPartKey, THREE.Vector3> = {
  chassis: new THREE.Vector3(-1.5, -0.55, 0),
  body: new THREE.Vector3(0, 1.35, -1.55),
  cabin: new THREE.Vector3(0, 2.1, 1.65),
  frontWheels: new THREE.Vector3(1.85, -0.35, 1.55),
  rearWheels: new THREE.Vector3(1.85, -0.35, -1.55),
};

interface Part {
  key: CarPartKey;
  object: THREE.Group;
  restPos: THREE.Vector3;
  restQuat: THREE.Quaternion;
  explodedPos: THREE.Vector3;
  body: CANNON.Body;
  wireframe: THREE.Group;
}

const GRAVITY = -9.82;

export class CarRig {
  readonly root = new THREE.Group();
  ready: Promise<void>;

  private gltfScene!: THREE.Group;
  private parts = new Map<CarPartKey, Part>();
  private world = new CANNON.World({ gravity: new CANNON.Vec3(0, GRAVITY, 0) });
  private bodyOffsets = new Map<CANNON.Body, THREE.Vector3>();
  private groundLocalY = 0;
  private physicsActive = false;
  private rng = mulberry32(20260831);

  private blueprintGroup = new THREE.Group();
  private labelBlueprint: THREE.Sprite;
  private labelSequence: THREE.Sprite;
  private lastStage2P = -1;
  onKeyBeat?: (index: number, key: CarPartKey) => void;

  constructor() {
    this.labelBlueprint = makeLabelSprite("موتر (blueprint)", "#7fd3ff");
    this.labelSequence = makeLabelSprite("به‌ترتیب (in sequence)", "#7fd3ff");
    this.labelBlueprint.position.set(0, 3.05, 0);
    this.labelSequence.position.set(0, 3.05, 0);
    setLabelOpacity(this.labelBlueprint, 0);
    setLabelOpacity(this.labelSequence, 0);
    this.root.add(this.blueprintGroup, this.labelBlueprint, this.labelSequence);

    this.ready = Promise.resolve();
  }

  async load(url: string) {
    const draco = new DRACOLoader();
    draco.setDecoderPath(assetUrl("assets/draco/"));
    const loader = new GLTFLoader();
    loader.setDRACOLoader(draco);
    const gltf = await loader.loadAsync(url);
    this.gltfScene = gltf.scene as THREE.Group;
    this.gltfScene.updateMatrixWorld(true);

    const box = new THREE.Box3().setFromObject(this.gltfScene);
    const center = box.getCenter(new THREE.Vector3());
    this.gltfScene.position.set(-center.x, -box.min.y, -center.z);
    // After the shift above, the car's lowest point sits exactly at local y = 0.
    this.groundLocalY = 0;

    this.buildPartGroups();
    this.buildWireframes();
    this.buildPhysics();

    this.root.add(this.gltfScene);
    this.setAssemblyProgress(0);
    this.setBlueprintProgress(0);
  }

  private buildPartGroups() {
    const mainNode = this.gltfScene.getObjectByName("main")!;
    const wheelRR = this.gltfScene.getObjectByName("wheel_rr")!;
    const wheelRL = this.gltfScene.getObjectByName("wheel_rl")!;
    const wheelFL = this.gltfScene.getObjectByName("wheel_fl")!;
    const wheelFR = this.gltfScene.getObjectByName("wheel_fr")!;
    const steering = this.gltfScene.getObjectByName("steering_wheel")!;

    const groups: Record<CarPartKey, THREE.Group> = {
      chassis: new THREE.Group(),
      body: new THREE.Group(),
      cabin: new THREE.Group(),
      frontWheels: new THREE.Group(),
      rearWheels: new THREE.Group(),
    };
    for (const key of CAR_PART_ORDER) {
      groups[key].name = `car-${key}`;
      this.gltfScene.add(groups[key]);
    }

    for (const child of [...mainNode.children]) {
      const name = child.name;
      if (CHASSIS_NAMES.has(name)) groups.chassis.attach(child);
      else if (BODY_NAMES.has(name)) groups.body.attach(child);
      else if (CABIN_NAMES.has(name)) groups.cabin.attach(child);
      else groups.body.attach(child);
    }
    groups.cabin.attach(steering);
    groups.frontWheels.attach(wheelFL);
    groups.frontWheels.attach(wheelFR);
    groups.rearWheels.attach(wheelRL);
    groups.rearWheels.attach(wheelRR);
    this.gltfScene.remove(mainNode);

    this.gltfScene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if ((mesh as any).isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        const mat = mesh.material as THREE.MeshStandardMaterial;
        if (mat && "envMapIntensity" in mat) mat.envMapIntensity = 1.1;
      }
    });

    for (const key of CAR_PART_ORDER) {
      const object = groups[key];
      this.parts.set(key, {
        key,
        object,
        restPos: object.position.clone(),
        restQuat: object.quaternion.clone(),
        explodedPos: object.position.clone().add(EXPLODE_DIR[key]),
        body: undefined as unknown as CANNON.Body,
        wireframe: new THREE.Group(),
      });
    }
  }

  private buildWireframes() {
    for (const part of this.parts.values()) {
      const wf = new THREE.Group();
      wf.position.copy(part.restPos);
      wf.quaternion.copy(part.restQuat);
      part.object.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!(mesh as any).isMesh) return;
        const edges = new THREE.EdgesGeometry(mesh.geometry as THREE.BufferGeometry, 22);
        const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x69d2ff, transparent: true, opacity: 0.85, toneMapped: false }));
        mesh.updateWorldMatrix(true, false);
        line.matrixAutoUpdate = false;
        const localMat = new THREE.Matrix4().copy(mesh.matrixWorld);
        part.object.updateWorldMatrix(true, false);
        const inv = new THREE.Matrix4().copy(part.object.matrixWorld).invert();
        line.matrix.copy(inv.multiply(localMat));
        wf.add(line);
      });
      part.wireframe = wf;
      this.blueprintGroup.add(wf);
    }
  }

  private buildPhysics() {
    // Car parts (chassis/body/cabin/wheels) naturally nest and overlap each
    // other's bounding boxes in the assembled car, which would make cannon's
    // contact solver treat them as deeply interpenetrating and blast them
    // apart. Parts only need to collide with the ground, not each other.
    const GROUP_GROUND = 1;
    const GROUP_PARTS = 2;

    const groundBody = new CANNON.Body({
      type: CANNON.Body.STATIC,
      shape: new CANNON.Plane(),
      collisionFilterGroup: GROUP_GROUND,
      collisionFilterMask: GROUP_PARTS,
    });
    groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    groundBody.position.set(0, this.groundLocalY, 0);
    this.world.addBody(groundBody);

    for (const part of this.parts.values()) {
      const box = new THREE.Box3().setFromObject(part.object);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const half = new CANNON.Vec3(Math.max(size.x / 2, 0.05), Math.max(size.y / 2, 0.05), Math.max(size.z / 2, 0.05));
      const body = new CANNON.Body({
        type: CANNON.Body.KINEMATIC,
        shape: new CANNON.Box(half),
        mass: 45,
        collisionFilterGroup: GROUP_PARTS,
        collisionFilterMask: GROUP_GROUND,
      });
      body.position.set(center.x, center.y, center.z);
      this.bodyOffsets.set(body, new THREE.Vector3().subVectors(part.restPos, center));
      this.world.addBody(body);
      part.body = body;
    }
  }

  setBlueprintProgress(p: number, elapsed = 0) {
    const fadeIn = smoothstep(segment(p, 0, 0.18));
    const fadeOut = smoothstep(segment(p, 0.82, 1));
    const visibility = fadeIn * (1 - fadeOut);
    const unfold = easeOutCubic(segment(p, 0, 0.4));
    const pulse = 1 + Math.sin(elapsed * 2.1) * 0.025 * smoothstep(segment(p, 0.15, 0.3));

    this.gltfScene.visible = false;
    this.blueprintGroup.visible = visibility > 0.005;
    setLabelOpacity(this.labelBlueprint, visibility);

    for (const part of this.parts.values()) {
      part.wireframe.position.lerpVectors(part.restPos, part.explodedPos, unfold).multiplyScalar(1);
      part.wireframe.scale.setScalar(pulse);
      for (const child of part.wireframe.children) {
        const mat = (child as THREE.LineSegments).material as THREE.LineBasicMaterial | undefined;
        if (mat) mat.opacity = 0.85 * visibility;
      }
    }
  }

  setAssemblyProgress(p: number) {
    this.blueprintGroup.visible = false;
    setLabelOpacity(this.labelBlueprint, 0);
    this.gltfScene.visible = true;
    const n = CAR_PART_ORDER.length;
    let activeIndex = -1;
    CAR_PART_ORDER.forEach((key, i) => {
      const part = this.parts.get(key)!;
      const local = easeOutBack(segment(p, i / n, (i + 0.72) / n));
      const appear = clamp01(segment(p, i / n, (i + 0.12) / n));
      part.object.visible = appear > 0.001;
      part.object.position.lerpVectors(part.explodedPos, part.restPos, clamp01(local));
      const wobble = (1 - clamp01(local)) * 0.25;
      part.object.rotation.set(wobble, wobble * 0.6, 0);
      if (local > 0 && local < 1) activeIndex = i;
    });
    setLabelOpacity(this.labelSequence, smoothstep(segment(p, 0, 0.06)) * (1 - smoothstep(segment(p, 0.94, 1))));

    if (activeIndex === -1) {
      activeIndex = p >= 1 ? n - 1 : Math.max(0, Math.floor(p * n));
    }
    if (activeIndex !== this.lastStage2P) {
      this.lastStage2P = activeIndex;
      this.onKeyBeat?.(activeIndex, CAR_PART_ORDER[activeIndex]);
    }
  }

  /** Snap to the fully assembled resting pose (used when jumping straight to a later stage). */
  settle() {
    this.blueprintGroup.visible = false;
    setLabelOpacity(this.labelBlueprint, 0);
    setLabelOpacity(this.labelSequence, 0);
    this.gltfScene.visible = true;
    this.physicsActive = false;
    for (const part of this.parts.values()) {
      part.object.visible = true;
      part.object.position.copy(part.restPos);
      part.object.quaternion.copy(part.restQuat);
      part.object.rotation.set(0, 0, 0);
      part.body.type = CANNON.Body.KINEMATIC;
      part.body.velocity.set(0, 0, 0);
      part.body.angularVelocity.set(0, 0, 0);
    }
  }

  collapse(missingKey: CarPartKey = "cabin") {
    this.physicsActive = true;
    for (const part of this.parts.values()) {
      const body = part.body;
      body.type = CANNON.Body.DYNAMIC;
      body.wakeUp();
      const dropBias = part.key === missingKey ? 0 : 1;
      body.velocity.set((this.rng() - 0.5) * 2.2, 1.2 + this.rng() * 1.4, (this.rng() - 0.5) * 2.2);
      body.angularVelocity.set((this.rng() - 0.5) * 6 * dropBias, (this.rng() - 0.5) * 6, (this.rng() - 0.5) * 6 * dropBias);
    }
  }

  restore() {
    this.physicsActive = false;
    for (const part of this.parts.values()) {
      part.body.type = CANNON.Body.KINEMATIC;
      part.body.velocity.set(0, 0, 0);
      part.body.angularVelocity.set(0, 0, 0);
      const startPos = part.object.position.clone();
      const startQuat = part.object.quaternion.clone();
      const tw = { t: 0 };
      gsap.to(tw, {
        t: 1,
        duration: 1.5 + this.rng() * 0.3,
        ease: "power3.out",
        onUpdate: () => {
          part.object.position.lerpVectors(startPos, part.restPos, tw.t);
          part.object.quaternion.slerpQuaternions(startQuat, part.restQuat, tw.t);
        },
      });
    }
  }

  update(dt: number) {
    if (this.physicsActive) {
      this.world.step(1 / 60, dt, 3);
      for (const part of this.parts.values()) {
        const b = part.body;
        const offset = this.bodyOffsets.get(b)!;
        const q = new THREE.Quaternion(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
        const rotatedOffset = offset.clone().applyQuaternion(q);
        part.object.position.set(b.position.x, b.position.y, b.position.z).sub(rotatedOffset);
        part.object.quaternion.copy(q);
      }
    }
  }
}
