import express from "express";
import cors from "cors";
import multer from "multer";
import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import sharp from "sharp";

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

app.use(
  "/uploads",
  express.static(uploadDir, {
    setHeaders(res) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.setHeader("X-Content-Type-Options", "nosniff");
    },
  })
);

app.get("/healthz", (req, res) => {
  res.json({ status: "ok", service: "signai-backend", path: "/healthz" });
});

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "signai-backend" });
});

function firstBytesHex(buffer, n) {
  const len = Math.min(buffer.length, n);
  return Buffer.from(buffer.slice(0, len)).toString("hex");
}

async function selfFetchCheck(url) {
  try {
    const r = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 15000,
      headers: { "User-Agent": "SignAiSelfCheck/1.0" },
      validateStatus: () => true,
    });

    const buf = Buffer.from(r.data || []);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      contentType: r.headers?.["content-type"] || null,
      contentLength: r.headers?.["content-length"] || null,
      firstBytesHex: buf.length ? firstBytesHex(buf, 24) : null,
      bytes: buf.length,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

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

    // === 1) Re-encode med sharp (fixar “weird jpeg/webp/heic etc”) ===
    // - läser metadata
    // - roterar korrekt (EXIF)
    // - säkerställer minst 256x256 (utan att förstöra proportioner)
    // - skriver om till baseline JPEG
    let meta;
    try {
      meta = await sharp(req.file.buffer).metadata();
    } catch (e) {
      return res.json({
        ai_score: 0.5,
        label: "Error: file is not a readable image",
        version: "signai-backend",
        raw: { error: "UNREADABLE_IMAGE", message: e.message },
      });
    }

    const w = meta.width || 0;
    const h = meta.height || 0;

    if (w < 256 || h < 256) {
      return res.json({
        ai_score: 0.5,
        label: `Error: image too small (${w}x${h}). Winston requires >=256x256.`,
        version: "signai-backend",
        raw: { error: "IMAGE_TOO_SMALL", width: w, height: h, format: meta.format },
      });
    }

    // Re-encode till JPEG (mozjpeg) för maximal kompatibilitet
    const encodedBuffer = await sharp(req.file.buffer)
      .rotate()
      .jpeg({ quality: 92, mozjpeg: true })
      .toBuffer();

    // === 2) Spara filen publikt ===
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;
    const filePath = path.join(uploadDir, filename);
    fs.writeFileSync(filePath, encodedBuffer);

    const proto = (req.headers["x-forwarded-proto"] || "https").toString().split(",")[0].trim();
    const baseUrl = `${proto}://${req.get("host")}`;
    const imageUrl = `${baseUrl}/uploads/${filename}`;

    console.log("Using image URL for Winston:", imageUrl);

    const selfFetch = await selfFetchCheck(imageUrl);
    console.log("SelfFetchCheck:", selfFetch);

    // === 3) Winston MCP call ===
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
      validateStatus: () => true,
    });

    const data = winstonRes.data;

    // Winston “error som text”
    const maybeText = data?.result?.content;
    if (Array.isArray(maybeText) && maybeText[0]?.type === "text" && typeof maybeText[0]?.text === "string") {
      const t = maybeText[0].text;
      if (t.toLowerCase().includes("there was an error")) {
        return res.json({
          ai_score: 0.5,
          label: "Winston error: " + t,
          version: "winston-ai-image-mcp",
          raw: {
            winston: data,
            debug: {
              imageUrl,
              meta: { width: w, height: h, format: meta.format },
              selfFetch,
              encodedBytes: encodedBuffer.length,
              encodedFirstBytesHex: firstBytesHex(encodedBuffer, 24),
            },
          },
        });
      }
    }

    if (data?.error) {
      return res.json({
        ai_score: 0.5,
        label: "Winston error: " + data.error.message,
        version: "winston-ai-image-mcp",
        raw: { winston: data, debug: { imageUrl, meta, selfFetch } },
      });
    }

    // Om Winston någonsin returnerar riktig payload:
    const result = data?.result ?? data;
    const payload = result?.content ?? result?.output ?? result;

    let aiScore =
      (typeof payload?.ai_score === "number" && payload.ai_score) ??
      (typeof payload?.ai_probability === "number" && payload.ai_probability) ??
      (typeof payload?.score === "number" && payload.score) ??
      null;

    if (aiScore !== null && aiScore > 1) aiScore = aiScore / 100;

    let label = payload?.label ?? null;
    if (!label && typeof payload?.is_ai === "boolean") label = payload.is_ai ? "AI" : "Human";
    if (!label && typeof payload?.is_human === "boolean") label = payload.is_human ? "Human" : "AI";

    if (aiScore === null) aiScore = 0.5;
    if (!label) label = "Unknown";

    return res.json({
      ai_score: aiScore,
      label,
      version: payload?.version || payload?.model || "winston-ai-image-mcp",
      raw: { winston: data, debug: { imageUrl, meta: { width: w, height: h, format: meta.format }, selfFetch } },
    });
  } catch (err) {
    console.error("Winston error:", err.response?.status, err.response?.data || err.message);
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
