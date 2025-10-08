import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

// API key Hugging Face (Render → Environment)
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
          inputs: message,
          parameters: { max_new_tokens: 200 },
        }),
      }
    );

    const data = await response.json();

    // Debug log để xem Hugging Face trả gì
    console.log("HF response:", JSON.stringify(data));

    if (data.error) {
      return res.status(400).json({ error: data.error });
    }

    let reply;
    if (Array.isArray(data) && data.length > 0) {
      reply = data[0].generated_text;
    } else {
      reply = "Không có phản hồi từ AI.";
    }

    res.json({ reply });

  } catch (error) {
    console.error("Server error:", error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});

