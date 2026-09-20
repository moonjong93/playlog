from collector.urlnorm import canonicalize, url_hash


def test_tracking_params_removed():
    assert canonicalize("https://example.com/foo?utm_source=rss&utm_medium=feed") == (
        "https://example.com/foo"
    )


def test_same_article_different_tracking_same_hash():
    a = "https://www.pcgamer.com/foo?utm_source=rss"
    b = "https://www.pcgamer.com/foo?fbclid=abc123"
    assert url_hash(a) == url_hash(b)


def test_fragment_and_trailing_slash_removed():
    assert canonicalize("https://example.com/foo/#section") == "https://example.com/foo"
    assert canonicalize("https://example.com/foo/") == "https://example.com/foo"
    assert canonicalize("https://example.com/") == "https://example.com/"


def test_query_sorted_and_kept():
    assert canonicalize("https://example.com/a?b=2&a=1") == "https://example.com/a?a=1&b=2"


def test_default_port_and_case_normalized():
    assert canonicalize("HTTPS://Example.COM:443/News") == "https://example.com/News"
    assert canonicalize("http://example.com:80/x") == "http://example.com/x"


def test_different_urls_are_different():
    assert url_hash("https://ign.com/a") != url_hash("https://pcgamer.com/a")


def test_empty_input():
    assert canonicalize("") == ""
