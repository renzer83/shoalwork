FROM python:3.13-slim
COPY --from=ghcr.io/astral-sh/uv:0.13.1 /uv /uvx /bin/
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
WORKDIR /app
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync --frozen --no-install-project --no-dev
COPY . /app
RUN --mount=type=cache,target=/root/.cache/uv uv sync --locked --no-dev
# Non-root at runtime. The venv binary is run directly: `uv run` would need a cache under the user's home.
RUN groupadd --system --gid 10001 voice && useradd --system --uid 10001 --gid voice --no-create-home voice
ENV KOKORO_DIR=/models/kokoro
USER voice
EXPOSE 28922
CMD ["/app/.venv/bin/uvicorn", "tts_server:app", "--host", "0.0.0.0", "--port", "28922"]
