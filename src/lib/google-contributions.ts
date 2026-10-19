/* Google contributions (Reader Revenue Manager) on /support. Google's
   swg-basic.js draws the checkout; when a payment completes it hands the page
   the purchase, whose order number the page claims for the signed-in viewer
   (backend features/google-contributions.ts checks it later against the
   Publisher Center export). Off until the publication id is set. */

/* From Publisher Center, Reader Revenue Manager. Public: it is in the page. */
export const GOOGLE_RRM_PUBLICATION_ID = "";

const SWG_BASIC_SRC = "https://news.google.com/swg/js/v1/swg-basic.js";

interface SwgPurchase {
  orderId: string | null;
  amountUsd: number | null;
}

interface SubscribeResponse {
  purchaseData?: { raw?: string; data?: string };
  complete?: () => Promise<void>;
}

interface BasicSubscriptions {
  init(params: Record<string, unknown>): void;
  setOnPaymentResponse(callback: (response: Promise<SubscribeResponse>) => void): void;
}

declare global {
  interface Window {
    SWG_BASIC?: Array<(subscriptions: BasicSubscriptions) => void>;
  }
}

/* The order number and amount out of a purchase, as far as Google gives them:
   its purchase data is a JSON string in the Play billing shape. */
export function readSwgPurchase(response: SubscribeResponse): SwgPurchase {
  try {
    const raw = JSON.parse(response.purchaseData?.raw ?? response.purchaseData?.data ?? "{}") as Record<string, unknown>;
    const orderId = typeof raw.orderId === "string" ? raw.orderId : null;
    const micros = Number(raw.priceAmountMicros);
    const currency = typeof raw.priceCurrencyCode === "string" ? raw.priceCurrencyCode : "USD";
    return { orderId, amountUsd: Number.isFinite(micros) && micros > 0 && currency === "USD" ? micros / 1_000_000 : null };
  } catch {
    return { orderId: null, amountUsd: null };
  }
}

let started = false;
let listener: ((purchase: SwgPurchase) => void) | null = null;

/* Loads swg-basic.js once and reports every completed payment to the latest
   caller (the checkout that is on screen). */
export function startGoogleContributions(onPurchase: (purchase: SwgPurchase) => void, lang: string): void {
  if (!GOOGLE_RRM_PUBLICATION_ID) return;
  listener = onPurchase;
  if (started) return;
  started = true;
  (window.SWG_BASIC ??= []).push((subscriptions) => {
    subscriptions.init({
      type: "NewsArticle",
      isAccessibleForFree: true,
      isPartOfType: ["Product"],
      isPartOfProductId: `${GOOGLE_RRM_PUBLICATION_ID}:openaccess`,
      autoPromptType: "none",
      clientOptions: { theme: "dark", lang },
    });
    subscriptions.setOnPaymentResponse((pending) => {
      void pending.then((response) => {
        listener?.(readSwgPurchase(response));
        return response.complete?.();
      }).catch(() => {});
    });
  });
  const script = document.createElement("script");
  script.src = SWG_BASIC_SRC;
  script.async = true;
  document.head.appendChild(script);
}
