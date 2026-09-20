FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

ENV PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    HF_HOME=/app/data/hf-cache

WORKDIR /app

COPY pyproject.toml README.md ./
# local-embed = torch + sentence-transformers. Linux 에서는 CPU 휠을 받는다(pyproject 참고).
RUN uv sync --no-dev --extra local-embed --no-install-project

COPY db ./db
COPY config ./config
COPY src ./src
RUN uv sync --no-dev --extra local-embed

ENV PATH="/app/.venv/bin:$PATH"

RUN useradd -m -u 10001 collector \
 && mkdir -p /app/data \
 && chown -R collector:collector /app
USER collector

CMD ["collector", "run", "--interval", "900"]
