import { CAR_PART_LABELS, CAR_PART_ORDER } from "./car";
import { CAR_FAULT_INDEX, FACE_FAULT_INDEX, FACE_KEY_LABELS } from "./timeline";
import type { TimelineHandlers } from "./timeline";
import type { TimelineController } from "./timeline";

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
}

function buildKeyRow(container: HTMLElement, labels: string[]) {
  container.innerHTML = "";
  labels.forEach((label) => {
    const item = document.createElement("div");
    item.className = "key-led";
    const dot = document.createElement("span");
    dot.className = "dot";
    const text = document.createElement("span");
    text.textContent = label;
    item.append(dot, text);
    container.appendChild(item);
  });
}

export function initUi() {
  buildKeyRow(el("key-row-car"), CAR_PART_ORDER.map((k) => CAR_PART_LABELS[k]));
  buildKeyRow(el("key-row-face"), FACE_KEY_LABELS);
}

function setKeyState(row: HTMLElement, index: number, state: "off" | "on" | "fault") {
  const items = row.querySelectorAll<HTMLElement>(".key-led");
  items.forEach((item, i) => {
    item.classList.remove("on", "fault");
    if (i === index && state !== "off") item.classList.add(state);
  });
}

export function createTimelineHandlers(): TimelineHandlers {
  const progressFill = el<HTMLDivElement>("progress-fill");
  const progressTrack = el<HTMLDivElement>("progress-track");
  const captionText = el<HTMLParagraphElement>("caption-text");
  const finaleOverlay = el<HTMLDivElement>("finale-overlay");
  const playBtn = el<HTMLButtonElement>("btn-play");
  const playLabel = playBtn.querySelector<HTMLSpanElement>(".play-label")!;
  const stageDots = Array.from(document.querySelectorAll<HTMLElement>(".stage-dot"));
  const stageButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".stage-btn"));
  const carRow = el<HTMLDivElement>("key-row-car");
  const faceRow = el<HTMLDivElement>("key-row-face");
  const captionPanel = el<HTMLDivElement>("caption-panel");

  let faultTimer: ReturnType<typeof setTimeout> | null = null;

  return {
    onProgress(percent) {
      progressFill.style.width = `${percent}%`;
      progressTrack.setAttribute("aria-valuenow", String(Math.round(percent)));
    },
    onStage(stage) {
      stageDots.forEach((dot) => dot.classList.toggle("active", Number(dot.dataset.stage) === stage));
      stageButtons.forEach((btn) => btn.setAttribute("aria-pressed", String(Number(btn.dataset.stage) === stage)));
      const showKeys = stage === 2 || stage === 3;
      carRow.classList.toggle("visible", showKeys);
      faceRow.classList.toggle("visible", showKeys);
    },
    onCaption(text) {
      captionText.textContent = text;
    },
    onFinale(visible) {
      finaleOverlay.classList.toggle("visible", visible);
      finaleOverlay.setAttribute("aria-hidden", String(!visible));
      captionPanel.style.opacity = visible ? "0" : "1";
    },
    onPlayState(playing) {
      playBtn.setAttribute("aria-pressed", String(playing));
      playLabel.textContent = playing ? "توقف" : "پخش";
    },
    onCarKeyBeat(index) {
      setKeyState(carRow, index, "on");
    },
    onFaceKeyBeat(index) {
      setKeyState(faceRow, index, "on");
    },
    onKeyFault() {
      setKeyState(carRow, CAR_FAULT_INDEX, "fault");
      setKeyState(faceRow, FACE_FAULT_INDEX, "fault");
    },
    onKeyRestored() {
      if (faultTimer) clearTimeout(faultTimer);
      setKeyState(carRow, CAR_FAULT_INDEX, "on");
      setKeyState(faceRow, FACE_FAULT_INDEX, "on");
      faultTimer = setTimeout(() => {
        setKeyState(carRow, -1, "off");
        setKeyState(faceRow, -1, "off");
      }, 900);
    },
  };
}

export function wireControls(controller: TimelineController) {
  const stageButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".stage-btn"));
  stageButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const stage = Number(btn.dataset.stage) as 1 | 2 | 3;
      controller.goToStage(stage);
    });
  });

  el<HTMLButtonElement>("btn-play").addEventListener("click", () => {
    controller.togglePlay();
  });

  el<HTMLButtonElement>("btn-restart").addEventListener("click", () => {
    controller.restart();
  });
}

export function setLoadingProgress(pct: number) {
  const fill = document.getElementById("loading-bar-fill");
  if (fill) fill.style.width = `${Math.round(pct)}%`;
}

export function hideLoading() {
  const overlay = el<HTMLDivElement>("loading-overlay");
  overlay.classList.add("hidden");
  window.setTimeout(() => overlay.remove(), 700);
}

export function showLoadingError(message: string) {
  const text = document.getElementById("loading-text");
  if (text) text.textContent = message;
}
