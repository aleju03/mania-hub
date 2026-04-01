import { useCallback, useEffect, useRef } from "react";

const NOTE_IMAGES: { src: string; aspect: "square" | "bar"; tint: string }[] = [
  { src: "/images/notes/arrow-down-gray.png", aspect: "square", tint: "rgba(225, 225, 235, 0.36)" },
  { src: "/images/notes/arrow-down-green.png", aspect: "square", tint: "rgba(166, 228, 120, 0.38)" },
  { src: "/images/notes/arrow-left-gray.png", aspect: "square", tint: "rgba(225, 225, 235, 0.36)" },
  { src: "/images/notes/arrow-left-pink.png", aspect: "square", tint: "rgba(255, 131, 192, 0.36)" },
  { src: "/images/notes/arrow-right-gray.png", aspect: "square", tint: "rgba(225, 225, 235, 0.36)" },
  { src: "/images/notes/arrow-right-green.png", aspect: "square", tint: "rgba(166, 228, 120, 0.38)" },
  { src: "/images/notes/arrow-up-gray.png", aspect: "square", tint: "rgba(225, 225, 235, 0.36)" },
  { src: "/images/notes/arrow-up-pink.png", aspect: "square", tint: "rgba(255, 131, 192, 0.36)" },
  { src: "/images/notes/bar-blue.png", aspect: "bar", tint: "rgba(102, 186, 255, 0.36)" },
  { src: "/images/notes/bar-gray.png", aspect: "bar", tint: "rgba(225, 225, 235, 0.34)" },
  { src: "/images/notes/bar-red.png", aspect: "bar", tint: "rgba(255, 126, 126, 0.36)" },
  { src: "/images/notes/bar-yellow.png", aspect: "bar", tint: "rgba(255, 214, 115, 0.36)" },
  { src: "/images/notes/circle-blue.png", aspect: "square", tint: "rgba(102, 186, 255, 0.35)" },
  { src: "/images/notes/circle-blue-light.png", aspect: "square", tint: "rgba(135, 214, 255, 0.35)" },
  { src: "/images/notes/circle-gray.png", aspect: "square", tint: "rgba(225, 225, 235, 0.34)" },
  { src: "/images/notes/circle-green.png", aspect: "square", tint: "rgba(166, 228, 120, 0.38)" },
  { src: "/images/notes/circle-navy.png", aspect: "square", tint: "rgba(121, 148, 255, 0.3)" },
  { src: "/images/notes/circle-pink.png", aspect: "square", tint: "rgba(255, 131, 192, 0.36)" },
  { src: "/images/notes/circle-pink-glow.png", aspect: "square", tint: "rgba(255, 149, 206, 0.42)" },
  { src: "/images/notes/circle-purple.png", aspect: "square", tint: "rgba(184, 146, 255, 0.34)" },
  { src: "/images/notes/circle-violet.png", aspect: "square", tint: "rgba(174, 127, 255, 0.34)" },
  { src: "/images/notes/circle-white.png", aspect: "square", tint: "rgba(245, 245, 250, 0.34)" },
];

interface FallingNote {
  x: number;
  y: number;
  speed: number;
  size: number;
  opacity: number;
  imgIndex: number;
  rotation: number;
  rotSpeed: number;
  isLN: boolean;
  lnHeight: number;
}

let cachedNoteImages: HTMLImageElement[] | null = null;

function getNoteImages(): HTMLImageElement[] {
  if (cachedNoteImages) return cachedNoteImages;

  cachedNoteImages = NOTE_IMAGES.map((note) => {
    const image = new Image();
    image.decoding = "async";
    image.src = note.src;
    return image;
  });

  return cachedNoteImages;
}

function createNote(canvasW: number, canvasH: number, startAbove: boolean): FallingNote {
  const isLN = Math.random() < 0.05;

  return {
    x: Math.random() * canvasW,
    y: startAbove ? -(Math.random() * canvasH) : Math.random() * canvasH,
    speed: 9 + Math.random() * 18,
    size: 18 + Math.random() * 22,
    opacity: 0.03 + Math.random() * 0.07,
    imgIndex: Math.floor(Math.random() * NOTE_IMAGES.length),
    rotation: Math.random() * Math.PI * 2,
    rotSpeed: (Math.random() - 0.5) * 0.3,
    isLN,
    lnHeight: isLN ? 30 + Math.random() * 200 : 0,
  };
}

function resetNote(note: FallingNote, canvasW: number, canvasH: number) {
  const fresh = createNote(canvasW, canvasH, true);
  note.x = fresh.x;
  note.y = fresh.y;
  note.speed = fresh.speed;
  note.size = fresh.size;
  note.opacity = fresh.opacity;
  note.imgIndex = fresh.imgIndex;
  note.rotation = fresh.rotation;
  note.rotSpeed = fresh.rotSpeed;
  note.isLN = fresh.isLN;
  note.lnHeight = fresh.lnHeight;
}

function drawFallbackNote(
  context: CanvasRenderingContext2D,
  note: FallingNote,
  drawWidth: number,
  drawHeight: number,
  tint: string,
) {
  context.fillStyle = tint;

  if (NOTE_IMAGES[note.imgIndex].aspect === "bar") {
    context.beginPath();
    context.roundRect(-drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight, drawHeight / 2);
    context.fill();
    return;
  }

  context.beginPath();
  context.arc(0, 0, drawWidth / 2, 0, Math.PI * 2);
  context.fill();
}

