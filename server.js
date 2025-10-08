import express from "express";
import cors from "cors";
import { GoogleGenAI } from "@google/genai";

const app = express();
app.use(cors());
app.use(express.json());

// Google Gemini client - tự động lấy từ ENV GEMINI_API_KEY
const ai = new GoogleGenAI({});

app.post("/chat", async (req, res) => {
  const { message } = req.body;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash", // Model mới
      contents: message,
      config: {
        thinkingConfig: {
          thinkingBudget: 0, // Disable "thinking" nếu muốn nhanh hơn
        },
      },
    });

    res.json({ reply: response.text });

  } catch (error) {
    console.error("❌ Gemini API Error:", error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
