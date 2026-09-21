import {
  SITE_ALTERNATE_NAME,
  SITE_DESCRIPTION,
  SITE_NAME,
  absoluteUrl,
} from "./site.ts";

export function organizationJsonLd(origin: string) {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: SITE_NAME,
    alternateName: SITE_ALTERNATE_NAME,
    url: absoluteUrl("/", origin),
    description: SITE_DESCRIPTION,
    logo: {
      "@type": "ImageObject",
      url: absoluteUrl("/assets/icon-512.png", origin),
      width: 512,
      height: 512,
    },
  };
}

export function websiteJsonLd(origin: string) {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: SITE_NAME,
    alternateName: SITE_ALTERNATE_NAME,
    url: absoluteUrl("/", origin),
    inLanguage: "ko",
    potentialAction: {
      "@type": "SearchAction",
      target: {
        "@type": "EntryPoint",
        urlTemplate: `${absoluteUrl("/search", origin)}?q={search_term_string}`,
      },
      "query-input": "required name=search_term_string",
    },
  };
}

export function newsArticleJsonLd(options: {
  origin: string;
  slug: string;
  title: string;
  description: string;
  image: string;
  publishedAt: string;
  updatedAt: string;
  tags: string[];
  commentCount: number;
}) {
  const url = absoluteUrl(`/s/${encodeURIComponent(options.slug)}`, options.origin);
  return {
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    url,
    headline: options.title,
    description: options.description,
    image: [absoluteUrl(options.image, options.origin)],
    datePublished: options.publishedAt,
    dateModified: options.updatedAt || options.publishedAt,
    inLanguage: "ko",
    author: { "@type": "Organization", name: SITE_NAME, url: absoluteUrl("/", options.origin) },
    publisher: {
      "@type": "Organization",
      name: SITE_NAME,
      logo: {
        "@type": "ImageObject",
        url: absoluteUrl("/assets/icon-512.png", options.origin),
        width: 512,
        height: 512,
      },
    },
    ...(options.tags.length > 0
      ? { articleSection: options.tags[0], keywords: options.tags.join(", ") }
      : {}),
    isAccessibleForFree: true,
    commentCount: options.commentCount,
  };
}

export function itemListJsonLd(options: {
  origin: string;
  name: string;
  items: { slug: string; title: string }[];
}) {
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: options.name,
    itemListElement: options.items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      url: absoluteUrl(`/s/${encodeURIComponent(item.slug)}`, options.origin),
      name: item.title,
    })),
  };
}
