const fs = require("fs");

const input = "smart_aquarium_for_railway.sql";
const output = "smart_aquarium_for_railway_fixed.sql";

let sql = fs.readFileSync(input, "utf8");

// Railway MySQL không hỗ trợ collation mới của MariaDB 12.2
sql = sql.replaceAll("utf8mb4_uca1400_ai_ci", "utf8mb4_unicode_ci");
sql = sql.replaceAll("utf8mb4_uca1400_as_ci", "utf8mb4_unicode_ci");

// Xóa các FOREIGN KEY constraint để tránh lỗi trùng tên constraint như CONSTRAINT `1`
sql = sql.replace(
  /,\r?\n\s*CONSTRAINT\s+`[^`]+`\s+FOREIGN KEY\s+\([^\r\n]+\)\s+REFERENCES\s+[^\r\n]+/g,
  ""
);

sql = sql.replace(
  /\r?\n\s*CONSTRAINT\s+`[^`]+`\s+FOREIGN KEY\s+\([^\r\n]+\)\s+REFERENCES\s+[^\r\n]+,?/g,
  ""
);

sql = sql.replace(
  /ALTER TABLE\s+`[^`]+`\s+ADD CONSTRAINT\s+`[^`]+`\s+FOREIGN KEY[\s\S]*?;\r?\n/g,
  ""
);

fs.writeFileSync(output, sql, "utf8");

console.log(`Done. Created ${output}`);