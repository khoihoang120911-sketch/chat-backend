import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

// Lấy API key từ Render Environment
const API_KEY = process.env.API_KEY;

app.post("/chat", async (req, res) => {
  const { message } = req.body;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${API_KEY}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: message }
              ]
            }
          ]
        }),
      }
    );

    const data = await response.json();
    console.log("Gemini API response:", data); // log ra để kiểm tra
    if (data.error) {
      return res.status(400).json({ error: data.error.message });
    }

    // Lấy câu trả lời từ Gemini
    const reply =
      data.candidates?.[0]?.content?.parts?.[0]?.text ||
      "Không có phản hồi từ Gemini.";
    res.json({ reply });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
