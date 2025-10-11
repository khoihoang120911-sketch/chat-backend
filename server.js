// server.js (final: context memory + DB search + recap + add/delete + robust JSON handling)
import express from "express";
import bodyParser from "body-parser";
import pkg from "pg";
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
app.use(bodyParser.json());

// ===== path helpers =====
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===== Postgres setup =====
const { Pool } = pkg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ===== Gemini setup =====
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ===== init tables =====
async function initTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS books (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      author TEXT NOT NULL,
      category TEXT,
      position TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      role TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
}
await initTables();

// seed if needed (keeps behavior you used before)
import("./seedBooks.js").catch(()=>{/* ignore if missing */});

// ===== helpers =====

// safe JSON extraction: find the first {...} block in text
function extractFirstJson(text) {
  if (!text || typeof text !== "string") return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch (e) {
    return null;
  }
}

// assign position based on category (A..Z first letter) and 15 books per shelf
async function assignPosition(category) {
  if (!category) return "X?";
  const letter = category.trim()[0]?.toUpperCase() || "X";
  const res = await pool.query("SELECT COUNT(*) FROM books WHERE category = $1", [category]);
  const count = parseInt(res.rows[0].count || "0", 10);
  const shelf = Math.floor(count / 15) + 1;
  return `${letter}${shelf}`;
}

// infer category (tries to use Gemini; asks it to use web if available)
async function inferCategory(bookName, author) {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  const prompt = `
Bạn là quản thủ thư viện thông minh.
Nhiệm vụ: Dựa trên tên sách và tác giả, xác định THỂ LOẠI phù hợp nhất.
- Tên: "${bookName}"
- Tác giả: "${author}"

Hướng dẫn:
- Nếu có thể, tra cứu web để xác nhận thể loại (nếu API key của bạn hỗ trợ web).
- Chỉ chọn 1 thể loại ngắn gọn: Ví dụ "Văn học", "Khoa học", "Công nghệ", "Tâm lý", "Kinh tế", "Lịch sử", "Triết học", "Chính trị", "Giáo dục", "Khác".
- TRẢ VỀ CHỈ 1 OBJECT JSON: {"category": "Thể loại"}
- KHÔNG thêm văn bản nào khác.
`;

  try {
    const response = await model.generateContent(prompt);
    const raw = response.response.text();
    console.log("🔎 inferCategory raw:", raw);
    const parsed = extractFirstJson(raw);
    if (parsed && parsed.category) {
      return parsed.category;
    }
    // fallback simple heuristic: if title contains known words
    const titleLower = bookName.toLowerCase();
    if (/(python|program|code|data|ai|machine)/i.test(titleLower)) return "Công nghệ";
    if (/(tiểu thuyết|truyện|novel|poem|du ký|ký)/i.test(titleLower)) return "Văn học";
    if (/(lịch sử|history|war|chiến tranh)/i.test(titleLower)) return "Lịch sử";
    return "Chưa rõ";
  } catch (e) {
    console.warn("⚠️ inferCategory error:", e?.message || e);
    return "Chưa rõ";
  }
}

// use Gemini to pick best book from a provided books list and reason (returns object or null)
async function askGeminiToChoose(message, books, conversationContext = "") {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  const prompt = `
Bạn là trợ lý thư viện. Dựa trên đoạn hội thoại gần đây dưới đây:
${conversationContext}

Người dùng vừa nói: "${message}"

Danh sách sách (JSON array): ${JSON.stringify(books, null, 2)}

Nhiệm vụ:
1) Chọn 1 cuốn sách phù hợp nhất trong danh sách trên (KHÔNG được bịa cuốn mới).
2) Trả về JSON duy nhất có cấu trúc:
{
  "title": "Tên sách EXACT từ DB",
  "author": "Tác giả EXACT từ DB",
  "category": "Thể loại EXACT từ DB",
  "location": "Vị trí EXACT từ DB",
  "reason": "Giải thích ngắn (1-2 câu) vì sao phù hợp"
}

Nếu bạn không thể chọn thì trả {"title": "", "reason": "Không tìm thấy"}.
KHÔNG thêm văn bản khác.
  `;

  try {
    const response = await model.generateContent(prompt);
    const raw = response.response.text();
    console.log("🧠 askGeminiToChoose raw:", raw);
    const parsed = extractFirstJson(raw);
    return parsed;
  } catch (e) {
    console.warn("⚠️ askGeminiToChoose error:", e?.message || e);
    return null;
  }
}

