import express, { Request, Response, NextFunction } from "express";
import { createServer } from "http";
import { Server, Socket } from "socket.io";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import jwt from "jsonwebtoken";
import { supabase } from "./src/lib/supabase.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Logger estruturado ───────────────────────────────────────────────────────
const log = {
  info:  (msg: string, data?: object) => console.log(JSON.stringify({ level: "info",  ts: new Date().toISOString(), msg, ...data })),
  warn:  (msg: string, data?: object) => console.warn(JSON.stringify({ level: "warn",  ts: new Date().toISOString(), msg, ...data })),
  error: (msg: string, data?: object) => console.error(JSON.stringify({ level: "error", ts: new Date().toISOString(), msg, ...data })),
};

// ─── Validações ───────────────────────────────────────────────────────────────
const isStr = (v: unknown, max = 255): v is string =>
  typeof v === "string" && v.trim().length > 0 && v.length <= max;

const isCoord = (lat: unknown, lng: unknown): boolean =>
  typeof lat === "number" && typeof lng === "number" &&
  lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;

// ─── Rate limiter simples in-memory ──────────────────────────────────────────
const rateLimiter = new Map<string, { count: number; resetAt: number }>();
function checkRateLimit(key: string, maxPerMinute = 10): boolean {
  const now = Date.now();
  const entry = rateLimiter.get(key);
  if (!entry || now > entry.resetAt) {
    rateLimiter.set(key, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (entry.count >= maxPerMinute) return false;
  entry.count++;
  return true;
}

// ─── JWT ──────────────────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET ?? "dev_secret_change_in_prod";

function signToken(payload: object): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });
}

function verifyToken(token: string): any {
  return jwt.verify(token, JWT_SECRET);
}

// ─── Helpers Supabase ─────────────────────────────────────────────────────────
async function getAllLawyers() {
  const { data } = await supabase.from("lawyers").select("*").order("name");
  return data ?? [];
}

