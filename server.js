import express from "express";
import cors from "cors";
import multer from "multer";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import crypto from "crypto";

dotenv.config();

const app = express();
app.set("trust proxy", 1);
app.disable("etag");

app.use(cors({ origin: true }));
app.options("*", cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

// ✅ Lägg nyckeln i ENV (Render -> Environment -> WINSTONAI_API_KEY)
const WINSTON_API_KEY = process.env.WINSTONAI_API_KEY;

// Winston MCP (JSON-RPC)
const WINSTON_MCP_URL = "https://api.gowinston.ai/mcp/v1";

// Temp uploads (Render funkar med /tmp)
const uploadDir = "/tmp/uploads";
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// Gör bilderna publikt nåbara via URL (Winston MCP behöver URL)
app.use(
  "/uploads",
  express.static(uploadDir, {
    etag: false,
    lastModified: false,
    setHeaders(res) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Pragma", "no-cache");
    },
  })
);

// ✅ NY – root route
app.get("/", (req, res) => res.send("SignAi backend running"));

app.get("/healthz", (req, res) => res.json({ status: "ok" }));

function makePublicUrl(req, filename) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.headers["x-forwarded-host"] || req.get("host");
  return `${proto}://${host}/uploads/${filename}`;
}

async function callWinstonMcpImage(url) {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "ai-image-detection",
      arguments: {
        url,
        apiKey: WINSTON_API_KEY,
      },
    },
  };

  const resp = await fetch(WINSTON_MCP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await resp.json().catch(() => null);
  return { ok: resp.ok, status: resp.status, data };
}

app.post("/detect-image", upload.single("image"), async (req, res) => {
  try {
    if (!WINSTON_API_KEY) {
      return res.status(500).json({
        ai_score: 0.5,
        label: "Server misconfigured: missing WINSTON_API_KEY",
      });
    }

    if (!req.file) {
      return res.status(400).json({
        ai_score: 0.5,
        label: "Error: no image uploaded",
      });
    }

    const filename = crypto.randomBytes(16).toString("hex") + ".jpg";
    const filePath = path.join(uploadDir, filename);
    fs.writeFileSync(filePath, req.file.buffer);

    const imageUrl = makePublicUrl(req, filename);
    const w = await callWinstonMcpImage(imageUrl);

    if (!w.ok) {
      return res.status(502).json({
        ai_score: 0.5,
        label: `Winston MCP HTTP error: ${w.status}`,
        raw: w.data,
        image_url: imageUrl,
      });
    }

    const result = w.data?.result ?? w.data;
    const payload = result?.output ?? result?.content ?? result;

    let aiScore =
      typeof payload?.ai_score === "number"
        ? payload.ai_score
        : typeof payload?.ai_probability === "number"
        ? payload.ai_probability
        : typeof payload?.score === "number"
        ? payload.score
        : null;

    if (aiScore !== null && aiScore > 1) aiScore = aiScore / 100;
    if (aiScore === null || !Number.isFinite(aiScore)) aiScore = 0.5;

    const label =
      payload?.label ??
      (typeof payload?.is_ai === "boolean"
        ? payload.is_ai
          ? "AI"
          : "Human"
        : null) ??
      "Unknown";

    return res.json({
      ai_score: aiScore,
      label,
      version: "winston-mcp",
      image_url: imageUrl,
      raw: w.data,
    });
  } catch (err) {
    return res.status(500).json({
      ai_score: 0.5,
      label: "Server error",
      error: err.message,
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Backend running on port", PORT));
