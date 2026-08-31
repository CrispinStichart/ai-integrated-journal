FROM pgvector/pgvector:0.8.1-pg17-bookworm

RUN apt-get update \
  && apt-get upgrade --yes \
  && rm -rf /var/lib/apt/lists/*

COPY --chmod=0444 init/ /docker-entrypoint-initdb.d/
