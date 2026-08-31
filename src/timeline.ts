import gsap from "gsap";
import type { CarRig, CarPartKey } from "./car";
import type { FaceRig } from "./face";
import { CAR_PART_ORDER } from "./car";

export const CAPTIONS = {
  stage1: "هر موتر از یک نقشه (blueprint) شروع می‌شود؛ بدن هم از یک نقشه: ژن (gene). هر دو پیش از ساخت، نقشه‌ی دقیق دارند.",
  stage2: "قطعات موتر و سوراخ بینی، هر دو قدم‌به‌قدم و سر وقت ساخته می‌شوند؛ هر کلید (on/off) به‌موقع روشن و خاموش می‌شود.",
  stage3: "اگر فقط یک کلید روشن نشود، موتر فرومی‌پاشد و بینی ناقص می‌ماند. نظم به تک‌تک قطعه‌ها وابسته است.",
  finale: "نقشه، نقشه‌کش می‌خواهد. نظم، ناظم می‌خواهد.",
};

export const CAR_FAULT_INDEX = CAR_PART_ORDER.indexOf("cabin" as CarPartKey);
export const FACE_KEY_LABELS = ["جوانه (placode)", "فرورفتگی (invagination)"];
export const FACE_FAULT_INDEX = 1;

const STAGE1_DUR = 6.4;
const STAGE2_DUR = 7.6;
const COLLAPSE_HOLD = 2.0;
const RESTORE_HOLD = 2.0;
const FINALE_HOLD = 8.0;

type Phase = "stage1" | "stage2" | "stage3" | "finale";

export interface TimelineHandlers {
  onProgress: (percent: number) => void;
  onStage: (stage: 1 | 2 | 3) => void;
  onCaption: (text: string) => void;
  onFinale: (visible: boolean) => void;
  onPlayState: (playing: boolean) => void;
  onCarKeyBeat: (index: number) => void;
  onFaceKeyBeat: (index: number) => void;
  onKeyFault: () => void;
  onKeyRestored: () => void;
}

export class TimelineController {
  private tl: gsap.core.Timeline;
  private lastPhase: Phase | null = null;

  constructor(private car: CarRig, private face: FaceRig, private handlers: TimelineHandlers) {
    this.car.onKeyBeat = (index) => this.handlers.onCarKeyBeat(index);

    this.tl = gsap.timeline({
      paused: true,
      onUpdate: () => this.handleUpdate(),
    });

    this.tl.addLabel("stage1");
    const s1 = { p: 0 };
    this.tl.to(s1, {
      p: 1,
      duration: STAGE1_DUR,
      ease: "none",
      onUpdate: () => {
        this.car.setBlueprintProgress(s1.p, this.tl.time());
        this.face.setBlueprintProgress(s1.p, this.tl.time());
      },
    });

    this.tl.addLabel("stage2");
    const s2 = { p: 0 };
    this.tl.to(s2, {
      p: 1,
      duration: STAGE2_DUR,
      ease: "none",
      onUpdate: () => {
        this.car.setAssemblyProgress(s2.p);
        this.face.setAssemblyProgress(s2.p);
        this.handlers.onFaceKeyBeat(s2.p < 0.42 ? 0 : 1);
      },
    });

    this.tl.addLabel("stage3");
    this.tl.call(() => {
      this.car.collapse("cabin");
      this.face.collapse();
      this.handlers.onKeyFault();
    });
    this.tl.to({}, { duration: COLLAPSE_HOLD });
    this.tl.call(() => {
      this.car.restore();
      this.face.restore();
      this.handlers.onKeyRestored();
    });
    this.tl.to({}, { duration: RESTORE_HOLD });

    this.tl.addLabel("finale");
    this.tl.to({}, { duration: FINALE_HOLD });
  }

  private phaseAt(time: number): Phase {
    const l = this.tl.labels;
    if (time < l["stage2"]) return "stage1";
    if (time < l["stage3"]) return "stage2";
    if (time < l["finale"]) return "stage3";
    return "finale";
  }

  private handleUpdate() {
    this.handlers.onProgress(this.tl.progress() * 100);
    const phase = this.phaseAt(this.tl.time());
    if (phase !== this.lastPhase) {
      this.lastPhase = phase;
      if (phase === "finale") {
        this.handlers.onFinale(true);
        this.handlers.onCaption(CAPTIONS.finale);
        this.handlers.onStage(3);
      } else {
        this.handlers.onFinale(false);
        this.handlers.onCaption(CAPTIONS[phase]);
        this.handlers.onStage(phase === "stage1" ? 1 : phase === "stage2" ? 2 : 3);
      }
    }
  }

  play() {
    this.tl.play();
    this.handlers.onPlayState(true);
  }

  pause() {
    this.tl.pause();
    this.handlers.onPlayState(false);
  }

  togglePlay(): boolean {
    if (this.tl.paused()) {
      this.play();
    } else {
      this.pause();
    }
    return !this.tl.paused();
  }

  isPlaying(): boolean {
    return !this.tl.paused();
  }

  restart() {
    this.car.settle();
    this.face.settle();
    this.lastPhase = null;
    this.tl.pause(0);
    this.play();
  }

  goToStage(n: 1 | 2 | 3) {
    this.car.settle();
    this.face.settle();
    this.lastPhase = null;
    this.tl.pause(`stage${n}`);
    this.play();
  }
}
