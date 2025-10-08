import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

// Lấy API key từ biến môi trường (Render → Environment)
const API_KEY = process.env.API_KEY;

app.post("/chat", async (req, res) => {
  const { message } = req.body;

  try {
    const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "deepseek-chat",  // 👈 model của DeepSeek
        messages: [{ role: "user", content: message }],
      }),
    });

    const data = await response.json();
    console.log("DeepSeek API response:", data); // 👈 log ra để xem lỗi

    // Nếu có lỗi từ API → trả nguyên response về client
    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    // Trả về nội dung AI trả lời
    const reply = data.choices?.[0]?.message?.content || "Không có phản hồi từ AI.";
    res.json({ reply });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
