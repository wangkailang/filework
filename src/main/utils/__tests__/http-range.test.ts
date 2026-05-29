import { describe, expect, it } from "vitest";
import { parseRange } from "../http-range";

describe("parseRange", () => {
  const SIZE = 1000;

  it("bytes=a-b → 闭区间", () => {
    expect(parseRange("bytes=0-99", SIZE)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=200-999", SIZE)).toEqual({ start: 200, end: 999 });
  });

  it("bytes=a- → 到文件末尾", () => {
    expect(parseRange("bytes=100-", SIZE)).toEqual({ start: 100, end: 999 });
  });

  it("bytes=-N → 最后 N 字节", () => {
    expect(parseRange("bytes=-100", SIZE)).toEqual({ start: 900, end: 999 });
  });

  it("end 越界被 clamp 到 fileSize-1", () => {
    expect(parseRange("bytes=0-99999", SIZE)).toEqual({ start: 0, end: 999 });
  });

  it("后缀超过文件大小 → 从 0 开始", () => {
    expect(parseRange("bytes=-5000", SIZE)).toEqual({ start: 0, end: 999 });
  });

  it("单字节 bytes=0-0", () => {
    expect(parseRange("bytes=0-0", SIZE)).toEqual({ start: 0, end: 0 });
  });

  it("忽略首尾空白", () => {
    expect(parseRange("  bytes=0-9  ", SIZE)).toEqual({ start: 0, end: 9 });
  });

  it("不可满足 / 非法 → null", () => {
    expect(parseRange("bytes=1000-", SIZE)).toBeNull(); // start 越界
    expect(parseRange("bytes=500-100", SIZE)).toBeNull(); // 反向
    expect(parseRange("bytes=-0", SIZE)).toBeNull(); // 后缀 0
    expect(parseRange("bytes=-", SIZE)).toBeNull(); // 两端皆空
    expect(parseRange("bytes=abc", SIZE)).toBeNull(); // 非数字
    expect(parseRange("items=0-9", SIZE)).toBeNull(); // 单位非 bytes
    expect(parseRange("", SIZE)).toBeNull();
    expect(parseRange("bytes=0-9,20-29", SIZE)).toBeNull(); // 多段不支持
  });

  it("空文件:任何范围都不可满足", () => {
    expect(parseRange("bytes=0-", 0)).toBeNull();
    expect(parseRange("bytes=0-0", 0)).toBeNull();
  });
});