// ask Gemini to produce a recap/summary, instruct it to use web if available
async function askGeminiForRecap(bookTitle, author) {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  const prompt = `
Bạn là một trợ lý tóm tắt sách chuyên nghiệp.
Yêu cầu: Tóm tắt ngắn (100-200 từ) nội dung, chủ đề và đối tượng người đọc của cuốn:
- Tên: "${bookTitle}"
- Tác giả: "${author}"

Hướng dẫn:
- Nếu có thể, tra cứu web (wiki, bài review, mô tả nhà xuất bản) để lấy thông tin chính xác.
- Nếu web không khả dụng, dùng kiến thức của bạn để tóm tắt.
- Trả về JSON duy nhất:
{"title":"${bookTitle}", "author":"${author}", "recap":"Tóm tắt ngắn gọn không quá 200 từ"}
- KHÔNG thêm văn bản khác.
  `;

  try {
    const response = await model.generateContent(prompt);
    const raw = response.response.text();
    console.log("🧠 recap raw:", raw);
    const parsed = extractFirstJson(raw);
    return parsed;
  } catch (e) {
    console.warn("⚠️ askGeminiForRecap error:", e?.message || e);
    return null;
  }
}

// ===== Serve index.html =====
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ===== /chat endpoint =====
app.post("/chat", async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "Thiếu 'message'" });

  try {
    // save user message
    await pool.query("INSERT INTO conversations (role, message) VALUES ($1, $2)", ["user", message]);

    let reply = "";

    const lower = message.toLowerCase();

    // 1) add book
    if (lower.startsWith("add book")) {
      const match = message.match(/bn:\s*([^;]+);\s*at:\s*(.+)/i);
      if (!match) {
        reply = "❌ Sai cú pháp. Dùng: add book: bn: Tên sách; at: Tác giả";
      } else {
        const bookName = match[1].trim();
        const author = match[2].trim();

        const category = await inferCategory(bookName, author);
        const position = await assignPosition(category);

        await pool.query(
          "INSERT INTO books (name, author, category, position) VALUES ($1,$2,$3,$4)",
          [bookName, author, category, position]
        );

        reply = `✅ Đã thêm sách: "${bookName}" (${author})\nThể loại: ${category}\nVị trí: ${position}`;
      }
    }

    // 2) delete book
    else if (lower.startsWith("delete book")) {
      const match = message.match(/bn:\s*([^;]+);\s*at:\s*(.+)/i);
      if (!match) {
        reply = "❌ Sai cú pháp. Dùng: delete book: bn: Tên sách; at: Tác giả";
      } else {
        const bookName = match[1].trim();
        const author = match[2].trim();
        const result = await pool.query("DELETE FROM books WHERE name=$1 AND author=$2 RETURNING *", [bookName, author]);
        reply = result.rowCount ? `🗑️ Đã xoá sách "${bookName}" của ${author}` : `⚠️ Không tìm thấy sách "${bookName}" của ${author}`;
      }
    }

    // 3) vị trí query: "vị trí A2 là quyển gì"
    else if (/\bvị trí\s+[A-Z]\d+\b/i.test(lower)) {
      const m = lower.match(/\bvị trí\s+([A-Z]\d+)\b/i);
      const pos = m ? m[1].toUpperCase() : null;
      if (!pos) {
        reply = "⚠️ Hãy nhập vị trí theo dạng ví dụ: 'vị trí B2 là quyển gì vậy'";
      } else {
        const { rows } = await pool.query("SELECT name, author, category FROM books WHERE position=$1 LIMIT 1", [pos]);
        if (rows.length) {
          const b = rows[0];
          reply = `📚 Ở vị trí ${pos}: "${b.name}" (${b.author})\nThể loại: ${b.category || "Chưa rõ"}`;
        } else {
          reply = `📭 Không có sách ở vị trí ${pos}.`;
        }
      }
    }

    // 4) recap request: contains "tóm tắt" or "recap" or "tóm tắt giúp"
    else if (/\b(tóm tắt|recap|tóm tắt giúp|summary|tóm tắt nội dung)\b/i.test(lower)) {
      // try to find book name in message or last mentioned book in recent convo
      // first try exact title in DB by simple LIKE
      let target = null;
      // search DB by title or author words
      const guess = message.replace(/["'‘’“”]/g, "").trim();
      const q = await pool.query(
        `SELECT name, author, category, position FROM books 
         WHERE LOWER(name) LIKE $1 OR LOWER(author) LIKE $1 LIMIT 1`,
        [`%${guess.toLowerCase()}%`]
      );
      if (q.rows.length) target = q.rows[0];

      // if not found, use last mentioned book in conversations
      if (!target) {
        const history = await pool.query("SELECT message FROM conversations ORDER BY id DESC LIMIT 8");
        const histText = history.rows.map(r => r.message).join("\n");
        // try to find a DB match by scanning history for title-like substrings
        // naive approach: check each DB book if its name appears in history
        const all = await pool.query("SELECT name, author, category, position FROM books");
        for (const b of all.rows) {
          if (histText.toLowerCase().includes(b.name.toLowerCase())) {
            target = b;
            break;
          }
        }
      }

      if (!target) {
        reply = "⚠️ Mình chưa biết bạn muốn tóm tắt quyển nào. Nói tên sách hoặc đặt câu như 'Tóm tắt Nhật ký trong tù' nhé.";
      } else {
        // call Gemini to produce a recap (try to use web if available)
        const recap = await askGeminiForRecap(target.name, target.author);
        if (recap && recap.recap) {
          reply = `📖 "${target.name}" (${target.author})\nThể loại: ${target.category || "Chưa rõ"}, Vị trí: ${target.position || "?"}\n\n📝 Tóm tắt:\n${recap.recap}`;
        } else {
          reply = `📖 "${target.name}" (${target.author})\nThể loại: ${target.category || "Chưa rõ"}, Vị trí: ${target.position || "?"}\n\n📝 Mình chưa tóm tắt được bằng web — nhưng đây là gợi ý: Sách này nói về ... (xin hãy yêu cầu tên sách rõ hơn để mình tóm tắt chi tiết).`;
        }
      }
    }

    // 5) general search by natural language
    else {
      // get books from DB
      const { rows: books } = await pool.query("SELECT name, author, category, position FROM books");
      if (!books || books.length === 0) {
        reply = "📭 Thư viện hiện chưa có sách.";
      } else {
        // prepare short conversation context (3 turns) to help Gemini pick
        const histRes = await pool.query("SELECT role, message FROM conversations ORDER BY id DESC LIMIT 6");
        const recent = histRes.rows.reverse().map(r => `${r.role === "user" ? "Người dùng" : "Trợ lý"}: ${r.message}`).join("\n");

        // First try to find direct DB matches by keywords (name/author/category)
        const keywords = message.toLowerCase();
        const directMatch = books.filter(b =>
          (b.name && b.name.toLowerCase().includes(keywords)) ||
          (b.author && b.author.toLowerCase().includes(keywords)) ||
          (b.category && b.category.toLowerCase().includes(keywords))
        );

        let chosen = null;
        if (directMatch.length === 1) {
          chosen = directMatch[0];
          reply = `📚 Gợi ý: "${chosen.name}" (${chosen.author})\nThể loại: ${chosen.category || "Chưa rõ"}, Vị trí: ${chosen.position || "?"}\n💡 Lý do: Tìm thấy khớp trực tiếp với yêu cầu của bạn.`;
        } else {
          // ask Gemini to pick best one from full list (or filtered list if directMatch non-empty)
          const poolForChoice = directMatch.length ? directMatch : books;
          const pick = await askGeminiToChoose(message, poolForChoice, recent);
          if (pick && pick.title) {
            // ensure values come from DB: find matching DB record by title+author
            const rec = poolForChoice.find(b =>
              b.name === pick.title && (pick.author ? b.author === pick.author : true)
            ) || poolForChoice.find(b => b.name === pick.title) || poolForChoice[0];

            const reason = pick.reason || "Mình nghĩ cuốn này phù hợp với yêu cầu của bạn.";
            reply = `📚 Gợi ý: "${rec.name}" (${rec.author})\nThể loại: ${rec.category || "Chưa rõ"}, Vị trí: ${rec.position || "?"}\n💡 Lý do: ${reason}`;
          } else {
            // fallback random/first best-effort
            const fallback = poolForChoice[0];
            reply = `📚 Gợi ý: "${fallback.name}" (${fallback.author})\nThể loại: ${fallback.category || "Chưa rõ"}, Vị trí: ${fallback.position || "?"}\n💡 Lý do: Mình chọn quyển này vì nó gần với nội dung bạn tìm.`;
          }
        }
      }
    }

    // save assistant reply
    await pool.query("INSERT INTO conversations (role, message) VALUES ($1, $2)", ["assistant", reply]);
    res.json({ reply });
  } catch (err) {
    console.error("❌ Chat error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ===== start server =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server đang chạy trên cổng ${PORT}`);
});
