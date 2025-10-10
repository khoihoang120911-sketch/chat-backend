// Map thể loại sang chữ cái
const categoryMap = {
  "Lịch sử": "L",
  "Tâm lý": "T",
  "Văn học": "V",
  "Khoa học": "K",
  "Triết học": "P",
  "Kinh tế": "E",
  "Chính trị": "C",
  "Khác": "X"
};

// Hàm tính vị trí
function assignPosition(book) {
  const prefix = categoryMap[book["Thể loại"]] || "X";
  const sameCategory = books.filter(b => b["Thể loại"] === book["Thể loại"]);
  const index = sameCategory.length;
  const shelf = Math.floor(index / 15) + 1;
  return `${prefix}${shelf}`;
}

// Endpoint chat
app.post("/chat", async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "Thiếu field 'message' trong body" });

  try {
    // --- THÊM SÁCH ---
    if (message.toLowerCase().startsWith("add book")) {
      const match = message.match(/bn:\s*(.+?); at:\s*(.+)$/i);
      if (!match) return res.json({ reply: "❌ Sai cú pháp. Hãy dùng: add book: bn: Tên; at: Tác giả" });

      const title = match[1].trim();
      const author = match[2].trim();

      // Hỏi Gemini thể loại
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: `Hãy cho biết thể loại (1 từ ngắn gọn như Lịch sử, Văn học, Khoa học, Tâm lý,...) cho quyển sách "${title}" của tác giả "${author}".`
      });

      const category = response?.text?.trim() || "Khác";

      const newBook = {
        "Tên sách": title,
        "Tác giả": author,
        "Thể loại": category,
        "Vị trí": "", // sẽ tính
        "Tóm tắt": "Chưa có"
      };
      newBook["Vị trí"] = assignPosition(newBook);

      books.push(newBook);
      XLSX.utils.sheet_add_json(sheet, [newBook], { skipHeader: true, origin: -1 });
      XLSX.writeFile(workbook, excelPath);

      return res.json({ reply: `✅ Đã thêm sách:\n${JSON.stringify(newBook, null, 2)}` });
    }

    // --- XÓA SÁCH ---
    if (message.toLowerCase().startsWith("remove book")) {
      const match = message.match(/bn:\s*(.+?); at:\s*(.+)$/i);
      if (!match) return res.json({ reply: "❌ Sai cú pháp. Hãy dùng: remove book: bn: Tên; at: Tác giả" });

      const title = match[1].trim();
      const author = match[2].trim();

      const index = books.findIndex(b => b["Tên sách"] === title && b["Tác giả"] === author);
      if (index === -1) return res.json({ reply: "❌ Không tìm thấy sách để xóa." });

      const removed = books.splice(index, 1)[0];
      const newSheet = XLSX.utils.json_to_sheet(books);
      workbook.Sheets[workbook.SheetNames[0]] = newSheet;
      XLSX.writeFile(workbook, excelPath);

      return res.json({ reply: `🗑️ Đã xóa sách: ${removed["Tên sách"]} - ${removed["Tác giả"]}` });
    }

    // --- TÌM SÁCH ---
    const libraryText = books.map(b =>
      `Tên: ${b["Tên sách"]}, Tác giả: ${b["Tác giả"]}, Thể loại: ${b["Thể loại"]}, Vị trí: ${b["Vị trí"]}, Tóm tắt: ${b["Tóm tắt"]}`
    ).join("\n");

    const prompt = `
    Người dùng mô tả tình trạng hoặc mong muốn: "${message}".
    Đây là danh sách sách trong thư viện:
    ${libraryText}

    Nhiệm vụ:
    - Chọn **chính xác 1 quyển sách** phù hợp nhất.
    - Trả về:
      Tên sách: ...
      Tác giả: ...
      Vị trí: ...
      Recap: ... (tối đa 3 câu)
    - Nếu không có sách phù hợp, trả lời: "Xin lỗi, hiện không tìm thấy sách nào phù hợp".
    `;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt
    });

    const reply = response?.text?.trim() || "Không có phản hồi.";
    res.json({ reply });

  } catch (err) {
    console.error("Gemini error:", err);
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});
