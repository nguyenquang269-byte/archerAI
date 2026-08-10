import React, { useEffect, useRef, useState } from "react";
import { FilesetResolver, HandLandmarker, HandLandmarkerResult } from "@mediapipe/tasks-vision";
import { Camera, Crosshair, RotateCcw, Trophy, Volume2, VolumeX } from "lucide-react";

interface Point {
  x: number;
  y: number;
}

interface ShotMark {
  x: number;
  y: number;
  score: number;
  born: number;
}

const TARGET_RADIUS = 92;
const ROUND_SECONDS = 45;
const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/wasm";
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
const palmSize = (hand: { x: number; y: number }[]) => Math.max(0.025, distance(hand[0], hand[9]));
const pinchRatio = (hand: { x: number; y: number }[]) => distance(hand[4], hand[8]) / palmSize(hand);

function scoreAt(x: number, y: number, target: Point) {
  const d = Math.hypot(x - target.x, y - target.y);
  if (d > TARGET_RADIUS) return 0;
  return clamp(10 - Math.floor((d / TARGET_RADIUS) * 10), 1, 10);
}

function beep(score: number, muted: boolean) {
  if (muted) return;
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = score === 10 ? 880 : 300 + score * 42;
    gain.gain.setValueAtTime(0.09, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.16);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.16);
  } catch (e) {
    console.warn("Audio playback error:", e);
  }
}

