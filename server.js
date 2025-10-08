import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const HF_API_KEY = process.env.HF_API_KEY;

app.post("/chat", async (req, res) => {
  const { message } = req.body;
  try {
    const r = await fetch("https://api-inference.huggingface.co/models/google/flan-t5-small", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${HF_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ inputs: message }),
    });
    const data = await r.json();
    console.log("HF response:", JSON.stringify(data));
    if (data.error) return res.status(400).json({ error: data.error });
    const reply = Array.isArray(data) && data[0]?.generated_text ? data[0].generated_text : (data.generated_text || "Không có phản hồi.");
    res.json({ reply });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
