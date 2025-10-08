import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

// Lấy API key từ biến môi trường (Render → Environment)
const API_KEY = process.env.HF_API_KEY;

app.post("/chat", async (req, res) => {
  const { message } = req.body;

  try {
    const response = await fetch(
      "https://api-inference.huggingface.co/models/mistralai/Mixtral-8x7B-Instruct-v0.1",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          inputs: message, // Hugging Face chỉ cần text input
        }),
      }
    );

    const data = await response.json();

    // Hugging Face trả về mảng, lấy text đầu tiên
    const reply = data[0]?.generated_text || "Không có phản hồi từ AI.";
    res.json({ reply });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
