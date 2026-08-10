import { createHash } from "node:crypto";
import { isIP } from "node:net";
import {
  normalizeText,
  normalizeUrl
} from "./learningFeedService.js";

const EXA_CONTENTS_URL = "https://api.exa.ai/contents";
const EXA_SEARCH_URL = "https://api.exa.ai/search";
const ARTICLE_READER_URL = "https://r.jina.ai/";
const ARTICLE_MAX_CHARACTERS = Number(
  process.env.ARTICLE_MAX_CHARS || 100_000
);
const ARTICLE_IMAGE_LIMIT = Number(process.env.ARTICLE_IMAGE_LIMIT || 12);
const ARTICLE_LINK_LIMIT = Number(process.env.ARTICLE_LINK_LIMIT || 50);

const IGNORED_IMAGE_PATTERN =
  /(?:^|[\/_.-])(avatar|badge|banner|brand|emoji|favicon|icon|logo|profile|sprite|tracking|pixel|advert|author)(?:[\/_.-]|$)/i;
const IGNORED_IMAGE_ALT_PATTERN =
  /\b(avatar|badge|banner|brand|emoji|favicon|icon|logo|profile|tracking|pixel|advert|author)\b/i;
const IMAGE_FILE_PATTERN = /\.(?:avif|gif|jpe?g|png|svg|webp)(?:$|[?#])/i;
const IMAGE_HOST_PATTERN = /(?:^|\.)(?:images?|img|miro|media|static|assets?|cdn)\./i;
const VIDEO_FILE_PATTERN = /\.(?:mp4|mpeg|mov|avi|webm|wmv)(?:$|[?#])/i;

function createHttpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function isPrivateIpv4(hostname) {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((value) => !Number.isInteger(value))) {
    return false;
  }
  return (
    parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
  );
}

export function validatePublicArticleUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw createHttpError("Enter a valid article URL", 400);
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw createHttpError("Only HTTP and HTTPS article URLs are supported", 400);
  }

  const hostname = url.hostname.toLowerCase();
  const ipVersion = isIP(hostname);
  const isPrivateHost = (
    hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname === "::1"
    || (ipVersion === 4 && isPrivateIpv4(hostname))
    || (ipVersion === 6 && (
      hostname.startsWith("fc")
      || hostname.startsWith("fd")
      || hostname.startsWith("fe80:")
    ))
  );
  if (isPrivateHost) {
    throw createHttpError("Private-network URLs are not supported", 400);
  }

  return normalizeUrl(url.toString());
}

async function fetchExaJson(url, body, apiKey, fetchImpl) {
  if (!apiKey) {
    throw createHttpError("EXA_API_KEY is required", 500);
  }

  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000)
    });
  } catch {
    throw createHttpError("Article service is unavailable", 502);
  }

  if (!response.ok) {
    throw createHttpError("Article service could not process the request", 502);
  }
  return response.json();
}

function sourceName(value) {
  return new URL(value).hostname.replace(/^www\./, "");
}

function isLikelyImageUrl(value) {
  const url = new URL(value);
  return (
    IMAGE_FILE_PATTERN.test(url.toString())
    || IMAGE_HOST_PATTERN.test(url.hostname)
    || /\/(?:image|images|img)\//i.test(url.pathname)
  );
}

function bestArticleTitle(title, content, canonicalUrl) {
  const hostname = new URL(canonicalUrl).hostname
    .replace(/^www\./, "")
    .split(".")[0];
  const generic = new Set(["article", "home", "medium", "substack", "untitled"]);
  if (title && !generic.has(title.toLowerCase()) && title.toLowerCase() !== hostname) {
    return title;
  }

  const mediumHeading = content.match(/#\s+(.{8,200}?)\s+\d+\s+min read\b/i)?.[1];
  if (mediumHeading) return normalizeText(mediumHeading, 500);

  const slug = new URL(canonicalUrl).pathname.split("/").filter(Boolean).at(-1) || "";
  const withoutId = slug.replace(/-[a-f0-9]{10,}$/i, "");
  const fallback = withoutId
    .split("-")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
  return normalizeText(fallback || title || sourceName(canonicalUrl), 500);
}

function decodeXml(value) {
  return value
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .trim();
}

async function mediumRssMetadata(canonicalUrl, fetchImpl) {
  const url = new URL(canonicalUrl);
  if (url.hostname !== "medium.com" && !url.hostname.endsWith(".medium.com")) {
    return null;
  }
  const author = url.pathname.split("/").filter(Boolean)
    .find((part) => part.startsWith("@"));
  const postId = url.pathname.match(/-([a-f0-9]{12})$/i)?.[1];
  if (!author || !postId) return null;

  try {
    const response = await fetchImpl(`https://medium.com/feed/${author}`, {
      headers: { "User-Agent": "GenRadar/1.0" },
      signal: AbortSignal.timeout(20_000)
    });
    if (!response.ok || typeof response.text !== "function") return null;
    const xml = await response.text();
    const items = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];
    const item = items.find((entry) => entry.includes(postId));
    if (!item) return null;

    const title = decodeXml(
      item.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || ""
    );
    const encoded = item.match(
      /<content:encoded>([\s\S]*?)<\/content:encoded>/i
    )?.[1] || "";
    const imageUrls = [...encoded.matchAll(
      /<img\b[^>]*\bsrc=["']([^"']+)["']/gi
    )].map((match) => decodeXml(match[1]));
    return { title, imageUrls };
  } catch {
    return null;
  }
}