export default function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const landmarkerRef = useRef<HandLandmarker | null>(null);
  const rafRef = useRef<number>(0);
  const lastVideoTime = useRef<number>(-1);
  const wasPinched = useRef<boolean>(false);
  const aimRef = useRef<Point>({ x: 0, y: 0 });
  const targetRef = useRef<Point>({ x: 0, y: 0 });
  const runningRef = useRef<boolean>(false);
  const mutedRef = useRef<boolean>(false);
  const shotsRef = useRef<ShotMark[]>([]);

  const [status, setStatus] = useState("Sẵn sàng");
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [muted, setMuted] = useState(false);
  const [score, setScore] = useState(0);
  const [shots, setShots] = useState(0);
  const [best, setBest] = useState(() => Number(localStorage.getItem("camera-archery-best") || 0));
  const [time, setTime] = useState(ROUND_SECONDS);
  const [lastHit, setLastHit] = useState<number | null>(null);
  const [handsReady, setHandsReady] = useState(false);

  useEffect(() => { runningRef.current = running; }, [running]);
  useEffect(() => { mutedRef.current = muted; }, [muted]);

  const resizeCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    if (!targetRef.current.x) targetRef.current = { x: rect.width * 0.72, y: rect.height * 0.44 };
  };

  const moveTarget = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    targetRef.current = {
      x: TARGET_RADIUS + 24 + Math.random() * Math.max(1, rect.width - TARGET_RADIUS * 2 - 48),
      y: TARGET_RADIUS + 24 + Math.random() * Math.max(1, rect.height - TARGET_RADIUS * 2 - 48),
    };
  };

  const drawTarget = (ctx: CanvasRenderingContext2D, target: Point) => {
    const colors = ["#f7f3e8", "#f7f3e8", "#111827", "#111827", "#22c55e", "#22c55e", "#ef4444", "#ef4444", "#facc15", "#facc15"];
    for (let i = 10; i >= 1; i--) {
      ctx.beginPath();
      ctx.arc(target.x, target.y, (TARGET_RADIUS * i) / 10, 0, Math.PI * 2);
      ctx.fillStyle = colors[10 - i];
      ctx.fill();
      ctx.strokeStyle = "rgba(15,23,42,.45)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.fillStyle = "#111827";
    ctx.font = "700 12px system-ui";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("10", target.x, target.y);
  };

  const draw = (results: HandLandmarkerResult | null) => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;
    const rect = canvas.getBoundingClientRect();
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.save();
    ctx.scale(-1, 1);
    ctx.drawImage(video, -rect.width, 0, rect.width, rect.height);
    ctx.restore();
    ctx.fillStyle = "rgba(2,6,23,.18)";
    ctx.fillRect(0, 0, rect.width, rect.height);

    drawTarget(ctx, targetRef.current);

    const hands = results?.landmarks || [];
    setHandsReady(hands.length >= 2);
    let triggerHand: { x: number; y: number }[] | null = null;
    let aimHand: { x: number; y: number }[] | null = null;
    if (hands.length >= 2) {
      const ratios = hands.map(pinchRatio);
      const triggerIndex = ratios[0] <= ratios[1] ? 0 : 1;
      triggerHand = hands[triggerIndex];
      aimHand = hands[1 - triggerIndex];
    } else if (hands.length === 1) {
      aimHand = hands[0];
    }

    hands.forEach((hand, hi) => {
      ctx.strokeStyle = hi === 0 ? "#67e8f9" : "#c4b5fd";
      ctx.lineWidth = 3;
      [0, 5, 9, 13, 17].forEach((idx) => {
        const p = hand[idx];
        ctx.beginPath();
        ctx.arc((1 - p.x) * rect.width, p.y * rect.height, 5, 0, Math.PI * 2);
        ctx.fillStyle = ctx.strokeStyle;
        ctx.fill();
      });
      [4, 8].forEach((idx) => {
        const p = hand[idx];
        ctx.beginPath();
        ctx.arc((1 - p.x) * rect.width, p.y * rect.height, 8, 0, Math.PI * 2);
        ctx.stroke();
      });
    });

    if (aimHand) {
      const tip = aimHand[8];
      const raw = { x: (1 - tip.x) * rect.width, y: tip.y * rect.height };
      aimRef.current = {
        x: aimRef.current.x ? aimRef.current.x * 0.68 + raw.x * 0.32 : raw.x,
        y: aimRef.current.y ? aimRef.current.y * 0.68 + raw.y * 0.32 : raw.y,
      };
      const a = aimRef.current;
      ctx.strokeStyle = "rgba(255,255,255,.55)";
      ctx.setLineDash([6, 7]);
      ctx.beginPath();
      ctx.moveTo(a.x - 70, a.y);
      ctx.lineTo(a.x + 70, a.y);
      ctx.moveTo(a.x, a.y - 70);
      ctx.lineTo(a.x, a.y + 70);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(a.x, a.y, 17, 0, Math.PI * 2);
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 3;
      ctx.stroke();
    }

    const pinched = triggerHand ? pinchRatio(triggerHand) < 0.43 : false;
    if (pinched && !wasPinched.current && triggerHand && aimHand && runningRef.current) {
      const a = aimRef.current;
      const hitScore = scoreAt(a.x, a.y, targetRef.current);
      const mark = { x: a.x, y: a.y, score: hitScore, born: performance.now() };
      shotsRef.current = [...shotsRef.current.slice(-7), mark];
      setShots((n) => n + 1);
      setScore((n) => n + hitScore);
      setLastHit(hitScore);
      beep(hitScore, mutedRef.current);
      setTimeout(moveTarget, 220);
    }
    wasPinched.current = pinched;

    const now = performance.now();
    shotsRef.current = shotsRef.current.filter((s) => now - s.born < 1300);
    shotsRef.current.forEach((s) => {
      const alpha = 1 - (now - s.born) / 1300;
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 12, 0, Math.PI * 2);
      ctx.fillStyle = s.score ? "#fef08a" : "#fb7185";
      ctx.fill();
      ctx.fillStyle = "#0f172a";
      ctx.font = "800 12px system-ui";
      ctx.fillText(String(s.score), s.x, s.y);
    });
    ctx.globalAlpha = 1;
  };

  const loop = async () => {
    const video = videoRef.current;
    if (video && landmarkerRef.current && video.readyState >= 2) {
      if (video.currentTime !== lastVideoTime.current) {
        lastVideoTime.current = video.currentTime;
        try {
          const results = landmarkerRef.current.detectForVideo(video, performance.now());
          draw(results);
        } catch (e) {
          console.warn("Detection frame error:", e);
        }
      }
    }
    rafRef.current = requestAnimationFrame(loop);
  };

  const startCamera = async () => {
    setLoading(true);
    setStatus("Đang tải mô hình nhận diện tay...");
    try {
      if (!landmarkerRef.current) {
        const vision = await FilesetResolver.forVisionTasks(WASM_URL);
        landmarkerRef.current = await HandLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
          runningMode: "VIDEO",
          numHands: 2,
          minHandDetectionConfidence: 0.55,
          minHandPresenceConfidence: 0.55,
          minTrackingConfidence: 0.55,
        });
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      resizeCanvas();
      cancelAnimationFrame(rafRef.current);
      loop();
      setStatus("Camera đã sẵn sàng");
    } catch (err) {
      console.error(err);
      setStatus("Không mở được camera. Hãy cấp quyền camera và thử lại.");
    } finally {
      setLoading(false);
    }
  };

  const startRound = async () => {
    if (!videoRef.current?.srcObject) await startCamera();
    setScore(0);
    setShots(0);
    setLastHit(null);
    setTime(ROUND_SECONDS);
    shotsRef.current = [];
    moveTarget();
    setRunning(true);
  };

  useEffect(() => {
    resizeCanvas();
    window.addEventListener("resize", resizeCanvas);
    return () => {
      window.removeEventListener("resize", resizeCanvas);
      cancelAnimationFrame(rafRef.current);
      if (videoRef.current?.srcObject) {
        const stream = videoRef.current.srcObject as MediaStream;
        stream.getTracks().forEach((t) => t.stop());
      }
      landmarkerRef.current?.close();
    };
  }, []);

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      setTime((t) => {
        if (t <= 1) {
          setRunning(false);
          return 0;
        }
        return t - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [running]);

  useEffect(() => {
    if (!running && score > best) {
      setBest(score);
      localStorage.setItem("camera-archery-best", String(score));
    }
  }, [running, score, best]);

  return (
    <main id="archery-main" className="min-h-screen bg-slate-950 text-white p-4 md:p-6 font-sans">
      <div className="mx-auto max-w-6xl">
        <header id="game-header" className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.28em] text-cyan-300">Motion game</p>
            <h1 className="text-3xl font-black tracking-tight md:text-5xl">Cung thủ Camera</h1>
            <p className="mt-1 text-sm text-slate-400">Trỏ bằng ngón trỏ tay trước, chụm ngón cái và ngón trỏ tay còn lại để bắn.</p>
          </div>
          <div className="flex gap-2">
            <button
              id="sound-toggle-btn"
              onClick={() => setMuted((v) => !v)}
              className="rounded-2xl bg-slate-800 p-3 hover:bg-slate-700 cursor-pointer transition-colors"
              aria-label="Bật hoặc tắt âm thanh"
            >
              {muted ? <VolumeX size={20} /> : <Volume2 size={20} />}
            </button>
            <button
              id="open-camera-btn"
              onClick={startCamera}
              disabled={loading}
              className="flex items-center gap-2 rounded-2xl bg-slate-800 px-4 py-3 text-sm font-bold hover:bg-slate-700 disabled:opacity-50 cursor-pointer transition-colors"
            >
              <Camera size={18} /> {loading ? "Đang mở..." : "Mở camera"}
            </button>
          </div>
        </header>

        <section id="game-arena" className="grid gap-4 lg:grid-cols-[1fr_260px]">
          <div
            id="viewport-card"
            className="relative overflow-hidden rounded-[28px] border border-white/10 bg-slate-900 shadow-2xl"
            style={{ aspectRatio: "16 / 9" }}
          >
            <video ref={videoRef} className="hidden" playsInline muted />
            <canvas ref={canvasRef} className="h-full w-full" />

            {!videoRef.current?.srcObject && (
              <div id="camera-overlay-prompt" className="absolute inset-0 grid place-items-center bg-gradient-to-br from-cyan-950/70 to-violet-950/70 p-8 text-center">
                <div>
                  <div className="mx-auto mb-4 grid h-20 w-20 place-items-center rounded-full bg-white/10">
                    <Camera size={34} />
                  </div>
                  <h2 className="text-2xl font-black">Cho phép camera để bắt đầu</h2>
                  <p className="mx-auto mt-2 max-w-md text-sm text-slate-300">
                    Đứng cách camera khoảng một sải tay và giữ đủ hai bàn tay trong khung hình.
                  </p>
                  <button
                    id="enable-camera-btn"
                    onClick={startCamera}
                    disabled={loading}
                    className="mt-5 rounded-2xl bg-cyan-400 px-6 py-3 font-black text-slate-950 hover:bg-cyan-300 disabled:opacity-50 cursor-pointer transition-colors"
                  >
                    {loading ? "Đang tải..." : "Bật camera"}
                  </button>
                </div>
              </div>
            )}

            <div id="status-badges" className="absolute left-3 top-3 flex gap-2">
              <span
                className={`rounded-full px-3 py-1 text-xs font-bold backdrop-blur ${
                  handsReady ? "bg-emerald-400/90 text-emerald-950" : "bg-slate-900/75 text-slate-200"
                }`}
              >
                {handsReady ? "Đã thấy 2 tay" : "Đưa 2 tay vào khung"}
              </span>
              {running && <span className="rounded-full bg-rose-500 px-3 py-1 text-xs font-black">{time}s</span>}
            </div>

            {lastHit !== null && (
              <div key={`${shots}-${lastHit}`} className="pointer-events-none absolute inset-0 grid place-items-center">
                <div
                  className={`animate-bounce rounded-full px-5 py-3 text-3xl font-black shadow-xl ${
                    lastHit === 10 ? "bg-yellow-300 text-yellow-950" : lastHit > 0 ? "bg-white text-slate-950" : "bg-rose-500"
                  }`}
                >
                  {lastHit === 10 ? "TÂM BIA! +10" : `+${lastHit}`}
                </div>
              </div>
            )}
          </div>

          <aside id="game-sidebar" className="grid grid-cols-2 gap-3 lg:grid-cols-1">
            <div id="score-card" className="rounded-3xl bg-gradient-to-br from-cyan-400 to-blue-500 p-5 text-slate-950">
              <p className="text-xs font-black uppercase tracking-widest">Tổng điểm</p>
              <p className="mt-1 text-5xl font-black">{score}</p>
              <p className="mt-2 text-sm font-bold">{shots} phát bắn</p>
            </div>
            <div id="best-score-card" className="rounded-3xl border border-white/10 bg-slate-900 p-5">
              <div className="flex items-center gap-2 text-yellow-300">
                <Trophy size={18} />
                <p className="text-xs font-black uppercase tracking-widest">Kỷ lục</p>
              </div>
              <p className="mt-2 text-3xl font-black">{best}</p>
            </div>
            <div id="instructions-card" className="col-span-2 rounded-3xl border border-white/10 bg-slate-900 p-5 lg:col-span-1">
              <p className="mb-3 text-sm font-bold text-slate-300">Cách chơi</p>
              <ol className="space-y-2 text-sm text-slate-400">
                <li><b className="text-white">1.</b> Dùng ngón trỏ của một tay để đưa tâm ngắm vào bia.</li>
                <li><b className="text-white">2.</b> Tay kia chụm ngón cái và ngón trỏ để bắn.</li>
                <li><b className="text-white">3.</b> Nhả hai ngón rồi chụm lại cho phát tiếp theo.</li>
              </ol>
            </div>
            <button
              id="start-round-btn"
              onClick={startRound}
              className="col-span-2 flex items-center justify-center gap-2 rounded-3xl bg-white px-5 py-4 font-black text-slate-950 hover:bg-cyan-100 lg:col-span-1 cursor-pointer transition-colors"
            >
              {running ? (
                <>
                  <RotateCcw size={19} /> Chơi lại
                </>
              ) : (
                <>
                  <Crosshair size={19} /> Bắt đầu 45 giây
                </>
              )}
            </button>
          </aside>
        </section>
        <p id="game-footer-status" className="mt-3 text-center text-xs text-slate-500">
          {status} • Xử lý hình ảnh diễn ra trực tiếp trong trình duyệt.
        </p>
      </div>
    </main>
  );
}
