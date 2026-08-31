import * as THREE from "three";
import gsap from "gsap";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import { clamp01, easeOutCubic, makeLabelSprite, segment, setLabelOpacity, smoothstep } from "./utils";

// A symbolic side-by-side display scale (not anatomical): sized to read clearly
// next to the car, roughly matching its visual presence rather than real head size.
const TARGET_HEAD_HEIGHT = 1.5; // metres, world scale once normalized
const WORLD_NOSTRIL_RADIUS = TARGET_HEAD_HEIGHT * 0.0262; // gaussian falloff radius, metres
const WORLD_NOSTRIL_DEPTH = TARGET_HEAD_HEIGHT * 0.02; // pit depth, metres
const WORLD_PLACODE_RADIUS = TARGET_HEAD_HEIGHT * 0.0185;
/** Flip if the nose-tip search picks the back of the head instead of the face — verified visually. */
const FACE_FORWARD_SIGN = 1;

export class FaceRig {
  readonly root = new THREE.Group();
  ready: Promise<void>;

  private headMesh!: THREE.Mesh;
  private basePositions!: Float32Array;
  private baseNormals!: Float32Array;
  private nostrilLocal: [THREE.Vector3, THREE.Vector3] = [new THREE.Vector3(), new THREE.Vector3()];
  private nostrilWorld: [THREE.Vector3, THREE.Vector3] = [new THREE.Vector3(), new THREE.Vector3()];
  private localRadius = 0;
  private localDepth = 0;
  private progress: [number, number] = [0, 0]; // left, right formation depth 0..1
  private placodes: THREE.Mesh[] = [];
  private faultLight?: THREE.PointLight;

  private dnaGroup = new THREE.Group();
  private bookletGroup = new THREE.Group();
  private labelGene: THREE.Sprite;
  private labelSequence: THREE.Sprite;
  private headTop = 0.3;

  constructor() {
    this.labelGene = makeLabelSprite("بدن (gene)", "#ffb27a");
    this.labelSequence = makeLabelSprite("به‌ترتیب (in sequence)", "#ffb27a");
    setLabelOpacity(this.labelGene, 0);
    setLabelOpacity(this.labelSequence, 0);
    this.root.add(this.dnaGroup, this.bookletGroup, this.labelGene, this.labelSequence);
    this.buildDna();
    this.buildBooklet();
    this.ready = Promise.resolve();
  }

  async load(url: string, renderer: THREE.WebGLRenderer) {
    const ktx2 = new KTX2Loader().setTranscoderPath("/assets/basis/").detectSupport(renderer);
    const loader = new GLTFLoader();
    loader.setKTX2Loader(ktx2);

    const gltf = await loader.loadAsync(url);
    const scene = gltf.scene as THREE.Group;
    scene.updateMatrixWorld(true);

    const headNode = scene.getObjectByName("head")!;
    let headMesh: THREE.Mesh | undefined;
    headNode.traverse((o) => {
      if (!headMesh && (o as THREE.Mesh).isMesh) headMesh = o as THREE.Mesh;
    });
    this.headMesh = headMesh!;

    // Normalise the whole rig so the head is a believable real-world size.
    const rawBox = new THREE.Box3().setFromObject(this.headMesh);
    const rawHeight = rawBox.getSize(new THREE.Vector3()).y || 1;
    const normalizeScale = TARGET_HEAD_HEIGHT / rawHeight;
    scene.scale.setScalar(normalizeScale);
    scene.updateMatrixWorld(true);

    this.applySkinMaterial(scene);
    this.locateNostrils(scene);
    this.captureBaseGeometry();
    this.buildPlacodes();

    const box = new THREE.Box3().setFromObject(scene);
    const center = box.getCenter(new THREE.Vector3());
    scene.position.set(-center.x, -box.min.y, -center.z);
    scene.updateMatrixWorld(true);
    this.headTop = box.max.y - box.min.y;

    this.root.add(scene);
    this.labelGene.position.set(0, this.headTop + 0.09, 0);
    this.labelSequence.position.set(0, this.headTop + 0.09, 0);
    this.dnaGroup.position.set(0, this.headTop * 0.55, 0);

    this.setAssemblyProgress(0);
    this.setBlueprintProgress(0);
  }

