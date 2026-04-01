import { useCallback, useEffect, useRef } from "react";

const NOTE_IMAGES: { src: string; aspect: "square" | "bar" }[] = [
  { src: "/images/notes/arrow-down-gray.png", aspect: "square" },
  { src: "/images/notes/arrow-down-green.png", aspect: "square" },
  { src: "/images/notes/arrow-left-gray.png", aspect: "square" },
  { src: "/images/notes/arrow-left-pink.png", aspect: "square" },
  { src: "/images/notes/arrow-right-gray.png", aspect: "square" },
  { src: "/images/notes/arrow-right-green.png", aspect: "square" },
  { src: "/images/notes/arrow-up-gray.png", aspect: "square" },
  { src: "/images/notes/arrow-up-pink.png", aspect: "square" },
  { src: "/images/notes/bar-blue.png", aspect: "bar" },
  { src: "/images/notes/bar-gray.png", aspect: "bar" },
  { src: "/images/notes/bar-red.png", aspect: "bar" },
  { src: "/images/notes/bar-yellow.png", aspect: "bar" },
  { src: "/images/notes/circle-blue.png", aspect: "square" },
  { src: "/images/notes/circle-blue-light.png", aspect: "square" },
  { src: "/images/notes/circle-gray.png", aspect: "square" },
  { src: "/images/notes/circle-green.png", aspect: "square" },
  { src: "/images/notes/circle-navy.png", aspect: "square" },
  { src: "/images/notes/circle-pink.png", aspect: "square" },
  { src: "/images/notes/circle-pink-glow.png", aspect: "square" },
  { src: "/images/notes/circle-purple.png", aspect: "square" },
  { src: "/images/notes/circle-violet.png", aspect: "square" },
  { src: "/images/notes/circle-white.png", aspect: "square" },
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

function createNote(canvasW: number, canvasH: number, startAbove: boolean): FallingNote {
  const isLN = Math.random() < 0.05;

  return {
    x: Math.random() * canvasW,
    y: startAbove ? -(Math.random() * canvasH) : Math.random() * canvasH,
    speed: 15 + Math.random() * 35,
    size: 18 + Math.random() * 22,
    opacity: 0.03 + Math.random() * 0.07,
    imgIndex: Math.floor(Math.random() * NOTE_IMAGES.length),
    rotation: Math.random() * Math.PI * 2,
    rotSpeed: (Math.random() - 0.5) * 0.3,
    isLN,
    lnHeight: isLN ? 30 + Math.random() * 200 : 0,
  };
}

export function ManiaRain() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const notesRef = useRef<FallingNote[]>([]);
  const imagesRef = useRef<HTMLImageElement[]>([]);
  const rafRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);

  const init = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.parentElement!.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;

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
  }, []);

  useEffect(() => {
    imagesRef.current = NOTE_IMAGES.map((note) => {
      const image = new Image();
      image.src = note.src;
      return image;
    });

    init();

    const onResize = () => init();
    window.addEventListener("resize", onResize);

    const animate = (time: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const context = canvas.getContext("2d");
      if (!context) return;

      const dt = lastTimeRef.current ? (time - lastTimeRef.current) / 1000 : 0.016;
      lastTimeRef.current = time;

      context.clearRect(0, 0, canvas.width, canvas.height);

      for (const note of notesRef.current) {
        note.y += note.speed * dt;
        if (!note.isLN) note.rotation += note.rotSpeed * dt;

        const totalHeight = note.isLN ? note.lnHeight + note.size : note.size;
        if (note.y > canvas.height + totalHeight) {
          note.y = -totalHeight;
          note.x = Math.random() * canvas.width;
          note.imgIndex = Math.floor(Math.random() * NOTE_IMAGES.length);
          note.isLN = Math.random() < 0.05;
          note.lnHeight = note.isLN ? 30 + Math.random() * 200 : 0;
          if (note.isLN) note.rotation = 0;
        }

        const image = imagesRef.current[note.imgIndex];
        if (!image || !image.complete) continue;

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
        context.drawImage(image, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
        context.restore();
      }

      rafRef.current = requestAnimationFrame(animate);
    };

    rafRef.current = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", onResize);
    };
  }, [init]);

  return <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none" />;
}
