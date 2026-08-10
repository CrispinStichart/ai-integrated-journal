FROM mcr.microsoft.com/playwright:v1.62.0-noble

ARG USERNAME=pwuser

RUN apt-get update \
    && apt-get install --yes --no-install-recommends sudo \
    && echo "${USERNAME} ALL=(root) NOPASSWD:ALL" > "/etc/sudoers.d/${USERNAME}" \
    && chmod 0440 "/etc/sudoers.d/${USERNAME}" \
    && rm -rf /var/lib/apt/lists/*

COPY bootstrap-workspace.sh /usr/local/bin/bootstrap-ai-journal-workspace

RUN chmod 0755 /usr/local/bin/bootstrap-ai-journal-workspace