  private applySkinMaterial(scene: THREE.Group) {
    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!(mesh as any).isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      if (mesh === this.headMesh) {
        const original = mesh.material as THREE.MeshStandardMaterial;
        mesh.material = new THREE.MeshPhysicalMaterial({
          map: original.map ?? null,
          color: original.map ? 0xffffff : 0xe8b79a,
          roughness: 0.52,
          metalness: 0,
          clearcoat: 0.22,
          clearcoatRoughness: 0.4,
          sheen: 1,
          sheenColor: new THREE.Color(0xff9d6c),
          sheenRoughness: 0.75,
          envMapIntensity: 0.85,
        });
      } else {
        const m = mesh.material as THREE.MeshStandardMaterial;
        if (m && "envMapIntensity" in m) m.envMapIntensity = 1.0;
      }
    });
  }

  /** Finds the nose tip via the eye sockets' geometric frame, then derives nostril centres from it. */
  private locateNostrils(scene: THREE.Group) {
    const eyeLeftNode = scene.getObjectByName("grp_eyeLeft")!;
    const eyeRightNode = scene.getObjectByName("grp_eyeRight")!;
    eyeLeftNode.updateWorldMatrix(true, false);
    eyeRightNode.updateWorldMatrix(true, false);
    const eyeL = new THREE.Vector3().setFromMatrixPosition(eyeLeftNode.matrixWorld);
    const eyeR = new THREE.Vector3().setFromMatrixPosition(eyeRightNode.matrixWorld);
    const eyeMid = eyeL.clone().add(eyeR).multiplyScalar(0.5);
    const eyeSeparation = eyeL.distanceTo(eyeR) || 0.06;
    const rightAxis = eyeR.clone().sub(eyeL).normalize();
    const upAxis = new THREE.Vector3(0, 1, 0);
    const forwardAxis = new THREE.Vector3().crossVectors(upAxis, rightAxis).normalize().multiplyScalar(FACE_FORWARD_SIGN);

    this.headMesh.updateWorldMatrix(true, false);
    const posAttr = this.headMesh.geometry.attributes.position as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    const rel = new THREE.Vector3();
    const centerBand = eyeSeparation * 0.16;
    let bestDepth = -Infinity;
    const noseTip = new THREE.Vector3();
    for (let i = 0; i < posAttr.count; i++) {
      v.fromBufferAttribute(posAttr, i).applyMatrix4(this.headMesh.matrixWorld);
      rel.subVectors(v, eyeMid);
      const lateral = rel.dot(rightAxis);
      if (Math.abs(lateral) > centerBand) continue;
      const vertical = rel.dot(upAxis);
      if (vertical > eyeSeparation * 0.1 || vertical < -eyeSeparation * 1.6) continue;
      const depth = rel.dot(forwardAxis);
      if (depth > bestDepth) {
        bestDepth = depth;
        noseTip.copy(v);
      }
    }

    const lateralOffset = eyeSeparation * 0.2;
    const downOffset = eyeSeparation * 0.12;
    const backOffset = eyeSeparation * 0.09;
    const worldL = noseTip.clone().addScaledVector(rightAxis, -lateralOffset).addScaledVector(upAxis, -downOffset).addScaledVector(forwardAxis, -backOffset);
    const worldR = noseTip.clone().addScaledVector(rightAxis, lateralOffset).addScaledVector(upAxis, -downOffset).addScaledVector(forwardAxis, -backOffset);

    const inv = new THREE.Matrix4().copy(this.headMesh.matrixWorld).invert();
    this.nostrilLocal = [worldL.clone().applyMatrix4(inv), worldR.clone().applyMatrix4(inv)];

    const scaleVec = new THREE.Vector3();
    this.headMesh.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), scaleVec);
    const worldToLocal = 1 / (scaleVec.x || 1);
    this.localRadius = WORLD_NOSTRIL_RADIUS * worldToLocal;
    this.localDepth = WORLD_NOSTRIL_DEPTH * worldToLocal;

    // Keep world-space anchors around for the glowing placode markers.
    this.nostrilWorld = [worldL, worldR];
  }

  private captureBaseGeometry() {
    const geo = this.headMesh.geometry as THREE.BufferGeometry;
    const posAttr = geo.attributes.position as THREE.BufferAttribute;
    const normAttr = geo.attributes.normal as THREE.BufferAttribute;
    this.basePositions = Float32Array.from(posAttr.array as ArrayLike<number>);
    this.baseNormals = Float32Array.from(normAttr.array as ArrayLike<number>);
    geo.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(this.basePositions), 3));
  }

  private buildPlacodes() {
    const worlds = this.nostrilWorld;
    const geo = new THREE.SphereGeometry(WORLD_PLACODE_RADIUS, 20, 16);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffcf9e, transparent: true, opacity: 0, toneMapped: false });
    for (const w of worlds) {
      const mesh = new THREE.Mesh(geo, mat.clone());
      mesh.position.copy(w);
      this.root.add(mesh);
      this.placodes.push(mesh);
    }
    const light = new THREE.PointLight(0xffb27a, 0, 0.4, 2);
    const mid = worlds[0].clone().add(worlds[1]).multiplyScalar(0.5);
    light.position.copy(mid);
    this.root.add(light);
    this.faultLight = light;
  }

  private buildDna() {
    const strandColors = [0x7fd3ff, 0xff9d6c];
    const turns = 3.2;
    const beadsPerStrand = 44;
    const radius = 0.34;
    const height = 1.55;
    const geo = new THREE.SphereGeometry(0.028, 10, 8);
    for (let s = 0; s < 2; s++) {
      const mat = new THREE.MeshBasicMaterial({ color: strandColors[s], toneMapped: false });
      const strandGroup = new THREE.Group();
      strandGroup.name = `dna-strand-${s}`;
      for (let i = 0; i < beadsPerStrand; i++) {
        const t = i / (beadsPerStrand - 1);
        const angle = t * Math.PI * 2 * turns + s * Math.PI;
        const bead = new THREE.Mesh(geo, mat);
        bead.position.set(Math.cos(angle) * radius, t * height - height / 2, Math.sin(angle) * radius);
        strandGroup.add(bead);
      }
      this.dnaGroup.add(strandGroup);
    }
    const rungMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, toneMapped: false });
    const rungGeo = new THREE.CylinderGeometry(0.006, 0.006, radius * 2, 6);
    for (let i = 0; i < 16; i++) {
      const t = i / 15;
      const angle = t * Math.PI * 2 * turns;
      const rung = new THREE.Mesh(rungGeo, rungMat);
      rung.position.set(0, t * height - height / 2, 0);
      rung.rotation.z = Math.PI / 2;
      rung.rotation.y = -angle;
      this.dnaGroup.add(rung);
    }
  }

  private buildBooklet() {
    const cover = new THREE.Mesh(
      new THREE.BoxGeometry(0.26, 0.34, 0.02),
      new THREE.MeshPhysicalMaterial({ color: 0xfff2e3, roughness: 0.4, clearcoat: 0.5, emissive: 0xffb27a, emissiveIntensity: 0.12 })
    );
    this.bookletGroup.add(cover);
    const lineMat = new THREE.MeshBasicMaterial({ color: 0xff9d6c, transparent: true, opacity: 0.8, toneMapped: false });
    for (let i = 0; i < 5; i++) {
      const line = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.008), lineMat);
      line.position.set(0, 0.1 - i * 0.045, 0.011);
      this.bookletGroup.add(line);
    }
    this.bookletGroup.visible = false;
  }

  setBlueprintProgress(p: number, elapsed = 0) {
    const fadeIn = smoothstep(segment(p, 0, 0.16));
    const fadeOutHelix = smoothstep(segment(p, 0.62, 0.8));
    const bookletIn = smoothstep(segment(p, 0.68, 0.86));
    const fadeOutAll = smoothstep(segment(p, 0.9, 1));

    const helixVisibility = fadeIn * (1 - fadeOutHelix);
    this.dnaGroup.visible = helixVisibility > 0.005;
    this.dnaGroup.rotation.y = elapsed * 0.6;
    this.dnaGroup.scale.setScalar(0.4 + 0.6 * easeOutCubic(segment(p, 0, 0.22)));
    this.dnaGroup.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
      if (m && "opacity" in m) m.opacity = (m.userData?.baseOpacity ?? 1) * helixVisibility * (1 - fadeOutAll);
    });
    this.dnaGroup.children.forEach((child) => {
      child.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if ((mesh as any).isMesh) mesh.visible = helixVisibility > 0.02;
      });
    });

    const bookletVisibility = bookletIn * (1 - fadeOutAll);
    this.bookletGroup.visible = bookletVisibility > 0.01;
    this.bookletGroup.position.set(0, this.headTop * 0.55, 0);
    this.bookletGroup.rotation.y = Math.sin(elapsed * 0.8) * 0.25;
    this.bookletGroup.scale.setScalar(0.7 + 0.3 * bookletIn);
    this.bookletGroup.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshBasicMaterial | THREE.MeshPhysicalMaterial | undefined;
      if (m && "opacity" in m) (m as any).opacity = bookletVisibility;
      if (m && "transparent" in m) (m as any).transparent = true;
    });

    setLabelOpacity(this.labelGene, helixVisibility);
    this.headMesh.visible = false;
    this.placodes.forEach((p2) => (p2.visible = false));
  }

  setAssemblyProgress(p: number) {
    this.dnaGroup.visible = false;
    this.bookletGroup.visible = false;
    setLabelOpacity(this.labelGene, 0);
    this.headMesh.visible = true;

    const placodeVis = smoothstep(segment(p, 0, 0.28)) * (1 - smoothstep(segment(p, 0.42, 0.5)));
    const pitAmount = easeOutCubic(segment(p, 0.4, 1));
    this.placodes.forEach((mesh) => {
      mesh.visible = placodeVis > 0.01;
      const mat = mesh.material as THREE.MeshBasicMaterial;
      mat.opacity = placodeVis;
      const s = 1 + Math.sin(p * 40) * 0.08;
      mesh.scale.setScalar(s);
    });

    this.progress[0] = pitAmount;
    this.progress[1] = pitAmount;
    this.applyDeformation();

    setLabelOpacity(this.labelSequence, smoothstep(segment(p, 0, 0.06)) * (1 - smoothstep(segment(p, 0.94, 1))));
  }

  /** Snap to the fully-formed resting pose. */
  settle() {
    this.dnaGroup.visible = false;
    this.bookletGroup.visible = false;
    setLabelOpacity(this.labelGene, 0);
    setLabelOpacity(this.labelSequence, 0);
    this.headMesh.visible = true;
    this.placodes.forEach((mesh) => (mesh.visible = false));
    if (this.faultLight) this.faultLight.intensity = 0;
    gsap.killTweensOf(this.progress);
    this.progress[0] = 1;
    this.progress[1] = 1;
    this.applyDeformation();
  }

  collapse() {
    gsap.killTweensOf(this.progress);
    gsap.to(this.progress, {
      1: 0.14,
      duration: 0.9,
      ease: "power2.inOut",
      onUpdate: () => this.applyDeformation(),
    });
    if (this.faultLight) {
      gsap.timeline()
        .to(this.faultLight, { intensity: 2.2, duration: 0.25 })
        .to(this.faultLight.color, { r: 1, g: 0.24, b: 0.24, duration: 0.25 }, "<")
        .to(this.faultLight, { intensity: 0.5, duration: 0.6 });
    }
  }

  restore() {
    gsap.killTweensOf(this.progress);
    gsap.to(this.progress, {
      1: 1,
      duration: 1.3,
      ease: "power2.out",
      onUpdate: () => this.applyDeformation(),
    });
    if (this.faultLight) {
      gsap.timeline()
        .to(this.faultLight.color, { r: 0.34, g: 0.89, b: 0.6, duration: 0.3 })
        .to(this.faultLight, { intensity: 1.4, duration: 0.3 }, "<")
        .to(this.faultLight, { intensity: 0, duration: 0.8 });
    }
  }

  private applyDeformation() {
    const geo = this.headMesh.geometry as THREE.BufferGeometry;
    const posAttr = geo.attributes.position as THREE.BufferAttribute;
    const arr = posAttr.array as Float32Array;
    const sigma2 = this.localRadius * this.localRadius * 2;
    const centers = this.nostrilLocal;
    const progress = this.progress;
    for (let i = 0; i < posAttr.count; i++) {
      const ix = i * 3;
      const bx = this.basePositions[ix];
      const by = this.basePositions[ix + 1];
      const bz = this.basePositions[ix + 2];
      let depth = 0;
      for (let c = 0; c < 2; c++) {
        const center = centers[c];
        const dx = bx - center.x;
        const dy = by - center.y;
        const dz = bz - center.z;
        const g = Math.exp(-(dx * dx + dy * dy + dz * dz) / sigma2);
        depth = Math.max(depth, g * progress[c]);
      }
      const nx = this.baseNormals[ix];
      const ny = this.baseNormals[ix + 1];
      const nz = this.baseNormals[ix + 2];
      arr[ix] = bx - nx * depth * this.localDepth;
      arr[ix + 1] = by - ny * depth * this.localDepth;
      arr[ix + 2] = bz - nz * depth * this.localDepth;
    }
    posAttr.needsUpdate = true;
    geo.computeVertexNormals();
  }

  update(_dt: number, elapsed: number) {
    const breathe = 1 + Math.sin(elapsed * 1.15) * 0.004;
    this.root.scale.set(breathe, breathe, breathe);
  }
}
