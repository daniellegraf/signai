import express from "express";
import cors from "cors";
import multer from "multer";
import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

const app = express();
app.set("trust proxy", 1);
// Multer: spara fil i minne först
const upload = multer({ storage: multer.memoryStorage() });

// 🔓 CORS – tillåt allt (enkelt läge för att slippa "Failed to fetch")
app.use(
  cors({
    origin: true,          // spegla origin automatiskt
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

// Preflight (OPTIONS) för /detect-image
app.options("/detect-image", cors());

app.use(express.json());

// Winston API-nyckel
const WINSTON_API_KEY = process.env.WINSTON_API_KEY;
const WINSTON_MCP_URL = "https://api.gowinston.ai/mcp/v1";

// Katalog för temporära bilder på Render
const uploadDir = "/tmp/uploads";
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Serva bilder publikt så Winston kan nå dem
app.use("/uploads", express.static(uploadDir));

// Health-check
app.get("/healthz", (req, res) => {
  res.json({ status: "ok", service: "signai-backend", path: "/healthz" });
});

// Root
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "signai-backend" });
});

// ===== HUVUD-ROUTE: /detect-image =====
app.post("/detect-image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.json({
        ai_score: 0.5,
        label: "Error: no image uploaded",
        version: "signai-backend",
        raw: { error: "No image uploaded" },
      });
    }

    if (!WINSTON_API_KEY) {
      return res.json({
        ai_score: 0.5,
        label: "Error: WINSTON_API_KEY missing",
        version: "signai-backend",
        raw: { error: "WINSTON_API_KEY not set in environment" },
      });
    }

    // 1) Spara bilden till /tmp/uploads
    const originalName = req.file.originalname || "image.png";
    const ext = path.extname(originalName) || ".png";
    const filename =
      Date.now() + "-" + Math.random().toString(36).slice(2) + ext;
    const filePath = path.join(uploadDir, filename);

    fs.writeFileSync(filePath, req.file.buffer);

    // 2) Publik URL som Winston kan hämta
    const proto = (req.headers["x-forwarded-proto"] || "https").toString().split(",")[0].trim();
const baseUrl = `${proto}://${req.get("host")}`;
    const imageUrl = `${baseUrl}/uploads/${filename}`;

    console.log("🔗 Using image URL for Winston:", imageUrl);

    // 3) JSON-RPC anrop till Winston MCP – ai-image-detection
    const rpcBody = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "ai-image-detection",
        arguments: {
          url: imageUrl,
          apiKey: WINSTON_API_KEY,
        },
      },
    };

    const winstonRes = await axios.post(WINSTON_MCP_URL, rpcBody, {
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        jsonrpc: "2.0",
      },
      timeout: 20000,
    });

    const data = winstonRes.data;
    console.log("🧠 Winston MCP raw response:", JSON.stringify(data, null, 2));

    if (data.error) {
      return res.json({
        ai_score: 0.5,
        label: "Error from Winston: " + data.error.message,
        version: "winston-ai-image-mcp",
        raw: data,
      });
    }

    const result = data.result || data;
    const payload =
      result?.content ||
      result?.output ||
      result ||
      data;

    let aiScore =
      (typeof payload.ai_score === "number" && payload.ai_score) ??
      (typeof payload.ai_probability === "number" && payload.ai_probability) ??
      (typeof payload.score === "number" && payload.score) ??
      null;

    if (aiScore !== null && aiScore > 1) {
      aiScore = aiScore / 100;
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
      raw: data,
    });
  } catch (err) {
    console.error(
      "❌ Winston error:",
      err.response?.status,
      err.response?.data || err.message
    );

    // OBS: vi skickar 200 med feltext – så frontenden alltid får svar
    return res.json({
      ai_score: 0.5,
      label:
        "Error contacting Winston: " +
        (err.response?.status || err.code || "unknown"),
      version: "winston-ai-image-mcp",
      raw: err.response?.data || { message: err.message },
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Backend running on port", PORT);
});

