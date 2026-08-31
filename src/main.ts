import "./style.css";
import gsap from "gsap";
import { Engine, REDUCE_MOTION } from "./scene";
import { CarRig } from "./car";
import { FaceRig } from "./face";
import { TimelineController } from "./timeline";
import { createTimelineHandlers, hideLoading, initUi, setLoadingProgress, showLoadingError, wireControls } from "./ui";
import { assetUrl, injectFontFace } from "./utils";

async function main() {
  // Keep the timeline accurate to wall-clock time even when a frame takes
  // longer than GSAP's default lag-smoothing threshold (e.g. slow/software GPUs).
  gsap.ticker.lagSmoothing(0);

  injectFontFace();
  initUi();

  const canvas = document.getElementById("scene-canvas") as HTMLCanvasElement;
  const engine = new Engine(canvas);

  const car = new CarRig();
  const face = new FaceRig();
  engine.carAnchor.add(car.root);
  engine.faceAnchor.add(face.root);

  let progress = { env: 0, car: 0, face: 0 };
  const reportProgress = () => setLoadingProgress((progress.env + progress.car + progress.face) / 3);

  try {
    await Promise.all([
      engine.loadEnvironment(assetUrl("assets/hdri/studio.hdr")).then(() => {
        progress.env = 100;
        reportProgress();
      }),
      car.load(assetUrl("assets/models/car.glb")).then(() => {
        progress.car = 100;
        reportProgress();
      }),
      face.load(assetUrl("assets/models/face.glb"), engine.renderer).then(() => {
        progress.face = 100;
        reportProgress();
      }),
    ]);
  } catch (err) {
    console.error(err);
    showLoadingError("خطا در بارگذاری دارایی‌ها. لطفاً صفحه را دوباره بارگذاری کنید.");
    return;
  }

  hideLoading();

  const handlers = createTimelineHandlers();
  const controller = new TimelineController(car, face, handlers);
  wireControls(controller);

  engine.addUpdate((dt, elapsed) => {
    if (controller.isPlaying()) {
      car.update(dt);
      face.update(dt, elapsed);
    }
  });

  window.addEventListener("keydown", (ev) => {
    if (ev.code === "Space") {
      ev.preventDefault();
      controller.togglePlay();
    } else if (ev.key === "1" || ev.key === "2" || ev.key === "3") {
      controller.goToStage(Number(ev.key) as 1 | 2 | 3);
    } else if (ev.key.toLowerCase() === "r") {
      controller.restart();
    }
  });

  if (REDUCE_MOTION) {
    controller.goToStage(1);
    controller.pause();
  } else {
    controller.play();
  }

  engine.start();
}

main();
