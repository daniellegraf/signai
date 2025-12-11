import express from "express";
import cors from "cors";
import multer from "multer";
import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

const app = express();

// Multer: spara fil i minne först
const upload = multer({ storage: multer.memoryStorage() });

// CORS – tillåt Neocities + localhost (för test)
app.use(
  cors({
    origin: [
      "https://signai.neocities.org",
      "https://www.signai.neocities.org",
      "http://localhost:3000",
      "http://localhost:5173",
      "http://localhost:5500",
      "http://localhost"
    ],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"]
  })
);

// Preflight för /detect-image
app.options("/detect-image", cors());

app.use(express.json());

// Winston API-nyckel (Render → Environment → WINSTON_API_KEY)
const WINSTON_API_KEY = process.env.WINSTON_API_KEY;

// MCP JSON-RPC endpoint
const WINSTON_MCP_URL = "https://api.gowinston.ai/mcp/v1";

// Katalog för temporära bilder på Render
const uploadDir = "/tmp/uploads";
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Gör /uploads publikt (så Winston kan hämta bilden via URL)
app.use("/uploads", express.static(uploadDir));

// Health-check för Render
app.get("/healthz", (req, res) => {
  res.json({ status: "ok", service: "signai-backend", path: "/healthz" });
});

// Enkel root-check
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "signai-backend" });
});

/**
 * POST /detect-image
 * Tar emot `image` (FormData-fil), sparar den, gör en publik URL,
 * skickar URL:en till Winston MCP (ai-image-detection) och returnerar
 * ett förenklat svar till din SignAi-front.
 */
app.post("/detect-image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.json({
        ai_score: 0.5,
        label: "Error: no image uploaded",
        version: "signai-backend",
        raw: { error: "No image uploaded" }
      });
    }
    if (!WINSTON_API_KEY) {
      return res.json({
        ai_score: 0.5,
        label: "Error: WINSTON_API_KEY missing",
        version: "signai-backend",
        raw: { error: "WINSTON_API_KEY not set in environment" }
      });
    }

    // 1) Spara bild till /tmp/uploads
    const originalName = req.file.originalname || "image.png";
    const ext = path.extname(originalName) || ".png";
    const filename =
      Date.now() + "-" + Math.random().toString(36).slice(2) + ext;
    const filePath = path.join(uploadDir, filename);

    fs.writeFileSync(filePath, req.file.buffer);

    // 2) Bygg publik URL som Winston kan läsa
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const imageUrl = `${baseUrl}/uploads/${filename}`;

    console.log("🔗 Using image URL for Winston:", imageUrl);

    // 3) JSON-RPC request till Winston MCP – ai-image-detection
    const rpcBody = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "ai-image-detection",
        arguments: {
          url: imageUrl,
          apiKey: WINSTON_API_KEY
        }
      }
    };

    const winstonRes = await axios.post(WINSTON_MCP_URL, rpcBody, {
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        // viktigt enligt docs:
        jsonrpc: "2.0"
      },
      timeout: 20000
    });

    const data = winstonRes.data;
    console.log("🧠 Winston MCP raw response:", JSON.stringify(data, null, 2));

    // 4) Plocka ut relevant data ur JSON-RPC-svaret
    if (data.error) {
      // JSON-RPC-fel från Winston
      return res.json({
        ai_score: 0.5,
        label: "Error from Winston: " + data.error.message,
        version: "winston-ai-image-mcp",
        raw: data
      });
    }

    const result = data.result || data;
    const payload =
      (result && result.content) ||
      (result && result.output) ||
      result ||
      data;

    let aiScore =
      (typeof payload.ai_score === "number" && payload.ai_score) ??
      (typeof payload.ai_probability === "number" && payload.ai_probability) ??
      (typeof payload.score === "number" && payload.score) ??
      null;

    if (aiScore !== null && aiScore > 1) {
      aiScore = aiScore / 100; // 0–100 -> 0–1
    }

    let label = payload.label;
    if (!label && typeof payload.is_ai === "boolean") {
      label = payload.is_ai ? "AI" : "Human";
    }
    if (!label && typeof payload.is_human === "boolean") {
      label = payload.is_human ? "Human" : "AI";
    }

    if (aiScore === null) aiScore = 0.5;
    if (!label) label = "Unknown";

    const version =
      payload.version || payload.model || "winston-ai-image-mcp";

    return res.json({
      ai_score: aiScore,
      label,
      version,
      raw: data
    });
  } catch (err) {
    console.error(
      "❌ Winston error:",
      err.response?.status,
      err.response?.data || err.message
    );

    // Viktigt: skicka 200 även vid fel, så frontenden ser vad som hänt
    return res.json({
      ai_score: 0.5,
      label: "Error contacting Winston: " + (err.response?.status || err.code || "unknown"),
      version: "winston-ai-image-mcp",
      raw: err.response?.data || { message: err.message }
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Backend running on port", PORT);
});
