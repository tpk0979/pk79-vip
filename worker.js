/**
 * worker.js — Cloudflare Worker proxy cho PK79 VIP
 * -----------------------------------------------------------------
 * Bản thay thế proxy.php để chạy trên Cloudflare (miễn phí), dùng khi
 * frontend host trên GitHub Pages (không hỗ trợ PHP).
 *
 * Cách dùng (từ JS phía client):
 *   https://<ten-worker>.<username>.workers.dev/?url=<encoded target url>&ua=<encoded user-agent>&ref=<encoded referer>
 *
 * Deploy:
 *  1. Vào https://dash.cloudflare.com -> Workers & Pages -> Create -> Create Worker
 *  2. Đặt tên worker (vd: pk79-proxy) -> Deploy
 *  3. Vào Edit code, xoá hết code mẫu, dán toàn bộ nội dung file này vào -> Save and Deploy
 *  4. Copy URL worker (dạng https://pk79-proxy.<username>.workers.dev)
 *  5. Dán URL đó vào biến PROXY_BASE_URL trong index.html
 */

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export default {
  async fetch(request) {
    const reqUrl = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    const targetUrl = reqUrl.searchParams.get('url') || '';
    const userAgent = reqUrl.searchParams.get('ua') || DEFAULT_UA;
    const referer = reqUrl.searchParams.get('ref') || '';

    if (!/^https?:\/\//i.test(targetUrl)) {
      return new Response('Thiếu hoặc sai tham số "url" (phải bắt đầu bằng http:// hoặc https://).', {
        status: 400,
        headers: corsHeaders(),
      });
    }

    const isPlaylistUrl = /\.m3u8?(\?|#|$)/i.test(targetUrl);
    const isMpdUrl = /\.mpd(\?|#|$)/i.test(targetUrl);

    const upstreamHeaders = { 'User-Agent': userAgent, 'Accept': '*/*' };
    if (referer) upstreamHeaders['Referer'] = referer;

    // Chuyển tiếp Range header của client để hỗ trợ tua/seek
    const clientRange = request.headers.get('Range');
    if (clientRange) upstreamHeaders['Range'] = clientRange;

    let upstreamResponse;
    try {
      upstreamResponse = await fetch(targetUrl, { headers: upstreamHeaders, redirect: 'follow' });
    } catch (e) {
      return new Response('Không kết nối được tới nguồn phát: ' + e.message, {
        status: 502,
        headers: corsHeaders(),
      });
    }

    if (!upstreamResponse.ok && upstreamResponse.status !== 206) {
      return new Response('Nguồn gốc trả lỗi HTTP ' + upstreamResponse.status, {
        status: upstreamResponse.status,
        headers: corsHeaders(),
      });
    }

    // --- Playlist HLS: tải nguyên văn, rewrite URL bên trong rồi trả về ---
    if (isPlaylistUrl) {
      const body = await upstreamResponse.text();
      const looksLikePlaylist = body.includes('#EXTM3U') || body.toUpperCase().includes('#EXTINF');

      if (!looksLikePlaylist) {
        return new Response(body, {
          status: upstreamResponse.status,
          headers: { ...corsHeaders(), 'Content-Type': 'application/octet-stream' },
        });
      }

      const finalUrl = upstreamResponse.url || targetUrl; // URL sau khi đã theo redirect
      const rewritten = rewritePlaylist(body, finalUrl, userAgent, referer, reqUrl.origin + reqUrl.pathname);

      return new Response(rewritten, {
        status: upstreamResponse.status,
        headers: {
          ...corsHeaders(),
          'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
          'Cache-Control': 'no-cache',
        },
      });
    }

    // --- DASH manifest (.mpd): chỉ chuẩn hoá <BaseURL> thành URL tuyệt đối trỏ
    // thẳng về CDN gốc (KHÔNG proxy hoá từng segment — tránh tốn băng thông
    // Worker cho luồng live, và tránh sai đường dẫn tương đối) ---
    if (isMpdUrl) {
      const body = await upstreamResponse.text();
      const looksLikeMpd = /<MPD\b/i.test(body);

      if (!looksLikeMpd) {
        return new Response(body, {
          status: upstreamResponse.status,
          headers: { ...corsHeaders(), 'Content-Type': 'application/octet-stream' },
        });
      }

      const finalUrl = upstreamResponse.url || targetUrl;
      const rewrittenMpd = rewriteMpd(body, finalUrl);

      return new Response(rewrittenMpd, {
        status: upstreamResponse.status,
        headers: {
          ...corsHeaders(),
          'Content-Type': 'application/dash+xml; charset=utf-8',
          'Cache-Control': 'no-cache',
        },
      });
    }

    // --- Mọi thứ khác (segment .ts, .flv, .mp4, .aac, luồng raw...) -> stream passthrough ---
    const headers = new Headers(corsHeaders());
    const passthroughHeaderNames = ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges'];
    for (const name of passthroughHeaderNames) {
      const val = upstreamResponse.headers.get(name);
      if (val) headers.set(name, val);
    }
    headers.set('Cache-Control', 'no-cache');

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers,
    });
  },
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Content-Type',
  };
}

function resolveUrl(base, rel) {
  rel = (rel || '').trim();
  if (!rel) return rel;
  try {
    return new URL(rel, base).href;
  } catch (e) {
    return rel;
  }
}

function proxify(absoluteUrl, workerBase, userAgent, referer) {
  let q = 'url=' + encodeURIComponent(absoluteUrl);
  if (userAgent) q += '&ua=' + encodeURIComponent(userAgent);
  if (referer) q += '&ref=' + encodeURIComponent(referer);
  return workerBase + '?' + q;
}

function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function rewriteMpd(body, baseUrl) {
  const mpdDir = baseUrl.replace(/\/[^/]*$/, '/');

  if (/<BaseURL>(.*?)<\/BaseURL>/is.test(body)) {
    // Đã có BaseURL -> chuẩn hoá thành tuyệt đối
    return body.replace(/<BaseURL>(.*?)<\/BaseURL>/gis, (match, inner) => {
      const abs = resolveUrl(baseUrl, inner.trim());
      return '<BaseURL>' + escapeXml(abs) + '</BaseURL>';
    });
  }

  // Không có BaseURL -> chèn ngay sau thẻ <MPD ...> để segment tương đối
  // tính đúng theo thư mục gốc CDN thật, thay vì theo URL của worker
  return body.replace(/(<MPD\b[^>]*>)/i, '$1\n<BaseURL>' + escapeXml(mpdDir) + '</BaseURL>');
}

function rewritePlaylist(body, baseUrl, userAgent, referer, workerBase) {
  const lines = body.split(/\r\n|\r|\n/);
  const out = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') { out.push(rawLine); continue; }

    if (line[0] === '#') {
      const uriMatch = line.match(/URI="([^"]+)"/i);
      if (uriMatch) {
        const abs = resolveUrl(baseUrl, uriMatch[1]);
        const newUri = proxify(abs, workerBase, userAgent, referer);
        out.push(line.replace(uriMatch[0], 'URI="' + newUri + '"'));
      } else {
        out.push(line);
      }
    } else {
      const abs = resolveUrl(baseUrl, line);
      out.push(proxify(abs, workerBase, userAgent, referer));
    }
  }

  return out.join('\n');
}
