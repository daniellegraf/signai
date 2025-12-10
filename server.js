import express from "express";
import cors from "cors";
import multer from "multer";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());

// Din API-nyckel ligger i Render → Environment → WINSTON_API_KEY
const WINSTON_API_KEY = process.env.WINSTON_API_KEY;

// Detta är WinstonAI:s bild-endpoint
const WINSTON_URL = "https://api.winstonai.com/v1/image";

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "SignAI backend running" });
});

// Bilddetektering
app.post("/detect-image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image uploaded" });

    const response = await axios.post(
      WINSTON_URL,
      req.file.buffer,
      {
        headers: {
          "Content-Type": "application/octet-stream",
          "Authorization": `Bearer ${WINSTON_API_KEY}`
        }
      }
    );

    const data = response.data;

    // Mappa till standardform som den nya SignAI-frontenden förstår
    res.json({
      ai_score: data.score ?? data.ai_score ?? null,
      label: data.is_ai ? "AI" : "Human",
      version: data.model || "winston-ai",
      raw: data
    });
  } catch (err) {
    console.error("Winston error:", err.response?.data || err.message);
    res.status(500).json({
      error: "Winston AI request failed",
      details: err.response?.data || err.message
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Backend running on port", PORT));
