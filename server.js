import express from "express";
import cors from "cors";
import multer from "multer";
import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

const app = express();

// Multer – vi kör allt i minnet, sen skriver vi till /tmp/uploads
const upload = multer({ storage: multer.memoryStorage() });

// CORS – tillåt din Neocities-sida + ev. andra origins vid test
app.use(cors({
  origin: [
    "https://signai.neocities.org",
    "https://www.signai.neocities.org",
    "http://localhost:5500",
    "http://localhost:3000",
    "http://localhost:5173"
  ],
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

// Preflight för just /detect-image
app.options("/detect-image", cors());

app.use(express.json());

// Winston API-key från Render env
const WINSTON_API_KEY = process.env.WINSTON_API_KEY;

// OBS: Byt denna till EXAKT den endpoint Winston anger för bild-detektion.
// Exempel (du måste verifiera i deras docs): 
//   https://api.gowinston.ai/v2/image-detection
const WINSTON_IMAGE_ENDPOINT = "https://api.gowinston.ai/v2/image-detection";

// Katalog på Render där vi sparar temporära bilder
const uploadDir = "/tmp/uploads";
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(upl
