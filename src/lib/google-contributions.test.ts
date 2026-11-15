import { describe, expect, it } from "vitest";
import { readSwgPurchase } from "./google-contributions";

describe("readSwgPurchase", () => {
  it("reads the order number and a dollar amount from Google's purchase data", () => {
    const raw = JSON.stringify({ orderId: "GPA.1234-5678-9012-34567", priceAmountMicros: "3000000", priceCurrencyCode: "USD" });
    expect(readSwgPurchase({ purchaseData: { raw } })).toEqual({ orderId: "GPA.1234-5678-9012-34567", amountUsd: 3 });
  });

  it("leaves the amount out in another currency, and survives junk", () => {
    const raw = JSON.stringify({ orderId: "GPA.1", priceAmountMicros: "5000000", priceCurrencyCode: "EUR" });
    expect(readSwgPurchase({ purchaseData: { raw } })).toEqual({ orderId: "GPA.1", amountUsd: null });
    expect(readSwgPurchase({ purchaseData: { raw: "not json" } })).toEqual({ orderId: null, amountUsd: null });
    expect(readSwgPurchase({})).toEqual({ orderId: null, amountUsd: null });
  });
});