export function ManiaRain() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const notesRef = useRef<FallingNote[]>([]);
  const imagesRef = useRef<HTMLImageElement[]>([]);
  const rafRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number | null>(null);
  const animateRef = useRef<(time: number) => void>(() => undefined);

  const ensureCanvasSize = useCallback((preservePositions: boolean) => {
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    if (!canvas || !parent) return;

    const rect = parent.getBoundingClientRect();
    const nextWidth = Math.max(1, Math.round(rect.width));
    const nextHeight = Math.max(1, Math.round(rect.height));
    const previousWidth = canvas.width || nextWidth;
    const previousHeight = canvas.height || nextHeight;

    if (canvas.width === nextWidth && canvas.height === nextHeight) {
      return;
    }

    canvas.width = nextWidth;
    canvas.height = nextHeight;

    if (notesRef.current.length === 0 || !preservePositions) {
      const count = 55;
      const cols = Math.ceil(Math.sqrt(count * (canvas.width / canvas.height)));
      const rows = Math.ceil(count / cols);
      const cellW = canvas.width / cols;
      const cellH = canvas.height / rows;
      const notes: FallingNote[] = [];

      for (let row = 0; row < rows && notes.length < count; row++) {
        for (let col = 0; col < cols && notes.length < count; col++) {
          const note = createNote(canvas.width, canvas.height, false);
          note.x = (col + 0.15 + Math.random() * 0.7) * cellW;
          note.y = (row + Math.random()) * cellH;
          notes.push(note);
        }
      }

      notesRef.current = notes;
      return;
    }

    const scaleX = nextWidth / previousWidth;
    const scaleY = nextHeight / previousHeight;
    notesRef.current = notesRef.current.map((note) => ({
      ...note,
      x: note.x * scaleX,
      y: note.y * scaleY,
      size: note.size * Math.min(1.08, Math.max(0.92, scaleX)),
      lnHeight: note.lnHeight * scaleY,
    }));
  }, []);

  useEffect(() => {
    imagesRef.current = getNoteImages();
    ensureCanvasSize(false);

    const handleResize = () => {
      ensureCanvasSize(true);
      lastTimeRef.current = performance.now();
    };

    const stopAnimation = () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      lastTimeRef.current = null;
    };

    const startAnimation = () => {
      if (rafRef.current != null) return;
      lastTimeRef.current = performance.now();
      rafRef.current = requestAnimationFrame(animateRef.current);
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        stopAnimation();
      } else {
        ensureCanvasSize(true);
        startAnimation();
      }
    };

    animateRef.current = (time: number) => {
      const canvas = canvasRef.current;
      if (!canvas) {
        rafRef.current = null;
        return;
      }

      const context = canvas.getContext("2d");
      if (!context) {
        rafRef.current = null;
        return;
      }

      const rawDt = lastTimeRef.current == null ? 0.016 : (time - lastTimeRef.current) / 1000;
      const dt = Math.min(0.05, Math.max(0.008, rawDt));
      lastTimeRef.current = time;

      context.clearRect(0, 0, canvas.width, canvas.height);

      for (const note of notesRef.current) {
        note.y += note.speed * dt;
        if (!note.isLN) note.rotation += note.rotSpeed * dt;

        const totalHeight = note.isLN ? note.lnHeight + note.size : note.size;
        if (note.y > canvas.height + totalHeight) {
          resetNote(note, canvas.width, canvas.height);
        }

        const image = imagesRef.current[note.imgIndex];

        context.save();
        context.globalAlpha = note.opacity;
        context.translate(note.x, note.y);

        const isBar = NOTE_IMAGES[note.imgIndex].aspect === "bar";
        const drawWidth = isBar ? note.size * 1.4 : note.size;
        const drawHeight = isBar ? note.size * 0.3 : note.size;

        if (note.isLN) {
          const bodyWidth = note.size * 0.5;
          const radius = bodyWidth / 2;
          context.save();
          context.beginPath();
          context.rect(-canvas.width, -canvas.height, canvas.width * 2, canvas.height * 2);
          context.rect(-drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
          context.clip("evenodd");
          context.beginPath();
          context.moveTo(-bodyWidth / 2, 0);
          context.lineTo(-bodyWidth / 2, -note.lnHeight + radius);
          context.arcTo(-bodyWidth / 2, -note.lnHeight, 0, -note.lnHeight, radius);
          context.arcTo(bodyWidth / 2, -note.lnHeight, bodyWidth / 2, -note.lnHeight + radius, radius);
          context.lineTo(bodyWidth / 2, 0);
          context.closePath();
          context.fillStyle = "rgba(255, 255, 255, 0.3)";
          context.fill();
          context.restore();
        }

        context.rotate(note.rotation);
        if (image?.complete && image.naturalWidth > 0) {
          context.drawImage(image, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
        } else {
          drawFallbackNote(context, note, drawWidth, drawHeight, NOTE_IMAGES[note.imgIndex].tint);
        }
        context.restore();
      }

      rafRef.current = requestAnimationFrame(animateRef.current);
    };

    window.addEventListener("resize", handleResize, { passive: true });
    document.addEventListener("visibilitychange", handleVisibilityChange);
    startAnimation();

    return () => {
      stopAnimation();
      window.removeEventListener("resize", handleResize);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [ensureCanvasSize]);

  return <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none" />;
}
