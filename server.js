// server.js
import express from "express";
import cors from "cors";
import { GoogleGenAI } from "@google/genai";

const app = express();
app.use(cors());
app.use(express.json());

// SDK sẽ đọc GEMINI_API_KEY từ biến môi trường Render
const ai = new GoogleGenAI({});

app.post("/chat", async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "Thiếu field 'message' trong body" });

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: message,
      config: {
        thinkingConfig: { thinkingBudget: 0 }
      }
    });

    const reply =
      response?.text ??
      response?.candidates?.[0]?.content?.parts?.[0]?.text ??
      "Không có phản hồi.";
    res.json({ reply });
  } catch (err) {
    console.error("Gemini error:", err);
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