async function readerImageMetadata(canonicalUrl, fetchImpl) {
  try {
    const response = await fetchImpl(`${ARTICLE_READER_URL}${canonicalUrl}`, {
      headers: {
        Accept: "text/markdown",
        "User-Agent": "GenRadar/1.0"
      },
      signal: AbortSignal.timeout(45_000)
    });
    if (!response.ok || typeof response.text !== "function") return null;

    const markdown = await response.text();
    const images = [...markdown.matchAll(
      /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)(?:\s+["'][^)]*["'])?\)/gi
    )].flatMap((match) => {
      const alt = normalizeText(match[1] || "", 300);
      if (IGNORED_IMAGE_ALT_PATTERN.test(alt)) return [];
      return [match[2]];
    });
    return { imageUrls: images };
  } catch {
    return null;
  }
}

function publicUrls(values) {
  return [...new Set((values || []).flatMap((value) => {
    try {
      return [validatePublicArticleUrl(value)];
    } catch {
      return [];
    }
  }))];
}

function usefulImageUrls(values) {
  return publicUrls(values).filter((url) => (
    isLikelyImageUrl(url)
    && !IGNORED_IMAGE_PATTERN.test(new URL(url).pathname)
  ));
}

function isSupportedVideoUrl(value) {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  return (
    hostname === "youtu.be"
    || hostname === "youtube.com"
    || hostname.endsWith(".youtube.com")
    || VIDEO_FILE_PATTERN.test(url.toString())
  );
}

export function createExaService({
  apiKey = process.env.EXA_API_KEY,
  fetchImpl = fetch
} = {}) {
  return {
    async extractArticle(value) {
      const canonicalUrl = validatePublicArticleUrl(value);
      const payload = await fetchExaJson(
        EXA_CONTENTS_URL,
        {
          urls: [canonicalUrl],
          text: { maxCharacters: ARTICLE_MAX_CHARACTERS },
          extras: {
            imageLinks: ARTICLE_IMAGE_LIMIT,
            links: ARTICLE_LINK_LIMIT
          }
        },
        apiKey,
        fetchImpl
      );
      const result = payload.results?.[0];
      const content = normalizeText(
        result?.text || "",
        ARTICLE_MAX_CHARACTERS
      );
      const mediumMetadata = await mediumRssMetadata(canonicalUrl, fetchImpl);
      const extractedTitle = normalizeText(result?.title || "", 500);
      const title = normalizeText(
        mediumMetadata?.title
        || bestArticleTitle(extractedTitle, content, canonicalUrl),
        500
      );
      const imageUrls = usefulImageUrls(
        mediumMetadata?.imageUrls?.length
          ? mediumMetadata.imageUrls
          : result?.extras?.imageLinks || result?.extras?.images || []
      );
      const videoUrls = publicUrls(result?.extras?.links || [])
        .filter(isSupportedVideoUrl);

      if (!result || !title || content.length < 200) {
        throw createHttpError(
          "The article did not contain enough readable content",
          422
        );
      }

      return {
        canonicalUrl,
        title,
        sourceName: sourceName(canonicalUrl),
        content,
        contentHash: createHash("sha256").update(content).digest("hex"),
        contentTruncated: content.length >= ARTICLE_MAX_CHARACTERS,
        extractionMethod: "exa-contents",
        imageUrls: imageUrls.slice(0, ARTICLE_IMAGE_LIMIT),
        videoUrls: videoUrls.slice(0, 3)
      };
    },

    async discoverArticleMedia(value) {
      const canonicalUrl = validatePublicArticleUrl(value);
      const mediumMetadata = await mediumRssMetadata(canonicalUrl, fetchImpl);
      const readerMetadata = mediumMetadata?.imageUrls?.length
        ? null
        : await readerImageMetadata(canonicalUrl, fetchImpl);
      return {
        imageUrls: usefulImageUrls(
          mediumMetadata?.imageUrls?.length
            ? mediumMetadata.imageUrls
            : readerMetadata?.imageUrls || []
        ).slice(0, ARTICLE_IMAGE_LIMIT),
        videoUrls: []
      };
    },

    async search(query) {
      const payload = await fetchExaJson(
        EXA_SEARCH_URL,
        {
          query,
          type: "auto",
          numResults: 5,
          contents: {
            text: { maxCharacters: 5_000 },
            highlights: { query, maxCharacters: 1_500 }
          }
        },
        apiKey,
        fetchImpl
      );

      return (payload.results || []).flatMap((result, index) => {
        const url = result.url ? validatePublicArticleUrl(result.url) : "";
        const excerpt = normalizeText(
          Array.isArray(result.highlights)
            ? result.highlights.join(" ")
            : result.text || "",
          2_500
        );
        if (!url || !excerpt) return [];
        return [{
          id: `web-${index + 1}`,
          title: normalizeText(result.title || sourceName(url), 500),
          url,
          excerpt,
          sourceType: "web"
        }];
      });
    }
  };
}
