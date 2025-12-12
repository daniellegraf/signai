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

const upload = multer({ storage: multer.memoryStorage() });

app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

app.options("/detect-image", cors());
app.use(express.json());

const WINSTON_API_KEY = process.env.WINSTON_API_KEY;
const WINSTON_MCP_URL = "https://api.gowinston.ai/mcp/v1";

const uploadDir = "/tmp/uploads";
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// Sätt headers på uploads (bra för externa fetchers)
app.use(
  "/uploads",
  (req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "public, max-age=60");
    next();
  },
  express.static(uploadDir)
);

app.get("/healthz", (req, res) => {
  res.json({ status: "ok", service: "signai-backend", path: "/healthz" });
});

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "signai-backend" });
});

// --- MAGIC BYTES: filtyp ---
function detectImageType(buffer) {
  if (!buffer || buffer.length < 16) return null;

  // PNG: 89 50 4E 47
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "png";
  }

  // JPEG: FF D8
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    return "jpeg";
  }

  // WEBP: "RIFF....WEBP"
  if (
    buffer[0] === 0x52 && // R
    buffer[1] === 0x49 && // I
    buffer[2] === 0x46 && // F
    buffer[3] === 0x46 && // F
    buffer[8] === 0x57 && // W
    buffer[9] === 0x45 && // E
    buffer[10] === 0x42 && // B
    buffer[11] === 0x50 // P
  ) {
    return "webp";
  }

  return null;
}

// --- Bildstorlek: PNG/JPEG ---
function getImageSize(buffer) {
  // PNG width/height på bytes 16-24
  if (
    buffer.length > 24 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
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

      if (marker === 0xc0 || marker === 0xc2) {
        const h = buffer.readUInt16BE(i + 5);
        const w = buffer.readUInt16BE(i + 7);
        return { width: w, height: h, type: "jpeg" };
      }

      i += 2 + size;
    }
  }

  return null;
}

// ===== /detect-image =====
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

    // 0) Kolla filtyp via magic bytes
    const realType = detectImageType(req.file.buffer);

    if (!realType) {
      return res.json({
        ai_score: 0.5,
        label: "Error: unknown image type. Use PNG or JPEG.",
        version: "signai-backend",
        raw: { error: "UNKNOWN_IMAGE_TYPE" },
      });
    }

    if (realType === "webp") {
      return res.json({
        ai_score: 0.5,
        label: "Error: WEBP not supported. Convert to PNG/JPEG before upload.",
        version: "signai-backend",
        raw: { error: "WEBP_NOT_SUPPORTED" },
      });
    }

    // 1) Kolla storlek (måste vara >= 256x256)
    const size = getImageSize(req.file.buffer);
    if (!size) {
      return res.json({
        ai_score: 0.5,
        label: `Error: could not read image dimensions (type=${realType}). Use PNG/JPEG.`,
        version: "signai-backend",
        raw: { error: "CANNOT_READ_DIMENSIONS", type: realType },
      });
    }

    if (size.width < 256 || size.height < 256) {
      return res.json({
        ai_score: 0.5,
        label: `Error: image too small (${size.width}x${size.height}). Winston requires >=256x256.`,
        version: "signai-backend",
        raw: { error: "IMAGE_TOO_SMALL", ...size },
      });
    }

    // 2) Spara fil med RÄTT filändelse baserat på verklig typ
    const ext = realType === "png" ? ".png" : ".jpg";
    const filename =
      Date.now() + "-" + Math.random().toString(36).slice(2) + ext;
    const filePath = path.join(uploadDir, filename);
    fs.writeFileSync(filePath, req.file.buffer);

    // 3) Bygg publik URL (tvinga https)
    const proto = (req.headers["x-forwarded-proto"] || "https")
      .toString()
      .split(",")[0]
      .trim();
    const baseUrl = `${proto}://${req.get("host")}`;
    const imageUrl = `${baseUrl}/uploads/${filename}`;

    console.log("🔗 Winston imageUrl:", imageUrl, "type:", realType, "size:", size);

    // 4) Winston MCP call
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

    // Om Winston svarar med textfel i content → skicka tillbaka det tydligt
    const maybeTextError =
      data?.result?.content?.find((x) => x?.type === "text")?.text || null;

    if (maybeTextError) {
      return res.json({
        ai_score: 0.5,
        label: "Winston error: " + maybeTextError,
        version: "winston-ai-image-mcp",
        raw: {
          winston: data,
          debug: { imageUrl, realType, size },
        },
      });
    }

    // Försök plocka score från payload (om Winston faktiskt skickar)
    const result = data.result || data;
    const payload = result?.content || result?.output || result || data;

    let aiScore =
      (typeof payload.ai_score === "number" && payload.ai_score) ??
      (typeof payload.ai_probability === "number" && payload.ai_probability) ??
      (typeof payload.score === "number" && payload.score) ??
      null;

    if (aiScore !== null && aiScore > 1) aiScore = aiScore / 100;

    let label = payload.label;
    if (!label && typeof payload.is_ai === "boolean") label = payload.is_ai ? "AI" : "Human";
    if (!label && typeof payload.is_human === "boolean") label = payload.is_human ? "Human" : "AI";

    if (aiScore === null) aiScore = 0.5;
    if (!label) label = "Unknown";

    return res.json({
      ai_score: aiScore,
      label,
      version: payload.version || payload.model || "winston-ai-image-mcp",
      raw: {
        winston: data,
        debug: { imageUrl, realType, size },
      },
    });
  } catch (err) {
    console.error("❌ Winston error:", err.response?.status, err.response?.data || err.message);

    return res.json({
      ai_score: 0.5,
      label: "Error contacting Winston: " + (err.response?.status || err.code || "unknown"),
      version: "winston-ai-image-mcp",
      raw: err.response?.data || { message: err.message },
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Backend running on port", PORT);
});
