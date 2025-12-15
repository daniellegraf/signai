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
app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

const WINSTON_API_KEY = process.env.WINSTONAI_API_KEY;
const WINSTON_MCP_URL = "https://api.gowinston.ai/mcp/v1";

// temp uploads
const uploadDir = "/tmp/uploads";
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// public images
app.use("/uploads", express.static(uploadDir));

app.get("/", (req, res) => {
  res.send("SignAi backend running");
});

function makePublicUrl(req, filename) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.get("host");
  return `${proto}://${host}/uploads/${filename}`;
}

function normalizeScore(x) {
  if (x === null || x === undefined) return null;

  if (typeof x === "string") {
    const cleaned = x.replace("%", "").trim();
    const n = parseFloat(cleaned);
    if (!Number.isFinite(n)) return null;
    x = n;
  }

  if (typeof x !== "number" || !Number.isFinite(x)) return null;

  if (x > 1 && x <= 100) return x / 100;
  if (x >= 0 && x <= 1) return x;

  return null;
}

// ✅ Plockar JSON från Winston-texten: "Full API Response : { ... }"
function extractJsonFromWinstonText(text) {
  if (!text || typeof text !== "string") return null;

  const marker = "Full API Response";
  const idx = text.indexOf(marker);
  if (idx === -1) return null;

  // hitta första { efter markern
  const braceStart = text.indexOf("{", idx);
  if (braceStart === -1) return null;

  // hitta matchande } genom att räkna klamrar
  let depth = 0;
  for (let i = braceStart; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    if (depth === 0) {
      const jsonStr = text.slice(braceStart, i + 1);
      try {
        return JSON.parse(jsonStr);
      } catch {
        return null;
      }
    }
  }
  return null;
}

// ✅ Hämta ai_probability/human_probability ur antingen riktiga fält eller ur textens inbäddade JSON
function extractWinstonResult(obj) {
  if (!obj || typeof obj !== "object") return null;

  // 1) om Winston redan ger riktiga fält (ibland gör den det)
  const direct = {
    ai_probability: obj.ai_probability,
    human_probability: obj.human_probability,
    score: obj.score,
  };

  const ai1 = normalizeScore(direct.ai_probability);
  const human1 = normalizeScore(direct.human_probability);

  if (ai1 !== null || human1 !== null) {
    return {
      ai_probability: ai1,
      human_probability: human1,
      score: normalizeScore(direct.score),
      raw: obj,
    };
  }

  // 2) Winston MCP verkar ge: data.content[0].text som innehåller JSON
  const text = obj?.content?.[0]?.text;
  const embedded = extractJsonFromWinstonText(text);

  if (embedded) {
    return {
      ai_probability: normalizeScore(embedded.ai_probability),
      human_probability: normalizeScore(embedded.human_probability),
      score: normalizeScore(embedded.score),
      raw: embedded,
      embedded_text: text,
    };
  }

  return null;
}

async function callWinstonImage(imageUrl) {
  if (!WINSTON_API_KEY) {
    return {
      ok: false,
      status: 500,
      data: { error: "Missing WINSTONAI_API_KEY in Render Environment" },
    };
  }

  const resp = await fetch(WINSTON_MCP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "ai-image-detection",
        arguments: {
          url: imageUrl,
          apiKey: WINSTON_API_KEY,
        },
      },
    }),
  });

  const data = await resp.json().catch(() => null);

  if (!resp.ok || data?.error) {
    return { ok: false, status: resp.status, data };
  }

  return { ok: true, status: 200, data: data.result };
}

app.post("/detect-image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        ai_score: 0.5,
        label: "No image uploaded",
      });
    }

    const filename = crypto.randomBytes(16).toString("hex") + ".jpg";
    const filePath = path.join(uploadDir, filename);
    fs.writeFileSync(filePath, req.file.buffer);

    const imageUrl = makePublicUrl(req, filename);

    const w = await callWinstonImage(imageUrl);
    console.log("Winston response:", JSON.stringify(w, null, 2));

    if (!w.ok) {
      return res.status(502).json({
        ai_score: 0.5,
        label: "Winston error",
        status: w.status,
        raw: w.data,
        image_url: imageUrl,
      });
    }

    // ✅ Här gör vi “rätt”: ta ut riktiga siffror ur text/JSON
    const parsed = extractWinstonResult(w.data);

    if (!parsed || (parsed.ai_probability === null && parsed.human_probability === null)) {
      return res.json({
        ai_score: 0.5,
        label: "Unknown",
        image_url: imageUrl,
        raw: w.data,
        note: "Could not parse Winston result (no numeric probabilities found).",
      });
    }

    // Välj AI-score: helst ai_probability, annars 1-human_probability
    let aiScore = parsed.ai_probability;
    if (aiScore === null && parsed.human_probability !== null) {
      aiScore = 1 - parsed.human_probability;
    }
    if (aiScore === null) aiScore = 0.5;

    // Labels med trösklar
    let label = "Mixed";
    if (aiScore >= 0.65) label = "AI";
    else if (aiScore <= 0.35) label = "Human";

    return res.json({
      ai_score: aiScore,
      label,
      image_url: imageUrl,
      // skicka tillbaka det rena parsed-resultatet också (nice för debug)
      parsed: {
        ai_probability: parsed.ai_probability,
        human_probability: parsed.human_probability,
        score: parsed.score,
        version: parsed.raw?.version,
        mime_type: parsed.raw?.mime_type,
        credits_used: parsed.raw?.credits_used,
        credits_remaining: parsed.raw?.credits_remaining,
        ai_watermark_detected: parsed.raw?.ai_watermark_detected,
      },
      raw: w.data,
    });
  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({
      ai_score: 0.5,
      label: "Server error",
      error: err.message,
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Backend running on port", PORT);
});
