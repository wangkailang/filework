/**
 * 测试夹具:现造一个最小但合法的多页 PDF。对象偏移由代码精确计算后写入 xref,
 * 避免手写偏移出错。对象编号:1=Catalog 2=Pages 3=Font,之后每页占两个对象
 *(page + content)。pdf-parse(基于 pdf.js)据此抽出每页文本流里的字符串。
 *
 * 文件名不含 `.test.`,故不会被 vitest 当作测试用例收集。
 */
export function makeMinimalPdf(pageTexts: string[]): Buffer {
  const n = pageTexts.length;
  const objs: string[] = [];
  objs[0] = "<</Type/Catalog/Pages 2 0 R>>";
  const kids = pageTexts.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  objs[1] = `<</Type/Pages/Kids[${kids}]/Count ${n}>>`;
  objs[2] = "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>";
  pageTexts.forEach((text, i) => {
    const pageNum = 4 + i * 2;
    const contentNum = 5 + i * 2;
    objs[pageNum - 1] =
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Contents ${contentNum} 0 R/Resources<</Font<</F1 3 0 R>>>>>>`;
    const stream = `BT /F1 24 Tf 36 100 Td (${text}) Tj ET`;
    objs[contentNum - 1] =
      `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`;
  });

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefStart = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}