// ─── Servidor ─────────────────────────────────────────────────────────────────
async function startServer() {
  const app = express();
  app.use(express.json());

  const httpServer = createServer(app);
  const PORT = Number(process.env.PORT) || 3000;

  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(",")
    : ["http://localhost:3000", "http://localhost:5173"];

  const io = new Server(httpServer, {
    cors: { origin: allowedOrigins, methods: ["GET", "POST"], credentials: true },
  });

  // ─── Auth middleware REST ────────────────────────────────────────────────
  function requireAuth(req: Request, res: Response, next: NextFunction) {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return res.status(401).json({ error: "Não autorizado." });
    try {
      (req as any).user = verifyToken(header.slice(7));
      next();
    } catch {
      res.status(401).json({ error: "Token inválido." });
    }
  }

  // ─── WebSocket ──────────────────────────────────────────────────────────────
  io.on("connection", (socket: Socket) => {
    log.info("Socket conectado", { socketId: socket.id });

    getAllLawyers().then(lawyers => socket.emit("lawyers-update", lawyers));

    // ── Registro de advogado ─────────────────────────────────────────────────
    socket.on("register-lawyer", async (data: unknown) => {
      if (!data || typeof data !== "object" || !isStr((data as any).id)) {
        socket.emit("error", { event: "register-lawyer", message: "ID inválido." });
        return;
      }
      const lawyerId = (data as any).id as string;

      const { data: lawyer, error } = await supabase
        .from("lawyers").select("id").eq("id", lawyerId).single();

      if (error || !lawyer) {
        socket.emit("error", { event: "register-lawyer", message: "Advogado não encontrado." });
        return;
      }

      await supabase.from("lawyers")
        .update({ socket_id: socket.id, status: "available" })
        .eq("id", lawyerId);

      io.emit("lawyers-update", await getAllLawyers());
      log.info("Advogado registrado", { lawyerId });
    });

    // ── Emergência ───────────────────────────────────────────────────────────
    socket.on("emergency-request", async (data: unknown) => {
      if (!checkRateLimit(`emergency:${socket.id}`, 3)) {
        socket.emit("error", { event: "emergency-request", message: "Muitas solicitações. Aguarde." });
        return;
      }

      if (!data || typeof data !== "object") {
        socket.emit("error", { event: "emergency-request", message: "Dados inválidos." });
        return;
      }

      const { specialty, location, userId: clientUserId } = data as any;

      if (!isStr(specialty, 100)) {
        socket.emit("error", { event: "emergency-request", message: "Especialidade inválida." });
        return;
      }
      if (!location || !isCoord(location.lat, location.lng)) {
        socket.emit("error", { event: "emergency-request", message: "Localização inválida." });
        return;
      }

      const userId = isStr(clientUserId) ? clientUserId : socket.id;

      const { data: emergency, error } = await supabase
        .from("emergencies")
        .insert({
          user_id: userId,
          status: "pending",
          specialty: specialty.trim(),
          lat: location.lat,
          lng: location.lng,
        })
        .select()
        .single();

      if (error || !emergency) {
        log.error("Erro ao criar emergência", { error: String(error) });
        socket.emit("error", { event: "emergency-request", message: "Erro ao criar emergência." });
        return;
      }

      io.emit("new-emergency", { ...emergency, location });
      socket.emit("emergency-created", emergency.id);
      log.info("Emergência criada", { id: emergency.id, specialty, userId });
    });

    // ── Aceitar emergência ────────────────────────────────────────────────────
    socket.on("accept-emergency", async (data: unknown) => {
      if (!data || typeof data !== "object") {
        socket.emit("error", { event: "accept-emergency", message: "Dados inválidos." });
        return;
      }

      const { emergencyId, lawyerId } = data as any;

      if (!isStr(emergencyId) || !isStr(lawyerId)) {
        socket.emit("error", { event: "accept-emergency", message: "Campos inválidos." });
        return;
      }

      // Verifica que o socket pertence ao advogado (segurança)
      const { data: lawyer } = await supabase
        .from("lawyers")
        .select("id")
        .eq("id", lawyerId)
        .eq("socket_id", socket.id)
        .single();

      if (!lawyer) {
        socket.emit("error", { event: "accept-emergency", message: "Não autorizado." });
        return;
      }

      // Atualização atômica: só aceita se ainda estiver pending
      const { data: updated, error } = await supabase
        .from("emergencies")
        .update({ status: "accepted", lawyer_id: lawyerId, started_at: new Date().toISOString() })
        .eq("id", emergencyId)
        .eq("status", "pending")
        .select()
        .single();

      if (error || !updated) {
        socket.emit("error", { event: "accept-emergency", message: "Emergência já aceita ou não encontrada." });
        return;
      }

      await supabase.from("lawyers").update({ status: "busy" }).eq("id", lawyerId);

      io.to(updated.user_id).emit("emergency-accepted", { emergencyId, lawyerId });
      socket.emit("emergency-confirmed", emergencyId);
      io.emit("lawyers-update", await getAllLawyers());
      log.info("Emergência aceita", { emergencyId, lawyerId });
    });

    // ── Finalizar atendimento ─────────────────────────────────────────────────
    socket.on("complete-emergency", async (data: unknown) => {
      if (!data || typeof data !== "object") return;
      const { emergencyId, lawyerId } = data as any;
      if (!isStr(emergencyId) || !isStr(lawyerId)) return;

      const { data: emergency } = await supabase
        .from("emergencies")
        .update({ status: "completed", ended_at: new Date().toISOString() })
        .eq("id", emergencyId)
        .eq("lawyer_id", lawyerId)
        .select()
        .single();

      if (emergency) {
        await supabase.from("lawyers").update({ status: "available" }).eq("id", lawyerId);
        io.to(emergency.user_id).emit("emergency-completed", emergencyId);
        io.emit("lawyers-update", await getAllLawyers());
        log.info("Emergência finalizada", { emergencyId });
      }
    });

    // ── Chat message ──────────────────────────────────────────────────────────
    socket.on("chat-message", async (data: unknown) => {
      if (!data || typeof data !== "object") return;
      const { to, message, sender, emergencyId } = data as any;

      if (!isStr(to) || !isStr(message, 4000) || !isStr(sender, 100) || !isStr(emergencyId)) {
        socket.emit("error", { event: "chat-message", message: "Campos inválidos." });
        return;
      }

      if (!checkRateLimit(`msg:${socket.id}`, 30)) {
        socket.emit("error", { event: "chat-message", message: "Muitas mensagens. Aguarde." });
        return;
      }

      await supabase.from("messages").insert({
        emergency_id: emergencyId,
        sender_id: socket.id,
        receiver_id: to,
        message: message.trim(),
        sender_name: sender.trim(),
      });

      io.to(to).emit("chat-message", {
        from: socket.id,
        message: message.trim(),
        sender: sender.trim(),
        timestamp: Date.now(),
      });
    });

    // ── Desconexão ────────────────────────────────────────────────────────────
    socket.on("disconnect", async () => {
      await supabase.from("lawyers")
        .update({ status: "offline", socket_id: null })
        .eq("socket_id", socket.id);

      io.emit("lawyers-update", await getAllLawyers());
      log.info("Socket desconectado", { socketId: socket.id });
    });
  });

  // ─── API REST ──────────────────────────────────────────────────────────────

  // Auth: emite token JWT para um userId (em produção: integrar com Supabase Auth)
  app.post("/api/auth/token", (req, res) => {
    const { userId } = req.body;
    if (!isStr(userId)) return res.status(400).json({ error: "userId obrigatório." });
    const token = signToken({ sub: userId });
    res.json({ token });
  });

  app.get("/api/lawyers", async (_req, res) => {
    try {
      const lawyers = await getAllLawyers();
      res.json(lawyers);
    } catch (err) {
      res.status(500).json({ error: "Erro interno." });
    }
  });

  app.get("/api/lawyer-stats/:lawyerId", requireAuth, async (req, res) => {
    const { lawyerId } = req.params;
    if (!isStr(lawyerId)) return res.status(400).json({ error: "ID inválido." });

    const { data: lawyer } = await supabase.from("lawyers").select("*").eq("id", lawyerId).single();
    if (!lawyer) return res.status(404).json({ error: "Advogado não encontrado." });

    const { count: totalEmergencies } = await supabase
      .from("emergencies")
      .select("*", { count: "exact", head: true })
      .eq("lawyer_id", lawyerId)
      .eq("status", "completed");

    const { data: earningsData } = await supabase
      .from("emergencies")
      .select("price_per_minute")
      .eq("lawyer_id", lawyerId)
      .eq("status", "completed");

    const totalEarnings = (earningsData ?? [])
      .reduce((sum, e) => sum + (e.price_per_minute ?? lawyer.price_per_minute) * 10, 0);

    res.json({ totalEmergencies: totalEmergencies ?? 0, totalEarnings });
  });

  app.get("/api/history/:userId", requireAuth, async (req, res) => {
    const { userId } = req.params;
    if (!isStr(userId)) return res.status(400).json({ error: "userId inválido." });

    const { data } = await supabase
      .from("emergencies")
      .select("*, lawyers(name)")
      .or(`user_id.eq.${userId},lawyer_id.eq.${userId}`)
      .order("created_at", { ascending: false })
      .limit(50);

    res.json((data ?? []).map(e => ({ ...e, lawyerName: (e as any).lawyers?.name ?? null })));
  });

  app.get("/api/messages/:emergencyId", requireAuth, async (req, res) => {
    const { emergencyId } = req.params;
    if (!isStr(emergencyId)) return res.status(400).json({ error: "ID inválido." });

    const { data } = await supabase
      .from("messages")
      .select("*")
      .eq("emergency_id", emergencyId)
      .order("created_at", { ascending: true });

    res.json(data ?? []);
  });

  // Salvar avaliação
  app.post("/api/ratings", requireAuth, async (req, res) => {
    const { emergencyId, lawyerId, userId, score, comment } = req.body;
    if (!isStr(emergencyId) || !isStr(lawyerId) || !isStr(userId) || typeof score !== "number") {
      return res.status(400).json({ error: "Campos inválidos." });
    }

    await supabase.from("ratings").insert({ emergency_id: emergencyId, lawyer_id: lawyerId, user_id: userId, score, comment });

    // Atualiza rating médio do advogado
    const { data: ratings } = await supabase.from("ratings").select("score").eq("lawyer_id", lawyerId);
    if (ratings && ratings.length > 0) {
      const avg = ratings.reduce((s, r) => s + r.score, 0) / ratings.length;
      await supabase.from("lawyers").update({ rating: Math.round(avg * 10) / 10 }).eq("id", lawyerId);
    }

    res.json({ ok: true });
  });

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", ts: new Date().toISOString() });
  });

  // ─── Vite / Static ────────────────────────────────────────────────────────
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => res.sendFile(path.join(distPath, "index.html")));
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    log.info("Servidor rodando", { url: `http://localhost:${PORT}` });
  });
}

startServer().catch(err => {
  console.error("Falha ao iniciar:", err);
  process.exit(1);
});
