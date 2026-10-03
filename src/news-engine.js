const CACHE_TTL_MS = 3 * 60 * 1000;
const MAX_CACHE_ENTRIES = 80;

function decodeEntities(value = "") {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
}

function tag(block, name) {
  const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i"));
  return decodeEntities(match?.[1] || "");
}

function attribute(block, pattern, attributeName = "url") {
  const element = block.match(pattern)?.[0] || "";
  return decodeEntities(element.match(new RegExp(`${attributeName}=["']([^"']+)`, "i"))?.[1] || "");
}

function imageFromDescription(description) {
  return decodeEntities(description).match(/<img[^>]+src=["']([^"']+)/i)?.[1] || "";
}

export function parseRss(xml, fallbackSource = "") {
  return [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map((match) => {
    const block = match[0];
    const description = tag(block, "description");
    return {
      title: tag(block, "title"),
      link: tag(block, "link") || attribute(block, /<link\b[^>]*href=["'][^"']+["'][^>]*>/i, "href"),
      pubDate: tag(block, "pubDate") || tag(block, "published"),
      author: tag(block, "source") || fallbackSource,
      image: attribute(block, /<(?:media:content|media:thumbnail|enclosure|News:Image)\b[^>]*(?:url|href)=["'][^"']+["'][^>]*>/i) || imageFromDescription(description)
    };
  }).filter((item) => item.title && item.link);
}

function titleKey(title) {
  return title.toLocaleLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "").slice(0, 220);
}

async function fetchText(url, timeoutMs = 8_000) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "user-agent": "Soundlane-WindowHost/1.0 (+https://p01--soundlane-bot--xz6744xjl6hb.code.run/window/)" }
  });
  if (!response.ok) throw new Error(`News source returned ${response.status}`);
  return await response.text();
}

async function discoverImage(item) {
  if (item.image || !/^https?:/i.test(item.link)) return item;
  try {
    const html = await fetchText(item.link, 5_000);
    const image = html.match(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)/i)?.[1] ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|twitter:image)["']/i)?.[1] || "";
    return { ...item, image: decodeEntities(image) };
  } catch {
    return item;
  }
}

export class NewsEngine {
  constructor() {
    this.cache = new Map();
  }

  async search(query, language = "pt-BR", limit = 24) {
    const normalized = query.trim().slice(0, 180);
    const cacheKey = `${language}:${normalized.toLocaleLowerCase()}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.items.slice(0, limit);

    const locale = {
      "pt-BR": { hl: "pt-BR", gl: "BR", ceid: "BR:pt-419", bing: "pt-br" },
      en: { hl: "en-US", gl: "US", ceid: "US:en", bing: "en-us" },
      fr: { hl: "fr", gl: "FR", ceid: "FR:fr", bing: "fr-fr" },
      es: { hl: "es", gl: "ES", ceid: "ES:es", bing: "es-es" },
      it: { hl: "it", gl: "IT", ceid: "IT:it", bing: "it-it" },
      de: { hl: "de", gl: "DE", ceid: "DE:de", bing: "de-de" }
    }[language] || { hl: "en-US", gl: "US", ceid: "US:en", bing: "en-us" };
    const encoded = encodeURIComponent(normalized);
    const sources = [
      { name: "Google News", url: `https://news.google.com/rss/search?q=${encoded}&hl=${locale.hl}&gl=${locale.gl}&ceid=${locale.ceid}` },
      { name: "Bing News", url: `https://www.bing.com/news/search?q=${encoded}&format=rss&setlang=${locale.bing}` }
    ];
    const responses = await Promise.allSettled(sources.map(async (source) =>
      parseRss(await fetchText(source.url), source.name)));
    const unique = new Map();
    for (const item of responses.flatMap((result) => result.status === "fulfilled" ? result.value : [])) {
      const key = titleKey(item.title);
      if (key && !unique.has(key)) unique.set(key, item);
    }
    const sorted = [...unique.values()].sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));
    const enriched = await Promise.all(sorted.slice(0, Math.max(limit, 18)).map(discoverImage));
    this.cache.set(cacheKey, { at: Date.now(), items: enriched });
    if (this.cache.size > MAX_CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value);
    return enriched.slice(0, limit);
  }
}
