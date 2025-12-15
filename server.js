import express from "express";
import cors from "cors";
import multer from "multer";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import crypto from "crypto";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

const WINSTON_API_KEY = process.env.WINSTONAI_API_KEY;

// ✅ REST endpoint (samma som webappen)
const WINSTON_IMAGE_URL = "https://api.gowinston.ai/v2/image-detection";

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

async function callWinstonImageREST(imageUrl) {
  const resp = await fetch(WINSTON_IMAGE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WINSTON_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url: imageUrl,
    }),
  });

  const data = await resp.json().catch(() => null);
  return { ok: resp.ok, status: resp.status, data };
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

    const w = await callWinstonImageREST(imageUrl);

    if (!w.ok) {
      return res.status(502).json({
        ai_score: 0.5,
        label: `Winston REST error: ${w.status}`,
        raw: w.data,
      });
    }

    const aiScore =
      typeof w.data?.ai_probability === "number"
        ? w.data.ai_probability
        : 0.5;

    const label = aiScore >= 0.5 ? "AI" : "Human";

    return res.json({
      ai_score: aiScore,
      label,
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
app.listen(PORT, () => {
  console.log("Backend running on port", PORT);
});
