import { describe, expect, it } from "vitest";
import { normalizeGrvtSignature } from "../src/exchanges/grvt/gateway";

const TEST_CONTEXT = {
  expirationNs: BigInt(123_456_789),
  nonce: 42,
};

describe("normalizeGrvtSignature", () => {
  it("throws when signature provider returns nothing", () => {
    expect(() => normalizeGrvtSignature(undefined, TEST_CONTEXT)).toThrow(
      /未返回有效签名/
    );
    expect(() => normalizeGrvtSignature(null, TEST_CONTEXT)).toThrow(/未返回有效签名/);
  });

  it("throws when mandatory fields are missing", () => {
    expect(() =>
      normalizeGrvtSignature({ signer: "0xabc" }, TEST_CONTEXT)
    ).toThrow(/缺少 r 字段/);

    expect(() =>
      normalizeGrvtSignature(
        { signer: "0xabc", r: "0x1", s: "0x2" },
        TEST_CONTEXT
      )
    ).toThrow(/缺少有效的 v 字段/);
  });

  it("fills defaults and coerces types when possible", () => {
    const result = normalizeGrvtSignature(
      {
        signer: "0xabc",
        r: "0x1",
        s: "0x2",
        v: "27",
      },
      TEST_CONTEXT
    );

    expect(result).toEqual({
      signer: "0xabc",
      r: "0x1",
      s: "0x2",
      v: 27,
      expiration: TEST_CONTEXT.expirationNs.toString(),
      nonce: TEST_CONTEXT.nonce,
    });
  });
});
