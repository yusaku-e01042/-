// （任意）自分専用の株価中継サーバー — Cloudflare Workers（無料枠）用
// 公開の中継サービスが不安定なときに使います。
// デプロイ後、アプリの「設定 > 自前の中継URL」に
//   https://<あなたのworker名>.<アカウント>.workers.dev/?url=
// と入力してください。
const ALLOWED = /^https:\/\/query[12]\.finance\.yahoo\.com\/v8\/finance\/chart\//;

export default {
  async fetch(request) {
    const target = new URL(request.url).searchParams.get('url') || '';
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET' };
    if (!ALLOWED.test(target)) return new Response('forbidden', { status: 403, headers: cors });
    const r = await fetch(target, { headers: { 'User-Agent': 'Mozilla/5.0' }, cf: { cacheTtl: 10 } });
    return new Response(r.body, {
      status: r.status,
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'max-age=10' },
    });
  },
};
