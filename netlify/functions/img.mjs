// GET /img/<id> — public. Serves prize photos uploaded on /admin › Raffle › Prizes
// (stored in Netlify Blobs as { type, data: base64 } under "img/<id>").
import { store } from "../lib/store.mjs";

export default async (req) => {
  const id = new URL(req.url).pathname.split("/").pop() || "";
  if (!/^[a-f0-9-]{36}$/.test(id)) return new Response("Not found", { status: 404 });
  const img = await store().get("img/" + id, { type: "json" }).catch(() => null);
  if (!img?.data) return new Response("Not found", { status: 404 });
  return new Response(Buffer.from(img.data, "base64"), {
    headers: { "content-type": img.type || "image/jpeg", "cache-control": "public, max-age=31536000, immutable" },
  });
};

export const config = { path: "/img/:id" };
