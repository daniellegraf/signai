import express from "express";
import cors from "cors";
import multer from "multer";
import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

const app = express();

// Render / reverse proxy: viktigt för rätt https-länk
app.set("trust proxy", 1);

// Multer: spara fil i minne först
const upload = multer({ storage: multer.memoryStorage() });

// 🔓 CORS – tillåt allt (enkelt läge för att slippa "Failed to fetch")
app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

// Preflight (OPTIONS) för /detect-image
app.options("/detect-image", cors());

app.use(express.json());

// Winston API-nyckel
const WINSTON_API_KEY = process.env.WINSTON_API_KEY;

// MCP JSON-RPC endpoint
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

// ===== Hjälpfunktion: läs bildstorlek för PNG/JPEG =====
function getImageSize(buffer) {
  // PNG: width/height på bytes 16-24
  if (buffer.length > 24 && buffer[0] === 0x89 && buffer[1] === 0x50) {
    const w = buffer.readUInt32BE(16);
    const h = buffer.readUInt32BE(20);
    return { width: w, height: h, type: "png" };
  }

  // JPEG: leta SOF0/SOF2
  if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let i = 2;
    while (i < buffer.length) {
      if (buffer[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buffer[i + 1];
      const size = buffer.readUInt16BE(i + 2);

      // SOF0 (0xC0) eller SOF2 (0xC2)
      if (marker === 0xC0 || marker === 0xC2) {
        const h = buffer.readUInt16BE(i + 5);
        const w = buffer.readUInt16BE(i + 7);
        return { width: w, height: h, type: "jpeg" };
      }

      i += 2 + size;
    }
  }

  return null;
}

// ===== Hjälpfunktion: plocka första giltiga siffra =====
function pickNumber(...vals) {
  for (const v of vals) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

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

    // Om någon råkar skicka t.ex. test.txt → tydligt fel direkt
    const size = getImageSize(req.file.buffer);
    if (!size) {
      return res.json({
        ai_score: 0.5,
        label: "Error: uploaded file is not a PNG/JPEG image",
        version: "signai-backend",
        raw: { error: "NOT_AN_IMAGE" },
      });
    }

    // ✅ Winston kräver minst 256x256 (enligt din Render-logg)
    if (size.width < 256 || size.height < 256) {
      return res.json({
        ai_score: 0.5,
        label: `Error: image too small (${size.width}x${size.height}). Winston requires >=256x256.`,
        version: "signai-backend",
        raw: { error: "IMAGE_TOO_SMALL", ...size },
      });
    }

    // 1) Spara bilden till /tmp/uploads
    const originalName = req.file.originalname || "image.png";
    const ext = path.extname(originalName) || ".png";
    const filename =
      Date.now() + "-" + Math.random().toString(36).slice(2) + ext;
    const filePath = path.join(uploadDir, filename);

    fs.writeFileSync(filePath, req.file.buffer);

    // 2) Bygg publik URL (tvinga korrekt https genom proxy-header)
    const proto = (req.headers["x-forwarded-proto"] || "https")
      .toString()
      .split(",")[0]
      .trim();

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

    if (data?.error) {
      return res.json({
        ai_score: 0.5,
        label: "Error from Winston: " + (data.error.message || "unknown"),
        version: "winston-ai-image-mcp",
        raw: data,
      });
    }

    // Winston JSON-RPC kan returnera data på lite olika ställen
    const result = data?.result ?? data;
    const payload =
      result?.content ??
      result?.output ??
      result ??
      data;

    // ✅ FIX: aiScore ska ALDRIG kunna bli false
    let aiScore = pickNumber(
      payload?.ai_score,
      payload?.ai_probability,
      payload?.score,
      payload?.probability
    );

    // Om Winston ger 0–100
    if (aiScore !== null && aiScore > 1) aiScore = aiScore / 100;

    // Fallback
    if (aiScore === null) aiScore = 0.5;

    let label = payload?.label;
    if (!label && typeof payload?.is_ai === "boolean")
      label = payload.is_ai ? "AI" : "Human";
    if (!label && typeof payload?.is_human === "boolean")
      label = payload.is_human ? "Human" : "AI";
    if (!label) label = "Unknown";

    const version =
      payload?.version || payload?.model || "winston-ai-image-mcp";

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
