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
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);

  const isStartingRef = useRef<boolean>(false);

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

  const startCamera = async (isAutoStart = false) => {
    if (isStartingRef.current) return;
    if (cameraActive && videoRef.current?.srcObject) return;

    isStartingRef.current = true;
    setLoading(true);
    setCameraError(null);
    setStatus("Đang yêu cầu quyền truy cập camera...");
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("TRINHDRUYET_KHONG_HO_TRO");
      }

      let stream = videoRef.current?.srcObject as MediaStream | null;
      if (!stream || !stream.active) {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: "user",
              width: { ideal: 1280 },
              height: { ideal: 720 },
            },
            audio: false,
          });
        } catch (fallbackErr) {
          // Fallback to basic video constraints if ideal resolution is rejected
          stream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: false,
          });
        }
      }

      if (videoRef.current) {
        if (videoRef.current.srcObject !== stream) {
          videoRef.current.srcObject = stream;
        }
        try {
          await videoRef.current.play();
        } catch (playErr: any) {
          if (playErr.name !== "AbortError" && !playErr.message?.includes("interrupted")) {
            console.warn("Video play exception:", playErr);
          }
        }
        setCameraActive(true);
      }

      setStatus("Đang tải mô hình nhận diện AI...");
      if (!landmarkerRef.current) {
        const vision = await FilesetResolver.forVisionTasks(WASM_URL);
        try {
          landmarkerRef.current = await HandLandmarker.createFromOptions(vision, {
            baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
            runningMode: "VIDEO",
            numHands: 2,
            minHandDetectionConfidence: 0.5,
            minHandPresenceConfidence: 0.5,
            minTrackingConfidence: 0.5,
          });
        } catch (gpuError) {
          console.warn("GPU delegate failed, falling back to CPU:", gpuError);
          landmarkerRef.current = await HandLandmarker.createFromOptions(vision, {
            baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
            runningMode: "VIDEO",
            numHands: 2,
            minHandDetectionConfidence: 0.5,
            minHandPresenceConfidence: 0.5,
            minTrackingConfidence: 0.5,
          });
        }
      }

      resizeCanvas();
      cancelAnimationFrame(rafRef.current);
      loop();
      setStatus("Camera & AI sẵn sàng");
    } catch (err: any) {
      if (err.name === "AbortError" || err.message?.includes("interrupted")) {
        return;
      }
      console.warn("Camera access result:", err?.name || err?.message || err);
      setCameraActive(false);
      let msg = "Không mở được camera. Hãy bấm 'Bật Camera' và cấp quyền truy cập.";
      if (err.message === "TRINHDRUYET_KHONG_HO_TRO") {
        msg = "Trình duyệt hoặc môi trường iframe không hỗ trợ truy cập Camera.";
      } else if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
        msg = "Quyền truy cập camera bị từ chối. Vui lòng bấm 'Cho phép' khi trình duyệt hỏi.";
      } else if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") {
        msg = "Không tìm thấy thiết bị camera trên máy tính/điện thoại của bạn.";
      } else if (err.name === "NotReadableError" || err.name === "TrackStartError") {
        msg = "Camera đang được ứng dụng khác sử dụng. Vui lòng đóng ứng dụng đó và thử lại.";
      }
      setCameraError(msg);
      setStatus(msg);
    } finally {
      setLoading(false);
      isStartingRef.current = false;
    }
  };

  const startRound = async () => {
    if (!cameraActive) {
      await startCamera();
    }
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
    
    // Attempt auto camera start
    startCamera(true);

    return () => {
      window.removeEventListener("resize", resizeCanvas);
      cancelAnimationFrame(rafRef.current);
      if (videoRef.current?.srcObject) {
        const stream = videoRef.current.srcObject as MediaStream;
        stream.getTracks().forEach((t) => t.stop());
        videoRef.current.srcObject = null;
      }
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
    <main id="archery-main" className="min-h-screen bg-slate-950 text-white p-3 md:p-6 font-sans flex flex-col justify-between">
      <div className="mx-auto w-full max-w-7xl">
        {/* Header */}
        <header id="game-header" className="mb-3 flex flex-wrap items-center justify-between gap-3 bg-slate-900/60 p-4 rounded-3xl border border-white/5 backdrop-blur">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-2xl bg-cyan-500/20 text-cyan-300">
              <Crosshair size={22} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl md:text-2xl font-black tracking-tight">Cung thủ Camera</h1>
                <span className="rounded-full bg-cyan-500/10 px-2.5 py-0.5 text-[10px] font-bold text-cyan-400 border border-cyan-500/20">
                  AI Motion
                </span>
              </div>
              <p className="text-xs text-slate-400 hidden sm:block">Trỏ ngón trỏ để ngắm, chụm ngón tay còn lại để bắn</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              id="sound-toggle-btn"
              onClick={() => setMuted((v) => !v)}
              className="rounded-2xl bg-slate-800/80 p-2.5 hover:bg-slate-700 cursor-pointer transition-colors border border-white/10"
              aria-label="Bật hoặc tắt âm thanh"
            >
              {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
            </button>
            <button
              id="open-camera-btn"
              onClick={() => startCamera()}
              disabled={loading}
              className={`flex items-center gap-2 rounded-2xl px-4 py-2.5 text-xs font-bold transition-all cursor-pointer ${
                cameraActive
                  ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 hover:bg-emerald-500/30"
                  : "bg-cyan-500 text-slate-950 hover:bg-cyan-400 font-black shadow-lg shadow-cyan-500/20"
              } disabled:opacity-50`}
            >
              <Camera size={16} />
              {loading ? "Đang kết nối..." : cameraActive ? "Đang bật Camera" : "Bật Camera ngay"}
            </button>
          </div>
        </header>

        {/* Main Arena Grid - Camera Viewport Takes Center Stage */}
        <section id="game-arena" className="grid gap-4 lg:grid-cols-[1fr_280px] items-start">
          {/* Main Camera Viewport */}
          <div
            id="viewport-card"
            className="relative overflow-hidden rounded-3xl border border-white/10 bg-slate-900/90 shadow-2xl min-h-[420px] sm:min-h-[520px] lg:min-h-[600px] flex items-center justify-center"
          >
            <video ref={videoRef} className="hidden" playsInline muted />
            <canvas ref={canvasRef} className="h-full w-full object-cover" />

            {/* Overlay when Camera is NOT active */}
            {!cameraActive && (
              <div id="camera-overlay-prompt" className="absolute inset-0 grid place-items-center bg-slate-950/90 p-6 text-center backdrop-blur-md">
                <div className="max-w-md">
                  <div className="mx-auto mb-4 grid h-20 w-20 place-items-center rounded-3xl bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 shadow-inner">
                    <Camera size={38} />
                  </div>
                  <h2 className="text-2xl font-black tracking-tight">Cần quyền Camera để trải nghiệm</h2>
                  <p className="mt-2 text-sm text-slate-300 leading-relaxed">
                    Trò chơi sử dụng camera để nhận diện chuyển động bàn tay trực tiếp trong trình duyệt. Không có dữ liệu video nào được lưu lại.
                  </p>

                  {cameraError && (
                    <div className="mt-4 rounded-2xl bg-rose-500/10 border border-rose-500/20 p-3 text-xs text-rose-300 font-medium">
                      {cameraError}
                    </div>
                  )}

                  <button
                    id="enable-camera-btn"
                    onClick={() => startCamera()}
                    disabled={loading}
                    className="mt-6 w-full rounded-2xl bg-gradient-to-r from-cyan-400 to-blue-500 py-3.5 px-6 font-black text-slate-950 shadow-lg shadow-cyan-500/25 hover:from-cyan-300 hover:to-blue-400 disabled:opacity-50 cursor-pointer transition-all text-sm"
                  >
                    {loading ? "Đang kết nối camera & AI..." : "Cho phép & Bật Camera"}
                  </button>
                  <p className="mt-3 text-[11px] text-slate-500">
                    Nên dùng trên trình duyệt Chrome, Edge hoặc Safari
                  </p>
                </div>
              </div>
            )}

            {/* HUD Status Badges on Top Left of Camera */}
            {cameraActive && (
              <div id="status-badges" className="absolute left-4 top-4 flex flex-wrap gap-2 pointer-events-none">
                <span className="flex items-center gap-1.5 rounded-full bg-slate-900/80 px-3 py-1 text-xs font-bold text-slate-200 border border-white/10 backdrop-blur">
                  <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse"></span> LIVE
                </span>
                <span
                  className={`rounded-full px-3 py-1 text-xs font-bold backdrop-blur transition-colors ${
                    handsReady
                      ? "bg-emerald-500/90 text-emerald-950 font-extrabold shadow-md shadow-emerald-500/20"
                      : "bg-amber-500/80 text-amber-950 font-bold"
                  }`}
                >
                  {handsReady ? "✓ Đã thấy 2 tay" : "Giữ 2 tay trong khung hình"}
                </span>
                {running && (
                  <span className="rounded-full bg-rose-500/90 px-3.5 py-1 text-xs font-black text-white shadow-md shadow-rose-500/30 border border-rose-400/30">
                    ⏱ {time}s
                  </span>
                )}
              </div>
            )}

            {/* Last Hit Animation Overlay */}
            {lastHit !== null && (
              <div key={`${shots}-${lastHit}`} className="pointer-events-none absolute inset-0 grid place-items-center">
                <div
                  className={`animate-bounce rounded-full px-6 py-3 text-3xl font-black shadow-2xl border ${
                    lastHit === 10
                      ? "bg-yellow-400 text-yellow-950 border-yellow-200 shadow-yellow-500/50"
                      : lastHit > 0
                      ? "bg-white text-slate-950 border-slate-200"
                      : "bg-rose-500 text-white border-rose-300"
                  }`}
                >
                  {lastHit === 10 ? "TÂM BIA! +10" : `+${lastHit}`}
                </div>
              </div>
            )}
          </div>

          {/* Sidebar Controls */}
          <aside id="game-sidebar" className="flex flex-col gap-3">
            <button
              id="start-round-btn"
              onClick={startRound}
              className="flex w-full items-center justify-center gap-2 rounded-3xl bg-gradient-to-r from-white to-slate-100 px-5 py-4 font-black text-slate-950 hover:from-cyan-100 hover:to-white cursor-pointer transition-all shadow-xl text-base"
            >
              {running ? (
                <>
                  <RotateCcw size={20} /> Chơi lại vòng mới
                </>
              ) : (
                <>
                  <Crosshair size={20} /> Bắt đầu 45 giây
                </>
              )}
            </button>

            <div className="grid grid-cols-2 lg:grid-cols-1 gap-3">
              <div id="score-card" className="rounded-3xl bg-gradient-to-br from-cyan-400 to-blue-500 p-5 text-slate-950 shadow-lg shadow-cyan-500/10">
                <p className="text-[11px] font-black uppercase tracking-widest text-slate-900/70">Tổng điểm</p>
                <p className="mt-1 text-5xl font-black tracking-tight">{score}</p>
                <p className="mt-2 text-xs font-bold opacity-80">{shots} phát đã bắn</p>
              </div>

              <div id="best-score-card" className="rounded-3xl border border-white/10 bg-slate-900/80 p-5">
                <div className="flex items-center gap-2 text-yellow-400">
                  <Trophy size={18} />
                  <p className="text-[11px] font-black uppercase tracking-widest">Kỷ lục</p>
                </div>
                <p className="mt-1 text-3xl font-black text-white">{best}</p>
              </div>
            </div>

            <div id="instructions-card" className="rounded-3xl border border-white/10 bg-slate-900/60 p-4">
              <p className="mb-2 text-xs font-bold uppercase tracking-wider text-cyan-400">Hướng dẫn ngắm bắn</p>
              <ol className="space-y-2 text-xs text-slate-300">
                <li className="flex items-start gap-2">
                  <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-cyan-500/20 text-[10px] font-bold text-cyan-300">1</span>
                  <span>Dùng <b>ngón trỏ</b> một tay để di chuyển tâm ngắm.</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-cyan-500/20 text-[10px] font-bold text-cyan-300">2</span>
                  <span>Tay còn lại <b>chụm ngón cái & ngón trỏ</b> để phát bắn.</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-cyan-500/20 text-[10px] font-bold text-cyan-300">3</span>
                  <span>Thả tay rồi chụm lại để bắn mũi tên tiếp theo.</span>
                </li>
              </ol>
            </div>
          </aside>
        </section>

        <footer id="game-footer" className="mt-4 text-center text-xs text-slate-500">
          <p>{status} • Xử lý AI diễn ra 100% trong trình duyệt của bạn.</p>
        </footer>
      </div>
    </main>
  );
}
