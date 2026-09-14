// 临时校验：验证 collapsePathSegments 的折叠结果（用完即删）
import { collapsePathSegments } from "../src/utils/path.ts";

const cases = [
  ["C:/root/B/../A/Attachment/x.png", "C:/root/A/Attachment/x.png"],
  ["C:\\root\\B\\..\\A\\x.png", "C:/root/A/x.png"],
  ["../A/Attachment/x.png", "../A/Attachment/x.png"],
  ["C:/root/./A/x.png", "C:/root/A/x.png"],
  ["C:/a/../../b.png", "C:/b.png"],
  ["C:/..", "C:"],
  ["C:/x.png", "C:/x.png"],
  ["/home/u/stuff/../secret.txt", "/home/u/secret.txt"],
  ["/../a/b.png", "/a/b.png"],
  ["../../x.png", "../../x.png"],
  ["D:/notes/A/../B/x.png", "D:/notes/B/x.png"],
  ["", ""],
];

let failed = 0;
for (const [input, expected] of cases) {
  const got = collapsePathSegments(input);
  const ok = got === expected;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${JSON.stringify(input)} -> ${JSON.stringify(got)}${ok ? "" : ` expected ${JSON.stringify(expected)}`}`);
}
console.log(failed ? `FAILED ${failed}/${cases.length}` : `ALL PASS (${cases.length})`);
process.exit(failed ? 1 : 0);
